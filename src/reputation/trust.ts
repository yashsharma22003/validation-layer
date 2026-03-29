/**
 * Trust Snapshot
 *
 * Aggregates validation scores and reputation feedback from the ERC-8004
 * registries for a given agentId and returns a structured trust profile.
 *
 * Used by both the CLI (scripts/trust-snapshot.ts) and the REST API
 * (GET /trust/:agentId).
 */

import { RegistryClient } from "../registry/client";

export interface TrustSnapshot {
  agentId: number;
  agentRegistry: string;
  validation: {
    totalRequests: number;
    scoredRequests: number;
    averageScore: number;
    /** Score history ordered newest-first */
    history: ValidationEntry[];
  };
  reputation: {
    feedbackCount: number;
    summaryValue: string;
    summaryValueDecimals: number;
    /** Human-readable interpretation */
    scoreFormatted: string;
  };
  snapshotAt: string;
}

export interface ValidationEntry {
  requestHash: string;
  score: number;
  tag: string;
  lastUpdate: string;
}

export class TrustService {
  private readonly client: RegistryClient;

  constructor(client: RegistryClient) {
    this.client = client;
  }

  async getSnapshot(
    agentId: number,
    validatorAddresses: string[] = [],
    tag = ""
  ): Promise<TrustSnapshot> {
    const agentRegistry = this.buildAgentRegistry();

    // ── Validation data ────────────────────────────────────────────────────
    const allHashes = await this.client.getAgentValidations(agentId);

    const history: ValidationEntry[] = [];
    for (const hash of allHashes) {
      try {
        const status = await this.client.getValidationStatus(hash);
        // Filter by validator if specified
        if (
          validatorAddresses.length > 0 &&
          !validatorAddresses
            .map((a) => a.toLowerCase())
            .includes(status.validatorAddress.toLowerCase())
        ) {
          continue;
        }
        if (tag && status.tag !== tag) continue;

        history.push({
          requestHash: hash,
          score: status.response,
          tag: status.tag,
          lastUpdate: new Date(Number(status.lastUpdate) * 1000).toISOString(),
        });
      } catch {
        // Request exists but has no response yet — skip
      }
    }

    // Sort newest-first
    history.sort(
      (a, b) => new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime()
    );

    const summary = await this.client.getValidationSummary(
      agentId,
      validatorAddresses,
      tag
    );

    // ── Reputation data ────────────────────────────────────────────────────
    let repCount = 0n;
    let repValue = 0n;
    let repDecimals = 0;
    let repFormatted = "N/A";

    try {
      const clients = await this.client.getReputationClients(agentId);
      if (clients.length > 0) {
        const repSummary = await this.client.getReputationSummary(agentId, clients);
        repCount = repSummary.count;
        repValue = repSummary.summaryValue;
        repDecimals = repSummary.summaryValueDecimals;
        repFormatted = formatFixedPoint(repValue, repDecimals);
      }
    } catch {
      // Reputation registry may not have data yet
    }

    return {
      agentId,
      agentRegistry,
      validation: {
        totalRequests: allHashes.length,
        scoredRequests: Number(summary.count),
        averageScore: summary.avgResponse,
        history,
      },
      reputation: {
        feedbackCount: Number(repCount),
        summaryValue: repValue.toString(),
        summaryValueDecimals: repDecimals,
        scoreFormatted: repFormatted,
      },
      snapshotAt: new Date().toISOString(),
    };
  }

  private buildAgentRegistry(): string {
    const chainId = process.env.CHAIN_ID ?? "84532";
    const identityAddr =
      process.env.IDENTITY_REGISTRY_ADDRESS ?? "0x0000000000000000000000000000000000000000";
    return `eip155:${chainId}:${identityAddr}`;
  }
}

function formatFixedPoint(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const str = value.toString().padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals);
  return `${intPart}.${fracPart}`;
}
