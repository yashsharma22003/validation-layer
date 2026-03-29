/**
 * Validation Router
 *
 * The Router is an off-chain service that acts as the `validatorAddress`
 * in every ERC-8004 validationRequest().
 *
 * Lifecycle per request:
 *  1. Listen for `ValidationRequest` events targeted at ROUTER_ADDRESS
 *  2. Fetch JSON payload from requestURI
 *  3. Verify keccak256(payload) === requestHash  (payload integrity)
 *  4. Run sybil checks against the agent
 *  5. Read mandate.core.kind → dispatch to all matching IVerifiers
 *  6. Aggregate scores:  finalScore = Math.round(mean(verifierScores))
 *  7. Persist response JSON → get responseURI + responseHash
 *  8. Call validationResponse(requestHash, finalScore, responseURI, responseHash, tag)
 *
 * Adding a new verifier:
 *   1. Create src/verifiers/<name>.ts implementing IVerifier
 *   2. Register it in the Router constructor via registerVerifier()
 *   3. Set supportedKinds to the primitives it handles (or ["*"] for all)
 */

import "dotenv/config";
import axios from "axios";
import { ethers } from "ethers";
import { RegistryClient } from "../registry/client";
import { ResponseStore } from "../store/responseStore";
import { SybilGuard } from "../sybil/guard";
import { MandateIntegrityVerifier } from "../verifiers/mandateIntegrity";
import { SwapReceiptVerifier } from "../verifiers/swapReceipt";
import { IVerifier, ValidationResponsePayload, VerifierResult } from "../types/verifier";
import { ValidationRequestPayload } from "../types/mandate";

export class Router {
  private readonly client: RegistryClient;
  private readonly store: ResponseStore;
  private readonly sybilGuard: SybilGuard;
  private readonly verifiers: IVerifier[] = [];

  /** Poll interval for event watching (ms) */
  private readonly pollIntervalMs: number;

  constructor(options?: { pollIntervalMs?: number }) {
    this.client = new RegistryClient();
    this.store = new ResponseStore();
    this.sybilGuard = new SybilGuard();
    this.pollIntervalMs = options?.pollIntervalMs ?? 12_000; // ~1 block

    // Register built-in verifiers
    this.registerVerifier(new MandateIntegrityVerifier());
    this.registerVerifier(new SwapReceiptVerifier());
  }

  /**
   * Register a verifier.  Call before start() to add custom verifiers.
   * Verifiers are invoked in registration order.
   */
  registerVerifier(verifier: IVerifier): void {
    this.verifiers.push(verifier);
    console.log(`[Router] Registered verifier: ${verifier.id} (kinds: ${verifier.supportedKinds.join(", ")})`);
  }

  /** Start polling for ValidationRequest events */
  async start(): Promise<void> {
    console.log(`[Router] Starting. Router address: ${this.client.routerAddress}`);
    console.log(`[Router] Polling every ${this.pollIntervalMs / 1000}s`);

    let lastBlock = (await this.client.getCurrentBlock()) - 1;

    const poll = async () => {
      try {
        const currentBlock = await this.client.getCurrentBlock();
        if (currentBlock <= lastBlock) return;

        const filter = this.client.validationRegistry.filters.ValidationRequest(
          this.client.routerAddress
        );
        const events = await this.client.validationRegistry.queryFilter(
          filter,
          lastBlock + 1,
          currentBlock
        );

        for (const event of events) {
          if (!("args" in event) || !event.args) continue;
          const [validatorAddress, agentId, requestURI, requestHash] = event.args;
          if (validatorAddress.toLowerCase() !== this.client.routerAddress.toLowerCase()) {
            continue;
          }
          await this.handleRequest(
            Number(agentId),
            requestURI as string,
            requestHash as string
          );
        }

        lastBlock = currentBlock;
      } catch (err) {
        console.error("[Router] Poll error:", err);
      }
    };

    // Immediate first poll then schedule
    await poll();
    setInterval(poll, this.pollIntervalMs);
  }

