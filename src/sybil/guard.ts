/**
 * Sybil Resistance Guard
 *
 * Three layers of protection applied by the Router before scoring:
 *
 * 1. Rate limiting — each agentId is allowed at most MAX_REQUESTS_PER_WINDOW
 *    validation requests within a rolling WINDOW_SECONDS window.
 *    In-memory for MVP; swap for Redis in production.
 *
 * 2. Agent age gate — the agent NFT must have been minted at least
 *    MIN_AGENT_AGE_BLOCKS blocks ago, preventing freshly-created
 *    Sybil identities from immediately gaming scores.
 *
 * 3. Mandate nonce / replay protection — the keccak256 of
 *    (agentId + mandate.clientSig + mandate.serverSig) is tracked so
 *    the exact same (mandate, receipt) pair cannot be re-submitted to
 *    inflate a running average.
 */

import { ethers } from "ethers";
import { ValidationRequestPayload } from "../types/mandate";

export interface SybilCheckResult {
  allowed: boolean;
  reason?: string;
}

interface RateLimitEntry {
  timestamps: number[];
}

export class SybilGuard {
  private readonly maxRequestsPerWindow: number;
  private readonly windowSeconds: number;
  private readonly minAgentAgeBlocks: number;

  /** agentId → rate-limit state */
  private readonly rateLimitMap = new Map<number, RateLimitEntry>();

  /** Set of seen mandate nonces — keccak256(agentId + clientSig + serverSig) */
  private readonly seenNonces = new Set<string>();

  constructor(options?: {
    maxRequestsPerWindow?: number;
    windowSeconds?: number;
    minAgentAgeBlocks?: number;
  }) {
    this.maxRequestsPerWindow =
      options?.maxRequestsPerWindow ??
      Number(process.env.SYBIL_MAX_REQUESTS_PER_WINDOW ?? 10);
    this.windowSeconds =
      options?.windowSeconds ??
      Number(process.env.SYBIL_WINDOW_SECONDS ?? 3600);
    this.minAgentAgeBlocks =
      options?.minAgentAgeBlocks ??
      Number(process.env.SYBIL_MIN_AGENT_AGE_BLOCKS ?? 100);
  }

  /**
   * Run all sybil checks.
   * Returns { allowed: false, reason } on the first failed check.
   */
  check(
    payload: ValidationRequestPayload,
    agentMintBlock: number,
    currentBlock: number
  ): SybilCheckResult {
    const ageCheck = this.checkAgentAge(agentMintBlock, currentBlock, payload.agentId);
    if (!ageCheck.allowed) return ageCheck;

    const replayCheck = this.checkReplay(payload);
    if (!replayCheck.allowed) return replayCheck;

    const rateCheck = this.checkRateLimit(payload.agentId);
    if (!rateCheck.allowed) return rateCheck;

    return { allowed: true };
  }

  /**
   * Must be called AFTER a successful check() to record the submission.
   * Calling this before check() would register the nonce before validation.
   */
  record(payload: ValidationRequestPayload): void {
    this.recordRateLimit(payload.agentId);
    this.recordNonce(payload);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private checkAgentAge(
    mintBlock: number,
    currentBlock: number,
    agentId: number
  ): SybilCheckResult {
    const age = currentBlock - mintBlock;
    if (age < this.minAgentAgeBlocks) {
      return {
        allowed: false,
        reason:
          `Agent ${agentId} is too new: minted ${age} blocks ago, ` +
          `minimum required is ${this.minAgentAgeBlocks} blocks`,
      };
    }
    return { allowed: true };
  }

  private checkReplay(payload: ValidationRequestPayload): SybilCheckResult {
    const nonce = this.computeNonce(payload);
    if (this.seenNonces.has(nonce)) {
      return {
        allowed: false,
        reason: `Replay detected: this (mandate, receipt) pair has already been scored for agent ${payload.agentId}`,
      };
    }
    return { allowed: true };
  }

  private checkRateLimit(agentId: number): SybilCheckResult {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = nowSec - this.windowSeconds;
    const entry = this.rateLimitMap.get(agentId);

    if (!entry) return { allowed: true };

    // Prune stale timestamps
    const recent = entry.timestamps.filter((t) => t >= windowStart);
    entry.timestamps = recent;

    if (recent.length >= this.maxRequestsPerWindow) {
      return {
        allowed: false,
        reason:
          `Agent ${agentId} has exceeded the rate limit: ` +
          `${recent.length}/${this.maxRequestsPerWindow} requests in the last ${this.windowSeconds}s`,
      };
    }
    return { allowed: true };
  }

  private recordRateLimit(agentId: number): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const entry = this.rateLimitMap.get(agentId) ?? { timestamps: [] };
    entry.timestamps.push(nowSec);
    this.rateLimitMap.set(agentId, entry);
  }

  private recordNonce(payload: ValidationRequestPayload): void {
    this.seenNonces.add(this.computeNonce(payload));
  }

  private computeNonce(payload: ValidationRequestPayload): string {
    return ethers.keccak256(
      ethers.toUtf8Bytes(
        `${payload.agentId}:${payload.mandate.clientSig}:${payload.mandate.serverSig}`
      )
    );
  }
}
