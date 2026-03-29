/**
 * Verifier interface and result types.
 *
 * Every verifier scores a (mandate, receipt) pair on a 0-100 scale.
 * The Router aggregates scores from all applicable verifiers and derives
 * a single finalScore = Math.round(average(scores)).
 */

import { ValidationRequestPayload } from "./mandate";

// ── Score result returned by each verifier ───────────────────────────────────

export interface VerifierResult {
  /** Verifier identifier, e.g. "mandate-integrity" */
  verifierId: string;
  /**
   * Score between 0 and 100.
   * 100 = fully passed, 0 = completely failed.
   * Intermediate values allow partial credit.
   */
  score: number;
  /**
   * Structured notes explaining the score.
   * Each entry is a (checkName, passed, detail?) tuple.
   */
  notes: CheckNote[];
  /** True if the verifier encountered a hard error and the score is unreliable */
  error?: string;
}

export interface CheckNote {
  check: string;
  passed: boolean;
  /** Optional human-readable detail or actual vs expected values */
  detail?: string;
}

// ── Verifier interface ────────────────────────────────────────────────────────

export interface IVerifier {
  /** Stable identifier, kebab-case */
  readonly id: string;
  /**
   * Returns the list of mandate `core.kind` values this verifier handles.
   * Return `["*"]` to apply to every kind (e.g. MandateIntegrityVerifier).
   */
  readonly supportedKinds: string[];
  /**
   * Score the supplied request payload.
   * Must never throw — errors are captured in VerifierResult.error.
   */
  verify(payload: ValidationRequestPayload): Promise<VerifierResult>;
}

// ── Aggregated response written to responseURI ───────────────────────────────

export interface ValidationResponsePayload {
  /** requestHash that triggered this scoring */
  requestHash: string;
  agentId: number;
  agentRegistry: string;
  /** Final aggregated score 0-100 posted on-chain */
  finalScore: number;
  /** Per-verifier breakdown */
  verifierResults: VerifierResult[];
  /** ISO-8601 timestamp */
  scoredAt: string;
  /** mandate.core.kind that was scored */
  kind: string;
}
