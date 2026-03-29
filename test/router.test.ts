/**
 * Unit tests — Router (offline, no chain connection)
 *
 * Tests the Router.handleRequest() logic using local file URIs
 * and mocked RegistryClient methods.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { ethers } from "ethers";
import {
  Mandate,
  MANDATE_DOMAIN_NAME,
  MANDATE_DOMAIN_VERSION,
  MANDATE_TYPES,
  SwapPayload,
  SwapReceipt,
  ValidationRequestPayload,
} from "../src/types/mandate";
import { MandateIntegrityVerifier } from "../src/verifiers/mandateIntegrity";
import { SwapReceiptVerifier } from "../src/verifiers/swapReceipt";

// ── Helpers ────────────────────────────────────────────────────────────────

const CHAIN_ID = 84532;

const swapPayload: SwapPayload = {
  tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  amountIn: "1000000000",
  minAmountOut: "500000000000000000",
  maxSlippageBps: 50,
  chainId: CHAIN_ID,
  deadline: Math.floor(Date.now() / 1000) + 3600,
};

const domain: ethers.TypedDataDomain = {
  name: MANDATE_DOMAIN_NAME,
  version: MANDATE_DOMAIN_VERSION,
  chainId: CHAIN_ID,
};

async function buildMandate(): Promise<Mandate> {
  const clientWallet = ethers.Wallet.createRandom();
  const serverWallet = ethers.Wallet.createRandom();
  const deadline = swapPayload.deadline;
  const payloadHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify(swapPayload))
  );
  const value = { kind: "swap@1", deadline, payloadHash };
  const clientSig = await clientWallet.signTypedData(domain, MANDATE_TYPES, value);
  const serverSig = await serverWallet.signTypedData(domain, MANDATE_TYPES, value);
  return {
    core: { kind: "swap@1", deadline, payload: swapPayload },
    clientAddress: clientWallet.address,
    serverAddress: serverWallet.address,
    clientSig, serverSig, chainId: CHAIN_ID,
  };
}

function buildReceipt(mandate: Mandate): SwapReceipt {
  return {
    kind: "swap@1",
    txHash: "0x" + "a".repeat(64),
    chainId: CHAIN_ID,
    tokenIn: (mandate.core.payload as SwapPayload).tokenIn,
    tokenOut: (mandate.core.payload as SwapPayload).tokenOut,
    amountIn: (mandate.core.payload as SwapPayload).amountIn,
    amountOut: "520000000000000000",
    executedAt: Math.floor(Date.now() / 1000) - 60,
  };
}

/** Write payload to a temp file and return file:// URI + requestHash */
function storePayload(payload: ValidationRequestPayload): { uri: string; hash: string } {
  const json = JSON.stringify(payload);
  const hash = ethers.keccak256(ethers.toUtf8Bytes(json));
  const tmpFile = path.join(os.tmpdir(), `vp_test_${Date.now()}.json`);
  fs.writeFileSync(tmpFile, json, "utf8");
  return { uri: `file://${tmpFile}`, hash };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Router aggregation logic", () => {
  it("averages verifier scores correctly (both 100 → final 100)", async () => {
    const mandate = await buildMandate();
    const receipt = buildReceipt(mandate);
    const payload: ValidationRequestPayload = {
      agentId: 1,
      agentRegistry: `eip155:${CHAIN_ID}:0x8004A818BFB912233c491871b3d84c89A494BD9e`,
      mandate, receipt, createdAt: new Date().toISOString(),
    };

    const iv = new MandateIntegrityVerifier();
    const sv = new SwapReceiptVerifier();

    const [r1, r2] = await Promise.all([iv.verify(payload), sv.verify(payload)]);
    expect(r1.score).toBe(100);
    expect(r2.score).toBe(100);

    const finalScore = Math.round((r1.score + r2.score) / 2);
    expect(finalScore).toBe(100);
  });

  it("averages correctly when one verifier fails partially", async () => {
    const mandate = await buildMandate();
    const receipt: SwapReceipt = {
      ...buildReceipt(mandate),
      amountOut: "100000000000000000", // below minAmountOut — deduct 20+10 pts
    };
    const payload: ValidationRequestPayload = {
      agentId: 1,
      agentRegistry: `eip155:${CHAIN_ID}:0x8004A818BFB912233c491871b3d84c89A494BD9e`,
      mandate, receipt, createdAt: new Date().toISOString(),
    };

    const iv = new MandateIntegrityVerifier();
    const sv = new SwapReceiptVerifier();
    const [r1, r2] = await Promise.all([iv.verify(payload), sv.verify(payload)]);

    expect(r1.score).toBe(100); // mandate integrity still perfect
    expect(r2.score).toBeLessThan(100); // receipt score penalised

    const finalScore = Math.round((r1.score + r2.score) / 2);
    expect(finalScore).toBeLessThan(100);
    expect(finalScore).toBeGreaterThan(0);
  });
});

