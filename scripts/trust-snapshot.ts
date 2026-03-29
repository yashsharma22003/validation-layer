/**
 * CLI — Print a trust snapshot for an agent.
 *
 * Usage:
 *   npm run trust-snapshot -- --agentId 1
 *   npm run trust-snapshot -- --agentId 1 --tag swap@1
 *   npm run trust-snapshot -- --agentId 1 --validator 0xABCD...
 */

import "dotenv/config";
import { RegistryClient } from "../src/registry/client";
import { TrustService } from "../src/reputation/trust";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const getAll = (flag: string): string[] => {
    const results: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && args[i + 1]) results.push(args[++i]);
    }
    return results;
  };

  const agentIdStr = get("--agentId");
  if (!agentIdStr) {
    console.error("Usage: npm run trust-snapshot -- --agentId <n> [--tag <tag>] [--validator <addr>]");
    process.exit(1);
  }
  return {
    agentId: parseInt(agentIdStr, 10),
    tag: get("--tag") ?? "",
    validators: getAll("--validator"),
  };
}

async function main() {
  const { agentId, tag, validators } = parseArgs();

  const client = new RegistryClient();
  const service = new TrustService(client);

  console.log(`Fetching trust snapshot for agent #${agentId}...`);
  const snapshot = await service.getSnapshot(agentId, validators, tag);

  console.log("\n══════════════════════════════════════════════════");
  console.log(`  Trust Snapshot — Agent #${snapshot.agentId}`);
  console.log(`  Registry: ${snapshot.agentRegistry}`);
  console.log(`  As of:    ${snapshot.snapshotAt}`);
  console.log("══════════════════════════════════════════════════");
  console.log("\n── Validation ─────────────────────────────────────");
  console.log(`  Total requests:   ${snapshot.validation.totalRequests}`);
  console.log(`  Scored requests:  ${snapshot.validation.scoredRequests}`);
  console.log(`  Average score:    ${snapshot.validation.averageScore}/100`);

  if (snapshot.validation.history.length > 0) {
    console.log("\n  Score history (newest first):");
    for (const h of snapshot.validation.history) {
      const shortHash = `${h.requestHash.slice(0, 10)}...`;
      console.log(`    [${h.lastUpdate}] ${shortHash} score=${h.score}  tag="${h.tag}"`);
    }
  }

  console.log("\n── Reputation ─────────────────────────────────────");
  console.log(`  Feedback count:   ${snapshot.reputation.feedbackCount}`);
  console.log(`  Summary score:    ${snapshot.reputation.scoreFormatted}`);
  console.log("══════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
