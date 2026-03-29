/**
 * Entry point — starts the Router event listener.
 *
 * Usage:
 *   cp .env.example .env      # fill in keys
 *   npm install
 *   npm run router            # ts-node src/index.ts
 */

import "dotenv/config";
import { Router } from "./router/router";

async function main() {
  const router = new Router();
  await router.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
