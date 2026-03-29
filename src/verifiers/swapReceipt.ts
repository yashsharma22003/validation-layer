/**
 * Swap@1 Primitive Receipt Verifier
 *
 * Validates that an on-chain swap receipt faithfully executes the
 * swap mandate specified in mandate.core.payload.
 *
 * Scoring breakdown (total 100 pts):
 *
 *  10 pts — receipt.kind === "swap@1"
 *  10 pts — chainId matches mandate payload
 *  20 pts — tokenIn / tokenOut match mandate (case-insensitive address compare)
 *  20 pts — amountIn matches mandate (within AMOUNT_TOLERANCE_BPS tolerance)
 *  20 pts — amountOut >= mandate.minAmountOut
 *  10 pts — slippage within mandate.maxSlippageBps
 *  10 pts — swap executed before mandate deadline
 */

import { CheckNote, IVerifier, VerifierResult } from "../types/verifier";
import {
  SwapPayload,
  SwapReceipt,
  ValidationRequestPayload,
} from "../types/mandate";

/** 10 bps = 0.1% tolerance on amountIn to account for protocol rounding */
const AMOUNT_TOLERANCE_BPS = 10n;
const BPS_DENOMINATOR = 10_000n;

export class SwapReceiptVerifier implements IVerifier {
  readonly id = "swap-receipt";
  readonly supportedKinds = ["swap@1"];

