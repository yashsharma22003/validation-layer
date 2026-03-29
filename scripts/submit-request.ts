/**
 * CLI — Submit a validation request to the ERC-8004 Validation Registry.
 *
 * Usage:
 *   npm run submit-request -- --agentId 1 --payloadFile ./examples/swap-request.json
 *
 * Flags:
 *   --agentId      <number>   ERC-721 tokenId of the agent (required)
 *   --payloadFile  <path>     Path to a ValidationRequestPayload JSON file (required)
 *
 * The script:
 *  1. Reads the JSON payload
 *  2. Computes requestHash = keccak256(JSON string)
 *  3. Stores the payload to a local file and builds a requestURI
 *  4. Calls validationRequest(ROUTER_ADDRESS, agentId, requestURI, requestHash)
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { RegistryClient } from "../src/registry/client";
import { ValidationRequestPayload } from "../src/types/mandate";

function parseArgs(): { agentId: number; payloadFile: string } {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const agentIdStr = get("--agentId");
  const payloadFile = get("--payloadFile");
  if (!agentIdStr || !payloadFile) {
    console.error("Usage: npm run submit-request -- --agentId <n> --payloadFile <path>");
    process.exit(1);
  }
  return { agentId: parseInt(agentIdStr, 10), payloadFile };
}

async function main() {
  const { agentId, payloadFile } = parseArgs();

  // Read and validate payload
  const raw = fs.readFileSync(path.resolve(payloadFile), "utf8");
  const payload = JSON.parse(raw) as ValidationRequestPayload;

  if (payload.agentId !== agentId) {
    console.warn(`Warning: payload.agentId (${payload.agentId}) differs from --agentId (${agentId}). Using --agentId.`);
    payload.agentId = agentId;
  }

  // Compute hash over canonical JSON
  const canonicalJson = JSON.stringify(payload);
  const requestHash = ethers.keccak256(ethers.toUtf8Bytes(canonicalJson));
  console.log(`requestHash: ${requestHash}`);

  // Store payload locally and build URI
  const storePath = path.resolve(process.env.RESPONSE_STORE_PATH ?? "./responses");
  if (!fs.existsSync(storePath)) fs.mkdirSync(storePath, { recursive: true });
  const filename = `request_${requestHash.slice(0, 10)}_${Date.now()}.json`;
  const filepath = path.join(storePath, filename);
  fs.writeFileSync(filepath, canonicalJson, "utf8");
  const requestURI = `file://${filepath}`;
  console.log(`requestURI: ${requestURI}`);

  // Submit on-chain
  const client = new RegistryClient();
  console.log(`Router address (validatorAddress): ${client.routerAddress}`);
  console.log(`Submitting validationRequest for agentId=${agentId}...`);

  const receipt = await client.submitValidationRequest(
    client.routerAddress,
    agentId,
    requestURI,
    requestHash
  );

  console.log(`\nValidation request submitted!`);
  console.log(`  Tx hash:      ${receipt?.hash}`);
  console.log(`  requestHash:  ${requestHash}`);
  console.log(`  requestURI:   ${requestURI}`);
  console.log(`\nThe Router will now pick up this request and score it.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
