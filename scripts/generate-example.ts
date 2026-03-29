import "dotenv/config";
import fs from "fs";
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

const DEMO_CHAIN_ID = 84532;
const DEMO_AGENT_ID = 1;
const DEMO_AGENT_REGISTRY = `eip155:${DEMO_CHAIN_ID}:0x8004A818BFB912233c491871b3d84c89A494BD9e`;

const clientWallet = ethers.Wallet.createRandom();
const serverWallet = ethers.Wallet.createRandom();

async function buildMandate(): Promise<Mandate> {
  const nowSec = Math.floor(Date.now() / 1000);
  const deadline = nowSec + 3600;

  const payload: SwapPayload = {
    tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    amountIn: "1000000000",
    minAmountOut: "500000000000000000",
    maxSlippageBps: 50,
    chainId: DEMO_CHAIN_ID,
    deadline,
  };

  const payloadHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify(payload))
  );

  const domain = {
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
    amountOut: "520000000000000000",
    executedAt: Math.floor(Date.now() / 1000) - 60,
    routerAddress: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  };
}

async function main() {
  const mandate = await buildMandate();
  const receipt = buildReceipt(mandate);

  const requestPayload: ValidationRequestPayload = {
    agentId: DEMO_AGENT_ID,
    agentRegistry: DEMO_AGENT_REGISTRY,
    mandate,
    receipt,
    createdAt: new Date().toISOString(),
  };

  const dir = path.resolve(__dirname, "../examples");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filePath = path.join(dir, "swap-request.json");
  fs.writeFileSync(filePath, JSON.stringify(requestPayload, null, 2), "utf8");
  console.log(`Generated example swap payload at ${filePath}`);
}

main().catch(console.error);