  async verify(payload: ValidationRequestPayload): Promise<VerifierResult> {
    const notes: CheckNote[] = [];
    let score = 0;

    try {
      const { mandate, receipt } = payload;

      // ── 1. Kind check (10 pts) ─────────────────────────────────────────────
      const kindPassed = receipt.kind === "swap@1";
      notes.push({
        check: "receipt-kind",
        passed: kindPassed,
        detail: kindPassed
          ? "receipt.kind === 'swap@1'"
          : `Expected 'swap@1', got '${receipt.kind}'`,
      });
      score += kindPassed ? 10 : 0;

      if (!kindPassed) {
        // Can't meaningfully score the rest without the right receipt type
        return { verifierId: this.id, score, notes };
      }

      const swapReceipt = receipt as SwapReceipt;
      const swapPayload = mandate.core.payload as SwapPayload;

      // ── 2. Chain ID (10 pts) ───────────────────────────────────────────────
      const chainPassed = swapReceipt.chainId === swapPayload.chainId;
      notes.push({
        check: "chain-id",
        passed: chainPassed,
        detail: chainPassed
          ? `chainId ${swapReceipt.chainId} matches`
          : `Expected chainId ${swapPayload.chainId}, got ${swapReceipt.chainId}`,
      });
      score += chainPassed ? 10 : 0;

      // ── 3. Token pair (20 pts) ─────────────────────────────────────────────
      const tokenInPassed =
        swapReceipt.tokenIn.toLowerCase() === swapPayload.tokenIn.toLowerCase();
      const tokenOutPassed =
        swapReceipt.tokenOut.toLowerCase() ===
        swapPayload.tokenOut.toLowerCase();

      notes.push({
        check: "token-in",
        passed: tokenInPassed,
        detail: tokenInPassed
          ? `tokenIn ${swapReceipt.tokenIn} matches`
          : `Expected tokenIn ${swapPayload.tokenIn}, got ${swapReceipt.tokenIn}`,
      });
      notes.push({
        check: "token-out",
        passed: tokenOutPassed,
        detail: tokenOutPassed
          ? `tokenOut ${swapReceipt.tokenOut} matches`
          : `Expected tokenOut ${swapPayload.tokenOut}, got ${swapReceipt.tokenOut}`,
      });
      score += tokenInPassed ? 10 : 0;
      score += tokenOutPassed ? 10 : 0;

      // ── 4. Amount in (20 pts, within tolerance) ────────────────────────────
      const amountInScore = this.scoreAmountIn(
        swapReceipt.amountIn,
        swapPayload.amountIn,
        notes
      );
      score += amountInScore;

      // ── 5. Amount out >= minAmountOut (20 pts) ────────────────────────────
      const amountOutScore = this.scoreAmountOut(
        swapReceipt.amountOut,
        swapPayload.minAmountOut,
        notes
      );
      score += amountOutScore;

      // ── 6. Slippage within maxSlippageBps (10 pts) ────────────────────────
      // Slippage = (amountIn / minAmountOut * actualAmountOut - 1) isn't always
      // knowable without a price oracle, so we use the simpler proxy:
      // effective slippage ≈ (minAmountOut - amountOut) / minAmountOut * 10000
      // If amountOut >= minAmountOut, slippage ≤ 0 (no slippage vs floor).
      const slippageScore = this.scoreSlippage(
        swapReceipt.amountOut,
        swapPayload.minAmountOut,
        swapPayload.maxSlippageBps,
        notes
      );
      score += slippageScore;

      // ── 7. Executed before mandate deadline (10 pts) ──────────────────────
      const deadlinePassed =
        swapReceipt.executedAt <= swapPayload.deadline;
      notes.push({
        check: "execution-deadline",
        passed: deadlinePassed,
        detail: deadlinePassed
          ? `Executed at ${new Date(swapReceipt.executedAt * 1000).toISOString()}, deadline ${new Date(swapPayload.deadline * 1000).toISOString()}`
          : `Swap executed AFTER mandate deadline. executedAt=${swapReceipt.executedAt}, deadline=${swapPayload.deadline}`,
      });
      score += deadlinePassed ? 10 : 0;
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

  private scoreAmountIn(
    actual: string,
    expected: string,
    notes: CheckNote[]
  ): number {
    try {
      const actualBn = BigInt(actual);
      const expectedBn = BigInt(expected);
      if (expectedBn === 0n) {
        notes.push({ check: "amount-in", passed: false, detail: "mandate amountIn is zero" });
        return 0;
      }

      // Allow up to AMOUNT_TOLERANCE_BPS difference
      const diff = actualBn > expectedBn ? actualBn - expectedBn : expectedBn - actualBn;
      const toleranceBn = (expectedBn * AMOUNT_TOLERANCE_BPS) / BPS_DENOMINATOR;
      const passed = diff <= toleranceBn;

      notes.push({
        check: "amount-in",
        passed,
        detail: passed
          ? `amountIn ${actual} within ${AMOUNT_TOLERANCE_BPS} bps of ${expected}`
          : `amountIn ${actual} deviates by ${diff} (>${toleranceBn}) from expected ${expected}`,
      });
      return passed ? 20 : 0;
    } catch {
      notes.push({ check: "amount-in", passed: false, detail: "Failed to parse amountIn as BigInt" });
      return 0;
    }
  }

  private scoreAmountOut(
    actual: string,
    minAmountOut: string,
    notes: CheckNote[]
  ): number {
    try {
      const actualBn = BigInt(actual);
      const minBn = BigInt(minAmountOut);
      const passed = actualBn >= minBn;

      notes.push({
        check: "min-amount-out",
        passed,
        detail: passed
          ? `amountOut ${actual} >= minAmountOut ${minAmountOut}`
          : `amountOut ${actual} < minAmountOut ${minAmountOut} (slippage too high)`,
      });
      return passed ? 20 : 0;
    } catch {
      notes.push({ check: "min-amount-out", passed: false, detail: "Failed to parse amounts as BigInt" });
      return 0;
    }
  }

  private scoreSlippage(
    actualAmountOut: string,
    minAmountOut: string,
    maxSlippageBps: number,
    notes: CheckNote[]
  ): number {
    try {
      const actualBn = BigInt(actualAmountOut);
      const minBn = BigInt(minAmountOut);

      if (minBn === 0n) {
        notes.push({ check: "slippage", passed: true, detail: "minAmountOut is zero — slippage check skipped" });
        return 10;
      }

      // If actual >= min, effective slippage is zero or negative (better than floor)
      if (actualBn >= minBn) {
        notes.push({
          check: "slippage",
          passed: true,
          detail: `amountOut ${actualAmountOut} >= minAmountOut — slippage within bounds`,
        });
        return 10;
      }

      // Effective slippage in bps = (min - actual) / min * 10000
      const slippageBps = ((minBn - actualBn) * BPS_DENOMINATOR) / minBn;
      const passed = slippageBps <= BigInt(maxSlippageBps);

      notes.push({
        check: "slippage",
        passed,
        detail: passed
          ? `Effective slippage ${slippageBps} bps ≤ max ${maxSlippageBps} bps`
          : `Effective slippage ${slippageBps} bps exceeds max ${maxSlippageBps} bps`,
      });
      return passed ? 10 : 0;
    } catch {
      notes.push({ check: "slippage", passed: false, detail: "Failed to compute slippage" });
      return 0;
    }
  }
}
