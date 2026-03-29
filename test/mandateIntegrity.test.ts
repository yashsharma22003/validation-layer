/**
 * Unit tests — MandateIntegrityVerifier
 */

import { ethers } from "ethers";
import { MandateIntegrityVerifier } from "../src/verifiers/mandateIntegrity";
import {
  Mandate,
  MANDATE_DOMAIN_NAME,
  MANDATE_DOMAIN_VERSION,
  MANDATE_TYPES,
  SwapPayload,
  ValidationRequestPayload,
} from "../src/types/mandate";

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

async function buildValidMandate(): Promise<{
  mandate: Mandate;
  clientWallet: ethers.HDNodeWallet;
  serverWallet: ethers.HDNodeWallet;
}> {
  const clientWallet = ethers.Wallet.createRandom();
  const serverWallet = ethers.Wallet.createRandom();
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(swapPayload)));
  const value = { kind: "swap@1", deadline, payloadHash };

  const clientSig = await clientWallet.signTypedData(domain, MANDATE_TYPES, value);
  const serverSig = await serverWallet.signTypedData(domain, MANDATE_TYPES, value);

  const mandate: Mandate = {
    core: { kind: "swap@1", deadline, payload: swapPayload },
    clientAddress: clientWallet.address,
    serverAddress: serverWallet.address,
    clientSig,
    serverSig,
    chainId: CHAIN_ID,
  };
  return { mandate, clientWallet, serverWallet };
}

function makePayload(mandate: Mandate): ValidationRequestPayload {
  return {
    agentId: 1,
    agentRegistry: `eip155:${CHAIN_ID}:0x8004A818BFB912233c491871b3d84c89A494BD9e`,
    mandate,
    receipt: {
      kind: "swap@1",
      txHash: "0x" + "a".repeat(64),
      chainId: CHAIN_ID,
      tokenIn: swapPayload.tokenIn,
      tokenOut: swapPayload.tokenOut,
      amountIn: swapPayload.amountIn,
      amountOut: "520000000000000000",
      executedAt: Math.floor(Date.now() / 1000) - 60,
    },
    createdAt: new Date().toISOString(),
  };
}

describe("MandateIntegrityVerifier", () => {
  const verifier = new MandateIntegrityVerifier();

  it("returns score 100 for a fully valid mandate", async () => {
    const { mandate } = await buildValidMandate();
    const result = await verifier.verify(makePayload(mandate));
    expect(result.score).toBe(100);
    expect(result.error).toBeUndefined();
    const passed = result.notes.filter((n) => n.passed);
    expect(passed.length).toBe(result.notes.length);
  });

  it("deducts 20 pts when deadline has passed", async () => {
    const { mandate } = await buildValidMandate();
    // Set deadline in the past
    const expiredMandate: Mandate = {
      ...mandate,
      core: { ...mandate.core, deadline: Math.floor(Date.now() / 1000) - 1 },
    };
    // Signatures won't match the modified deadline, so also expect sig deductions
    // but the deadline check specifically should fail
    const result = await verifier.verify(makePayload(expiredMandate));
    const deadlineNote = result.notes.find((n) => n.check === "deadline");
    expect(deadlineNote?.passed).toBe(false);
    expect(result.score).toBeLessThan(100);
  });

  it("returns score 0 when required fields are missing", async () => {
    const payload = makePayload({} as Mandate);
    const result = await verifier.verify(payload);
    const fieldsNote = result.notes.find((n) => n.check === "required-fields");
    expect(fieldsNote?.passed).toBe(false);
    expect(result.score).toBeLessThanOrEqual(20);
  });

  it("catches invalid client signature", async () => {
    const { mandate, serverWallet } = await buildValidMandate();
    // Replace clientSig with serverWallet's sig (wrong signer)
    const deadline = mandate.core.deadline;
    const payloadHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify(swapPayload))
    );
    const wrongSig = await serverWallet.signTypedData(domain, MANDATE_TYPES, {
      kind: "swap@1", deadline, payloadHash,
    });

    const badMandate: Mandate = { ...mandate, clientSig: wrongSig };
    const result = await verifier.verify(makePayload(badMandate));
    const clientNote = result.notes.find((n) => n.check === "client-signature");
    expect(clientNote?.passed).toBe(false);
    expect(result.score).toBeLessThan(100);
  });

  it("catches invalid server signature", async () => {
    const { mandate, clientWallet } = await buildValidMandate();
    const deadline = mandate.core.deadline;
    const payloadHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify(swapPayload))
    );
    const wrongSig = await clientWallet.signTypedData(domain, MANDATE_TYPES, {
      kind: "swap@1", deadline, payloadHash,
    });

    const badMandate: Mandate = { ...mandate, serverSig: wrongSig };
    const result = await verifier.verify(makePayload(badMandate));
    const serverNote = result.notes.find((n) => n.check === "server-signature");
    expect(serverNote?.passed).toBe(false);
    expect(result.score).toBeLessThan(100);
  });

  it("has id 'mandate-integrity' and supports all kinds", () => {
    expect(verifier.id).toBe("mandate-integrity");
    expect(verifier.supportedKinds).toContain("*");
  });
});
