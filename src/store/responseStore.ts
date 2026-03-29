/**
 * Response Store
 *
 * Persists ValidationResponsePayload JSON to a local directory and returns
 * a file:// URI (or an IPFS CID URI when RESPONSE_STORE=ipfs).
 *
 * Swap for a real IPFS/Arweave adapter in production to make responses
 * fully content-addressed and decentralised.
 */

import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { ValidationResponsePayload } from "../types/verifier";

export interface StoreResult {
  uri: string;
  hash: bytes32String;
}

type bytes32String = string;

export class ResponseStore {
  private readonly storePath: string;

  constructor() {
    this.storePath = path.resolve(
      process.env.RESPONSE_STORE_PATH ?? "./responses"
    );
    if (!fs.existsSync(this.storePath)) {
      fs.mkdirSync(this.storePath, { recursive: true });
    }
  }

  async save(response: ValidationResponsePayload): Promise<StoreResult> {
    const json = JSON.stringify(response, null, 2);
    const hash = ethers.keccak256(ethers.toUtf8Bytes(json)) as bytes32String;

    const filename = `${response.requestHash.slice(0, 10)}_${Date.now()}.json`;
    const filepath = path.join(this.storePath, filename);
    fs.writeFileSync(filepath, json, "utf8");

    const uri = `file://${filepath}`;
    return { uri, hash };
  }
}
