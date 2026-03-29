/**
 * End-to-end Demo (offline / dry-run)
 *
 * Demonstrates the full scoring flow WITHOUT requiring a live blockchain
 * connection.  Uses mock data to simulate:
 *
 *  1. Creating and signing a swap@1 Mandate (EIP-712)
 *  2. Building a SwapReceipt that executes the mandate
 *  3. Packing a ValidationRequestPayload and computing its requestHash
 *  4. Running the Router's verifiers offline (no on-chain call)
 *  5. Printing the score breakdown
 *
 * Run:
 *   npm run demo
 */

import "dotenv/config";
import { ethers } from "ethers";
import { MandateIntegrityVerifier } from "../src/verifiers/mandateIntegrity";
import { SwapReceiptVerifier } from "../src/verifiers/swapReceipt";
import {
  Mandate,
  MANDATE_DOMAIN_NAME,
  MANDATE_DOMAIN_VERSION,
  MANDATE_TYPES,
  SwapPayload,
  SwapReceipt,
  ValidationRequestPayload,
} from "../src/types/mandate";
import { VerifierResult } from "../src/types/verifier";

// ── Demo configuration ────────────────────────────────────────────────────────

const DEMO_CHAIN_ID = 84532; // Base Sepolia
const DEMO_AGENT_ID = 1;
const DEMO_AGENT_REGISTRY = `eip155:${DEMO_CHAIN_ID}:0x8004A818BFB912233c491871b3d84c89A494BD9e`;

// Deterministic demo wallets — DO NOT use real funds
const clientWallet = ethers.Wallet.createRandom();
const serverWallet = ethers.Wallet.createRandom();

async function buildMandate(): Promise<Mandate> {
  const nowSec = Math.floor(Date.now() / 1000);
  const deadline = nowSec + 3600; // 1 hour from now

  const payload: SwapPayload = {
    tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",   // USDC (example)
    tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",  // WETH (example)
    amountIn: "1000000000",    // 1,000 USDC (6 decimals)
    minAmountOut: "500000000000000000", // 0.5 WETH (18 decimals)
    maxSlippageBps: 50,        // 0.5%
    chainId: DEMO_CHAIN_ID,
    deadline,
  };

  const payloadHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify(payload))
  );

  const domain: ethers.TypedDataDomain = {
    name: MANDATE_DOMAIN_NAME,
    version: MANDATE_DOMAIN_VERSION,
    chainId: DEMO_CHAIN_ID,
  };
  const value = { kind: "swap@1", deadline, payloadHash };

  const clientSig = await clientWallet.signTypedData(domain, MANDATE_TYPES, value);
  const serverSig = await serverWallet.signTypedData(domain, MANDATE_TYPES, value);

  return {
    core: { kind: "swap@1", deadline, payload },
    clientAddress: clientWallet.address,
    serverAddress: serverWallet.address,
    clientSig,
    serverSig,
    chainId: DEMO_CHAIN_ID,
  };
}

function buildReceipt(mandate: Mandate): SwapReceipt {
  const swapPayload = mandate.core.payload as SwapPayload;
  return {
    kind: "swap@1",
    txHash: "0x" + "a".repeat(64),
    chainId: swapPayload.chainId,
    tokenIn: swapPayload.tokenIn,
    tokenOut: swapPayload.tokenOut,
    amountIn: swapPayload.amountIn,
    amountOut: "520000000000000000", // 0.52 WETH — above minAmountOut ✓
    executedAt: Math.floor(Date.now() / 1000) - 60, // 60s ago — before deadline ✓
    routerAddress: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  };
}

function printResult(result: VerifierResult) {
  const bar = "█".repeat(Math.round(result.score / 5)) + "░".repeat(20 - Math.round(result.score / 5));
  console.log(`\n  Verifier: ${result.verifierId}`);
  console.log(`  Score:    ${result.score}/100  [${bar}]`);
  if (result.error) console.log(`  Error:    ${result.error}`);
  for (const note of result.notes) {
    const icon = note.passed ? "✔" : "✘";
    console.log(`    ${icon} ${note.check.padEnd(22)} ${note.detail ?? ""}`);
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  VP Validation Layer — End-to-end Demo (swap@1)");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`\nClient wallet:  ${clientWallet.address}`);
  console.log(`Server wallet:  ${serverWallet.address}`);

  // 1. Build mandate + receipt
  console.log("\n[1/4] Building and signing swap@1 mandate...");
  const mandate = await buildMandate();
  console.log("      ✔ Mandate signed by client and server");

  console.log("[2/4] Building swap receipt...");
  const receipt = buildReceipt(mandate);
  console.log("      ✔ Receipt built");

  // 2. Pack request payload
  console.log("[3/4] Packing ValidationRequestPayload...");
  const requestPayload: ValidationRequestPayload = {
    agentId: DEMO_AGENT_ID,
    agentRegistry: DEMO_AGENT_REGISTRY,
    mandate,
    receipt,
    createdAt: new Date().toISOString(),
  };
  const payloadJson = JSON.stringify(requestPayload);
  const requestHash = ethers.keccak256(ethers.toUtf8Bytes(payloadJson));
  console.log(`      requestHash: ${requestHash}`);

  // 3. Run verifiers
  console.log("[4/4] Running verifiers...");
  const integrityVerifier = new MandateIntegrityVerifier();
  const receiptVerifier = new SwapReceiptVerifier();

  const results: VerifierResult[] = [
    await integrityVerifier.verify(requestPayload),
    await receiptVerifier.verify(requestPayload),
  ];

  // 4. Aggregate
  const validResults = results.filter((r) => !r.error);
  const finalScore = validResults.length
    ? Math.round(validResults.reduce((s, r) => s + r.score, 0) / validResults.length)
    : 0;

  // Print results
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  SCORE BREAKDOWN");
  console.log("═══════════════════════════════════════════════════════");
  for (const r of results) printResult(r);
  const bar = "█".repeat(Math.round(finalScore / 5)) + "░".repeat(20 - Math.round(finalScore / 5));
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  FINAL SCORE:  ${finalScore}/100  [${bar}]`);
  console.log("═══════════════════════════════════════════════════════\n");

  console.log("In a live run, the Router would now call:");
  console.log(`  validationResponse("${requestHash.slice(0, 18)}...", ${finalScore}, responseURI, responseHash, "swap@1")`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
