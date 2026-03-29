/**
 * Mandate Integrity Verifier
 *
 * Applies to every primitive kind ("*").
 * Scoring breakdown (total 100 pts):
 *
 *  20 pts — required fields present (core.kind, core.deadline, core.payload,
 *            clientAddress, serverAddress, chainId)
 *  20 pts — deadline is in the future at validation time
 *  30 pts — clientSig is a valid EIP-712 signature from clientAddress
 *  30 pts — serverSig is a valid EIP-712 signature from serverAddress
 */

import { ethers } from "ethers";
import {
  Mandate,
  MANDATE_DOMAIN_NAME,
  MANDATE_DOMAIN_VERSION,
  MANDATE_TYPES,
  ValidationRequestPayload,
} from "../types/mandate";
import { CheckNote, IVerifier, VerifierResult } from "../types/verifier";

export class MandateIntegrityVerifier implements IVerifier {
  readonly id = "mandate-integrity";
  readonly supportedKinds = ["*"];

  async verify(payload: ValidationRequestPayload): Promise<VerifierResult> {
    const notes: CheckNote[] = [];
    let score = 0;

    try {
      const { mandate } = payload;

      // ── 1. Required fields (20 pts) ────────────────────────────────────────
      const fieldsScore = this.checkRequiredFields(mandate, notes);
      score += fieldsScore;

      // ── 2. Deadline validity (20 pts) ─────────────────────────────────────
      const deadlineScore = this.checkDeadline(mandate, notes);
      score += deadlineScore;

      // Only verify signatures when the mandate is otherwise well-formed
      if (fieldsScore > 0) {
        // ── 3. Client signature (30 pts) ──────────────────────────────────
        const clientSigScore = await this.checkSignature(
          mandate,
          mandate.clientSig,
          mandate.clientAddress,
          "client",
          notes
        );
        score += clientSigScore;

        // ── 4. Server signature (30 pts) ──────────────────────────────────
        const serverSigScore = await this.checkSignature(
          mandate,
          mandate.serverSig,
          mandate.serverAddress,
          "server",
          notes
        );
        score += serverSigScore;
      } else {
        notes.push({
          check: "client-signature",
          passed: false,
          detail: "Skipped — required fields missing",
        });
        notes.push({
          check: "server-signature",
          passed: false,
          detail: "Skipped — required fields missing",
        });
      }
    } catch (err: unknown) {
      return {
        verifierId: this.id,
        score: 0,
        notes,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return { verifierId: this.id, score, notes };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private checkRequiredFields(mandate: Mandate, notes: CheckNote[]): number {
    const required: Array<[string, unknown]> = [
      ["core.kind", mandate.core?.kind],
      ["core.deadline", mandate.core?.deadline],
      ["core.payload", mandate.core?.payload],
      ["clientAddress", mandate.clientAddress],
      ["serverAddress", mandate.serverAddress],
      ["clientSig", mandate.clientSig],
      ["serverSig", mandate.serverSig],
      ["chainId", mandate.chainId],
    ];

    const missing = required
      .filter(([, v]) => v === undefined || v === null || v === "")
      .map(([k]) => k);

    const passed = missing.length === 0;
    notes.push({
      check: "required-fields",
      passed,
      detail: passed ? "All required fields present" : `Missing: ${missing.join(", ")}`,
    });

    return passed ? 20 : Math.max(0, 20 - missing.length * 3);
  }

  private checkDeadline(mandate: Mandate, notes: CheckNote[]): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const deadline = mandate.core?.deadline ?? 0;
    const passed = deadline > nowSec;

    notes.push({
      check: "deadline",
      passed,
      detail: passed
        ? `Deadline ${new Date(deadline * 1000).toISOString()} is in the future`
        : `Deadline ${new Date(deadline * 1000).toISOString()} has passed (now=${new Date(nowSec * 1000).toISOString()})`,
    });

    return passed ? 20 : 0;
  }

  private async checkSignature(
    mandate: Mandate,
    sig: string,
    expectedSigner: string,
    role: "client" | "server",
    notes: CheckNote[]
  ): Promise<number> {
    const checkName = `${role}-signature`;
    const maxPts = 30;

    if (!sig || sig === "0x") {
      notes.push({ check: checkName, passed: false, detail: "Signature is empty" });
      return 0;
    }

    try {
      const domain: ethers.TypedDataDomain = {
        name: MANDATE_DOMAIN_NAME,
        version: MANDATE_DOMAIN_VERSION,
        chainId: mandate.chainId,
      };

      // The payload is hashed so large nested objects stay off the typed-data
      const payloadHash = ethers.keccak256(
        ethers.toUtf8Bytes(JSON.stringify(mandate.core.payload))
      );

      const value = {
        kind: mandate.core.kind,
        deadline: mandate.core.deadline,
        payloadHash,
      };

      const recovered = ethers.verifyTypedData(
        domain,
        MANDATE_TYPES,
        value,
        sig
      );

      const passed =
        recovered.toLowerCase() === expectedSigner.toLowerCase();

      notes.push({
        check: checkName,
        passed,
        detail: passed
          ? `Signature valid — signer ${recovered}`
          : `Signer mismatch: expected ${expectedSigner}, got ${recovered}`,
      });

      return passed ? maxPts : 0;
    } catch (err: unknown) {
      notes.push({
        check: checkName,
        passed: false,
        detail: `Signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return 0;
    }
  }
}
