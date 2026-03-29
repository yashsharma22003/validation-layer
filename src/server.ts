/**
 * Trust API Server
 *
 * Lightweight Express HTTP server exposing a single trust-snapshot endpoint.
 *
 * GET /trust/:agentId
 *   Query params:
 *     validator  — (repeatable) filter by validator address
 *     tag        — filter by tag string
 *
 * Example:
 *   curl http://localhost:3000/trust/42
 *   curl "http://localhost:3000/trust/42?tag=swap@1"
 */

import "dotenv/config";
import express, { Request, Response } from "express";
import { RegistryClient } from "./registry/client";
import { TrustService } from "./reputation/trust";

const app = express();
app.use(express.json());

let trustService: TrustService;

try {
  const client = new RegistryClient();
  trustService = new TrustService(client);
} catch (err) {
  console.error("Failed to initialise RegistryClient:", err);
  console.error("Make sure ROUTER_PRIVATE_KEY, RPC_URL, and registry addresses are set in .env");
  process.exit(1);
}

app.get("/trust/:agentId", async (req: Request, res: Response) => {
  const agentId = parseInt(req.params.agentId, 10);
  if (isNaN(agentId) || agentId < 0) {
    res.status(400).json({ error: "agentId must be a non-negative integer" });
    return;
  }

  const validators: string[] = req.query.validator
    ? Array.isArray(req.query.validator)
      ? (req.query.validator as string[])
      : [req.query.validator as string]
    : [];

  const tag = (req.query.tag as string) ?? "";

  try {
    const snapshot = await trustService.getSnapshot(agentId, validators, tag);
    res.json(snapshot);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.log(`Trust API server listening on http://localhost:${PORT}`);
  console.log(`  GET /trust/:agentId  — trust snapshot for an agent`);
  console.log(`  GET /health          — liveness check`);
});

export default app;