  /**
   * Process a single validation request.
   * Can be called directly for testing without on-chain events.
   */
  async handleRequest(
    agentId: number,
    requestURI: string,
    requestHash: string
  ): Promise<void> {
    console.log(`\n[Router] Processing request ${requestHash} for agent ${agentId}`);

    // ── 1. Fetch payload ────────────────────────────────────────────────────
    let payload: ValidationRequestPayload;
    try {
      payload = await this.fetchPayload(requestURI, requestHash);
    } catch (err) {
      console.error(`[Router] Failed to fetch/verify payload for ${requestHash}:`, err);
      await this.submitZeroScore(requestHash, "payload-fetch-failed");
      return;
    }

    // ── 2. Sybil guard ──────────────────────────────────────────────────────
    try {
      const mintBlock = await this.client.getAgentMintBlock(agentId);
      const currentBlock = await this.client.getCurrentBlock();
      const sybilResult = this.sybilGuard.check(payload, mintBlock, currentBlock);

      if (!sybilResult.allowed) {
        console.warn(`[Router] Sybil check failed for agent ${agentId}: ${sybilResult.reason}`);
        await this.submitZeroScore(requestHash, "sybil-rejected");
        return;
      }
    } catch (err) {
      console.warn(`[Router] Sybil check error (continuing):`, err);
    }

    // ── 3. Select + run verifiers ───────────────────────────────────────────
    const kind = payload.mandate.core.kind;
    const applicable = this.verifiers.filter(
      (v) => v.supportedKinds.includes("*") || v.supportedKinds.includes(kind)
    );

    if (applicable.length === 0) {
      console.warn(`[Router] No verifiers registered for kind "${kind}"`);
      await this.submitZeroScore(requestHash, `unsupported-kind:${kind}`);
      return;
    }

    console.log(`[Router] Running ${applicable.length} verifier(s) for kind "${kind}"`);

    const results: VerifierResult[] = [];
    for (const verifier of applicable) {
      try {
        const result = await verifier.verify(payload);
        results.push(result);
        console.log(`[Router]   ${verifier.id}: score=${result.score}${result.error ? ` error=${result.error}` : ""}`);
      } catch (err) {
        console.error(`[Router]   ${verifier.id}: uncaught error`, err);
        results.push({
          verifierId: verifier.id,
          score: 0,
          notes: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── 4. Aggregate score ──────────────────────────────────────────────────
    const finalScore = this.aggregateScores(results);
    console.log(`[Router] Final score: ${finalScore}/100`);

    // ── 5. Persist response JSON ────────────────────────────────────────────
    const responsePayload: ValidationResponsePayload = {
      requestHash,
      agentId,
      agentRegistry: payload.agentRegistry,
      finalScore,
      verifierResults: results,
      scoredAt: new Date().toISOString(),
      kind,
    };

    const { uri: responseURI, hash: responseHash } =
      await this.store.save(responsePayload);

    // ── 6. Post on-chain ────────────────────────────────────────────────────
    try {
      const receipt = await this.client.submitValidationResponse(
        requestHash,
        finalScore,
        responseURI,
        responseHash,
        kind
      );
      console.log(`[Router] validationResponse submitted. Tx: ${receipt?.hash}`);

      // Record sybil state only after successful on-chain submission
      this.sybilGuard.record(payload);
    } catch (err) {
      console.error(`[Router] Failed to submit validationResponse:`, err);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async fetchPayload(
    requestURI: string,
    requestHash: string
  ): Promise<ValidationRequestPayload> {
    let json: string;

    if (requestURI.startsWith("file://")) {
      // Local file (used in tests / demo)
      const fs = await import("fs");
      json = fs.readFileSync(requestURI.replace("file://", ""), "utf8");
    } else if (requestURI.startsWith("data:application/json;base64,")) {
      const b64 = requestURI.replace("data:application/json;base64,", "");
      json = Buffer.from(b64, "base64").toString("utf8");
    } else {
      const response = await axios.get<string>(requestURI, { responseType: "text", timeout: 10_000 });
      json = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    }

    // Verify hash commitment
    const computedHash = ethers.keccak256(ethers.toUtf8Bytes(json));
    if (computedHash.toLowerCase() !== requestHash.toLowerCase()) {
      throw new Error(
        `requestHash mismatch: expected ${requestHash}, computed ${computedHash}`
      );
    }

    return JSON.parse(json) as ValidationRequestPayload;
  }

  private aggregateScores(results: VerifierResult[]): number {
    if (results.length === 0) return 0;
    const validResults = results.filter((r) => !r.error);
    if (validResults.length === 0) return 0;
    const total = validResults.reduce((sum, r) => sum + r.score, 0);
    return Math.round(total / validResults.length);
  }

  private async submitZeroScore(requestHash: string, tag: string): Promise<void> {
    try {
      await this.client.submitValidationResponse(requestHash, 0, "", "0x" + "0".repeat(64), tag);
      console.log(`[Router] Zero-score submitted for ${requestHash} (tag: ${tag})`);
    } catch (err) {
      console.error(`[Router] Failed to submit zero-score:`, err);
    }
  }
}
