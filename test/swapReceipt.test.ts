/**
 * Unit tests — SwapReceiptVerifier
 */

import { SwapReceiptVerifier } from "../src/verifiers/swapReceipt";
import { SwapPayload, SwapReceipt, Mandate, ValidationRequestPayload } from "../src/types/mandate";

const CHAIN_ID = 84532;

const basePayload: SwapPayload = {
  tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  amountIn: "1000000000",
  minAmountOut: "500000000000000000",
  maxSlippageBps: 50,
  chainId: CHAIN_ID,
  deadline: Math.floor(Date.now() / 1000) + 3600,
};

const baseMandate: Mandate = {
  core: { kind: "swap@1", deadline: basePayload.deadline, payload: basePayload },
  clientAddress: "0x1111111111111111111111111111111111111111",
  serverAddress: "0x2222222222222222222222222222222222222222",
  clientSig: "0x" + "a".repeat(130),
  serverSig: "0x" + "b".repeat(130),
  chainId: CHAIN_ID,
};

const baseReceipt: SwapReceipt = {
  kind: "swap@1",
  txHash: "0x" + "c".repeat(64),
  chainId: CHAIN_ID,
  tokenIn: basePayload.tokenIn,
  tokenOut: basePayload.tokenOut,
  amountIn: basePayload.amountIn,
  amountOut: "520000000000000000", // > minAmountOut ✓
  executedAt: Math.floor(Date.now() / 1000) - 60,
};

function makeRequestPayload(
  mandate: Mandate = baseMandate,
  receipt: SwapReceipt = baseReceipt
): ValidationRequestPayload {
  return {
    agentId: 1,
    agentRegistry: `eip155:${CHAIN_ID}:0x8004A818BFB912233c491871b3d84c89A494BD9e`,
    mandate,
    receipt,
    createdAt: new Date().toISOString(),
  };
}

describe("SwapReceiptVerifier", () => {
  const verifier = new SwapReceiptVerifier();

  it("returns score 100 for a fully valid swap receipt", async () => {
    const result = await verifier.verify(makeRequestPayload());
    expect(result.score).toBe(100);
    expect(result.error).toBeUndefined();
    expect(result.notes.every((n) => n.passed)).toBe(true);
  });

  it("has id 'swap-receipt' and supports only swap@1", () => {
    expect(verifier.id).toBe("swap-receipt");
    expect(verifier.supportedKinds).toEqual(["swap@1"]);
  });

  it("scores 10/100 when receipt.kind is wrong", async () => {
    const badReceipt = { ...baseReceipt, kind: "transfer@1" } as unknown as SwapReceipt;
    const result = await verifier.verify(makeRequestPayload(baseMandate, badReceipt));
    expect(result.score).toBe(0); // kind mismatch = early return with 0
  });

  it("deducts 10 pts when chainId mismatches", async () => {
    const badReceipt = { ...baseReceipt, chainId: 1 };
    const result = await verifier.verify(makeRequestPayload(baseMandate, badReceipt));
    const note = result.notes.find((n) => n.check === "chain-id");
    expect(note?.passed).toBe(false);
    expect(result.score).toBe(90);
  });

  it("deducts 10 pts for wrong tokenIn", async () => {
    const badReceipt = { ...baseReceipt, tokenIn: "0x" + "d".repeat(40) };
    const result = await verifier.verify(makeRequestPayload(baseMandate, badReceipt));
    const note = result.notes.find((n) => n.check === "token-in");
    expect(note?.passed).toBe(false);
    expect(result.score).toBe(90);
  });

  it("deducts 10 pts for wrong tokenOut", async () => {
    const badReceipt = { ...baseReceipt, tokenOut: "0x" + "d".repeat(40) };
    const result = await verifier.verify(makeRequestPayload(baseMandate, badReceipt));
    const note = result.notes.find((n) => n.check === "token-out");
    expect(note?.passed).toBe(false);
    expect(result.score).toBe(90);
  });

  it("deducts 20 pts when amountIn deviates beyond tolerance", async () => {
    const badReceipt = { ...baseReceipt, amountIn: "2000000000" }; // 2× — way off
    const result = await verifier.verify(makeRequestPayload(baseMandate, badReceipt));
    const note = result.notes.find((n) => n.check === "amount-in");
    expect(note?.passed).toBe(false);
    expect(result.score).toBe(80);
  });

  it("deducts 20 pts when amountOut < minAmountOut", async () => {
    const badReceipt = { ...baseReceipt, amountOut: "100000000000000000" }; // 0.1 WETH < 0.5
    const result = await verifier.verify(makeRequestPayload(baseMandate, badReceipt));
    const note = result.notes.find((n) => n.check === "min-amount-out");
    expect(note?.passed).toBe(false);
  });

  it("deducts 10 pts when executedAt > deadline", async () => {
    const futureExec = Math.floor(Date.now() / 1000) + 7200; // 2 hours in future
    const badReceipt = { ...baseReceipt, executedAt: futureExec };
    const result = await verifier.verify(makeRequestPayload(baseMandate, badReceipt));
    const note = result.notes.find((n) => n.check === "execution-deadline");
    expect(note?.passed).toBe(false);
    expect(result.score).toBe(90);
  });

  it("is tolerant of small amountIn rounding within AMOUNT_TOLERANCE_BPS", async () => {
    // 1 bps off = 100000 / 10000 = 10 units off on 1_000_000_000
    const closeEnough = (BigInt(basePayload.amountIn) + 5000n).toString();
    const receipt = { ...baseReceipt, amountIn: closeEnough };
    const result = await verifier.verify(makeRequestPayload(baseMandate, receipt));
    const note = result.notes.find((n) => n.check === "amount-in");
    expect(note?.passed).toBe(true);
  });

  it("is token address comparison case-insensitive", async () => {
    const receipt = {
      ...baseReceipt,
      tokenIn: basePayload.tokenIn.toUpperCase(),
      tokenOut: basePayload.tokenOut.toUpperCase(),
    };
    const result = await verifier.verify(makeRequestPayload(baseMandate, receipt));
    const tokenInNote = result.notes.find((n) => n.check === "token-in");
    const tokenOutNote = result.notes.find((n) => n.check === "token-out");
    expect(tokenInNote?.passed).toBe(true);
    expect(tokenOutNote?.passed).toBe(true);
  });
});
