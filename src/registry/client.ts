/**
 * ERC-8004 Registry Client
 *
 * Thin ethers.js v6 wrapper around the three ERC-8004 registries.
 * Exposes only the methods needed by the Router and Trust Snapshot.
 */

import { ethers } from "ethers";
import ValidationRegistryABI from "../../abis/ValidationRegistry.json";
import IdentityRegistryABI from "../../abis/IdentityRegistry.json";
import ReputationRegistryABI from "../../abis/ReputationRegistry.json";

export interface ValidationStatus {
  validatorAddress: string;
  agentId: bigint;
  response: number;
  responseHash: string;
  tag: string;
  lastUpdate: bigint;
  hasResponse?: boolean;
}

export interface ValidationSummary {
  count: bigint;
  avgResponse: number;
}

export interface FeedbackSummary {
  count: bigint;
  summaryValue: bigint;
  summaryValueDecimals: number;
}

export class RegistryClient {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly signer: ethers.Wallet;
  readonly validationRegistry: ethers.Contract;
  readonly identityRegistry: ethers.Contract;
  readonly reputationRegistry: ethers.Contract;

  constructor() {
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) throw new Error("RPC_URL not set in environment");

    const privateKey = process.env.ROUTER_PRIVATE_KEY;
    if (!privateKey) throw new Error("ROUTER_PRIVATE_KEY not set in environment");

    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.signer = new ethers.Wallet(privateKey, this.provider);

    const validationAddr = process.env.VALIDATION_REGISTRY_ADDRESS;
    const identityAddr = process.env.IDENTITY_REGISTRY_ADDRESS;
    const reputationAddr = process.env.REPUTATION_REGISTRY_ADDRESS;

    if (!validationAddr) throw new Error("VALIDATION_REGISTRY_ADDRESS not set");
    if (!identityAddr) throw new Error("IDENTITY_REGISTRY_ADDRESS not set");
    if (!reputationAddr) throw new Error("REPUTATION_REGISTRY_ADDRESS not set");

    this.validationRegistry = new ethers.Contract(
      validationAddr,
      ValidationRegistryABI,
      this.signer
    );
    this.identityRegistry = new ethers.Contract(
      identityAddr,
      IdentityRegistryABI,
      this.provider
    );
    this.reputationRegistry = new ethers.Contract(
      reputationAddr,
      ReputationRegistryABI,
      this.provider
    );
  }

  get routerAddress(): string {
    return this.signer.address;
  }

  // ── Validation Registry ────────────────────────────────────────────────────

  async submitValidationRequest(
    validatorAddress: string,
    agentId: number,
    requestURI: string,
    requestHash: string
  ): Promise<ethers.TransactionReceipt> {
    const tx = await this.validationRegistry.validationRequest(
      validatorAddress,
      agentId,
      requestURI,
      requestHash
    );
    return tx.wait();
  }

  async submitValidationResponse(
    requestHash: string,
    response: number,
    responseURI: string,
    responseHash: string,
    tag: string
  ): Promise<ethers.TransactionReceipt> {
    const tx = await this.validationRegistry.validationResponse(
      requestHash,
      response,
      responseURI,
      responseHash,
      tag
    );
    return tx.wait();
  }

  async getValidationStatus(requestHash: string): Promise<ValidationStatus> {
    const result = await this.validationRegistry.getValidationStatus(requestHash);
    return {
      validatorAddress: result[0],
      agentId: result[1],
      response: Number(result[2]),
      responseHash: result[3],
      tag: result[4],
      lastUpdate: result[5],
    };
  }

  async getValidationSummary(
    agentId: number,
    validatorAddresses: string[] = [],
    tag = ""
  ): Promise<ValidationSummary> {
    const [count, avgResponse] = await this.validationRegistry.getSummary(
      agentId,
      validatorAddresses,
      tag
    );
    return { count, avgResponse: Number(avgResponse) };
  }

  async getAgentValidations(agentId: number): Promise<string[]> {
    return this.validationRegistry.getAgentValidations(agentId);
  }

  async getValidatorRequests(validatorAddress: string): Promise<string[]> {
    return this.validationRegistry.getValidatorRequests(validatorAddress);
  }

  // ── Identity Registry ──────────────────────────────────────────────────────

  async getAgentOwner(agentId: number): Promise<string> {
    return this.identityRegistry.ownerOf(agentId);
  }

  /**
   * Returns the block number at which the agent NFT was minted by
   * scanning Transfer(from=0x0) events.  Falls back to 0 if not found.
   */
  async getAgentMintBlock(agentId: number): Promise<number> {
    try {
      const filter = this.identityRegistry.filters.Transfer(
        ethers.ZeroAddress,
        null,
        agentId
      );
      const events = await this.identityRegistry.queryFilter(filter);
      if (events.length === 0) return 0;
      return events[0].blockNumber;
    } catch {
      return 0;
    }
  }

  async getCurrentBlock(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  // ── Reputation Registry ────────────────────────────────────────────────────

  async getReputationSummary(
    agentId: number,
    clientAddresses: string[],
    tag1 = "",
    tag2 = ""
  ): Promise<FeedbackSummary> {
    const [count, summaryValue, summaryValueDecimals] =
      await this.reputationRegistry.getSummary(
        agentId,
        clientAddresses,
        tag1,
        tag2
      );
    return {
      count,
      summaryValue,
      summaryValueDecimals: Number(summaryValueDecimals),
    };
  }

  async getReputationClients(agentId: number): Promise<string[]> {
    return this.reputationRegistry.getClients(agentId);
  }
}