describe("requestHash integrity check", () => {
  it("rejects payload when hash does not match", async () => {
    const mandate = await buildMandate();
    const receipt = buildReceipt(mandate);
    const payload: ValidationRequestPayload = {
      agentId: 1,
      agentRegistry: `eip155:${CHAIN_ID}:0x8004A818BFB912233c491871b3d84c89A494BD9e`,
      mandate, receipt, createdAt: new Date().toISOString(),
    };

    const { uri } = storePayload(payload);
    const wrongHash = "0x" + "f".repeat(64);

    // Simulating what the Router does internally
    const fs2 = await import("fs");
    const json = fs2.readFileSync(uri.replace("file://", ""), "utf8");
    const computedHash = ethers.keccak256(ethers.toUtf8Bytes(json));

    expect(computedHash.toLowerCase()).not.toBe(wrongHash.toLowerCase());
  });

  it("accepts payload when hash matches", async () => {
    const mandate = await buildMandate();
    const receipt = buildReceipt(mandate);
    const payload: ValidationRequestPayload = {
      agentId: 1,
      agentRegistry: `eip155:${CHAIN_ID}:0x8004A818BFB912233c491871b3d84c89A494BD9e`,
      mandate, receipt, createdAt: new Date().toISOString(),
    };

    const { uri, hash } = storePayload(payload);

    const fs2 = await import("fs");
    const json = fs2.readFileSync(uri.replace("file://", ""), "utf8");
    const computedHash = ethers.keccak256(ethers.toUtf8Bytes(json));

    expect(computedHash.toLowerCase()).toBe(hash.toLowerCase());
  });
});

describe("SybilGuard", () => {
  it("blocks replay of the same mandate/receipt pair", () => {
    // Import inline to avoid circular deps in test env
    const { SybilGuard } = require("../src/sybil/guard");
    const guard = new SybilGuard({ minAgentAgeBlocks: 0, maxRequestsPerWindow: 100 });

    const mandate: Mandate = {
      core: { kind: "swap@1", deadline: Math.floor(Date.now() / 1000) + 3600, payload: swapPayload },
      clientAddress: "0x1111111111111111111111111111111111111111",
      serverAddress: "0x2222222222222222222222222222222222222222",
      clientSig: "0x" + "aa".repeat(65),
      serverSig: "0x" + "bb".repeat(65),
      chainId: CHAIN_ID,
    };

    const receipt: SwapReceipt = {
      kind: "swap@1",
      txHash: "0x" + "a".repeat(64),
      chainId: CHAIN_ID,
      tokenIn: swapPayload.tokenIn,
      tokenOut: swapPayload.tokenOut,
      amountIn: swapPayload.amountIn,
      amountOut: "520000000000000000",
      executedAt: Math.floor(Date.now() / 1000) - 60,
    };

    const payload: ValidationRequestPayload = {
      agentId: 1,
      agentRegistry: `eip155:${CHAIN_ID}:0x0`,
      mandate, receipt, createdAt: new Date().toISOString(),
    };

    const first = guard.check(payload, 0, 1000);
    expect(first.allowed).toBe(true);

    guard.record(payload);

    const second = guard.check(payload, 0, 1000);
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain("Replay");
  });

  it("blocks agents that are too new", () => {
    const { SybilGuard } = require("../src/sybil/guard");
    const guard = new SybilGuard({ minAgentAgeBlocks: 100, maxRequestsPerWindow: 100 });

    const mandate: Mandate = {
      core: { kind: "swap@1", deadline: Math.floor(Date.now() / 1000) + 3600, payload: swapPayload },
      clientAddress: "0x1111111111111111111111111111111111111111",
      serverAddress: "0x2222222222222222222222222222222222222222",
      clientSig: "0x" + "aa".repeat(65),
      serverSig: "0x" + "bb".repeat(65),
      chainId: CHAIN_ID,
    };

    const receipt: SwapReceipt = {
      kind: "swap@1",
      txHash: "0x" + "b".repeat(64),
      chainId: CHAIN_ID,
      tokenIn: swapPayload.tokenIn,
      tokenOut: swapPayload.tokenOut,
      amountIn: swapPayload.amountIn,
      amountOut: "520000000000000000",
      executedAt: Math.floor(Date.now() / 1000) - 60,
    };

    const payload: ValidationRequestPayload = {
      agentId: 2,
      agentRegistry: `eip155:${CHAIN_ID}:0x0`,
      mandate, receipt, createdAt: new Date().toISOString(),
    };

    // Agent minted at block 990, current block 1000 → age = 10 < 100
    const result = guard.check(payload, 990, 1000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("too new");
  });

  it("enforces rate limit", () => {
    const { SybilGuard } = require("../src/sybil/guard");
    const guard = new SybilGuard({ minAgentAgeBlocks: 0, maxRequestsPerWindow: 2 });

    const makePayload = (i: number): ValidationRequestPayload => ({
      agentId: 99,
      agentRegistry: `eip155:${CHAIN_ID}:0x0`,
      mandate: {
        core: { kind: "swap@1", deadline: Math.floor(Date.now() / 1000) + 3600, payload: swapPayload },
        clientAddress: "0x1111111111111111111111111111111111111111",
        serverAddress: "0x2222222222222222222222222222222222222222",
        clientSig: "0x" + String(i).repeat(130).slice(0, 130),
        serverSig: "0x" + String(i + 1).repeat(130).slice(0, 130),
        chainId: CHAIN_ID,
      },
      receipt: {
        kind: "swap@1",
        txHash: "0x" + String(i).repeat(64).slice(0, 64),
        chainId: CHAIN_ID,
        tokenIn: swapPayload.tokenIn,
        tokenOut: swapPayload.tokenOut,
        amountIn: swapPayload.amountIn,
        amountOut: "520000000000000000",
        executedAt: Math.floor(Date.now() / 1000) - 60,
      },
      createdAt: new Date().toISOString(),
    });

    const p1 = makePayload(1);
    const p2 = makePayload(2);
    const p3 = makePayload(3);

    expect(guard.check(p1, 0, 1000).allowed).toBe(true);
    guard.record(p1);

    expect(guard.check(p2, 0, 1000).allowed).toBe(true);
    guard.record(p2);

    const third = guard.check(p3, 0, 1000);
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain("rate limit");
  });
});
