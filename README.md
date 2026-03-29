# Validation Layer

This is the off-chain scoring layer for the VP protocol. It listens for `ValidationRequest` events from an ERC-8004 Validation Registry, runs the payload through a set of verifiers, and posts a `validationResponse` back on-chain with a 0–100 score.

There's also a small Express server (`GET /trust/:agentId`) that aggregates validation history + reputation data into a trust snapshot if you need that.

---

## How it fits together

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Validation Layer                              │
│                                                                         │
│  ┌──────────────┐   validationRequest()     ┌────────────────────┐      │
│  │ ERC-8004     │ ◄──────────────────────── │   Agent / Client   │      │
│  │ Validation   │                           └────────────────────┘      │
│  │ Registry     │ ──ValidationRequest──►  ┌───────────────────────────┐ │
│  │ (on-chain)   │        event            │      Router (EOA)         │ │
│  │              │ ◄──validationResponse── │  • Fetch + hash-verify    │ │
│  └──────────────┘                         │    payload from URI       │ │
│                                           │  • Sybil guard checks     │ │
│                                           │  • Route by kind          │ │
│                                           │  • Aggregate scores       │ │
│                                           └───────────┬───────────────┘ │
│                                                       │                 │
│                         ┌─────────────────────────────┴─────────────┐   │
│                         │                             │             │   │
│                  ┌──────▼──────┐            ┌─────────▼──────────┐  │   │
│                  │  Mandate    │            │  Swap@1 Receipt    │  │   │
│                  │  Integrity  │            │  Verifier          │  │   │
│                  │  Verifier   │            │  (swap@1 only)     │  │   │
│                  │  (all kinds)│            └────────────────────┘  │   │
│                  └─────────────┘                                    │   │
│                         │ score 0–100          │ score 0–100        │   │
│                         └──────────────────────┘                    │   │
│                                 finalScore = avg(scores)            │   │
│                         └───────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────┐   GET /trust/:agentId     ┌────────────────────┐      │
│  │ Reputation   │ ◄──────────────────────── │  Trust API Server  │      │
│  │ Registry     │                           │  (Express)         │      │
│  └──────────────┘                           └────────────────────┘      │
└─────────────────────────────────────────────────────────────────────────┘
```

Key files:

- `src/router/router.ts` — the main loop; polls events, calls verifiers, posts responses
- `src/verifiers/mandateIntegrity.ts` — checks required fields, deadline, EIP-712 sigs
- `src/verifiers/swapReceipt.ts` — validates swap execution against what was in the mandate
- `src/sybil/guard.ts` — rate limiting, age gate, replay protection
- `src/registry/client.ts` — ethers.js v6 wrapper for the ERC-8004 contracts
- `src/reputation/trust.ts` — builds the trust snapshot object
- `src/server.ts` — the Express API
- `src/store/responseStore.ts` — saves response JSON locally, returns a URI + keccak256 hash

---

## Getting started

```bash
cd vp-validation-layer
npm install
cp .env.example .env
```

Fill in `.env`:

```env
RPC_URL=https://sepolia.base.org
CHAIN_ID=84532

# This EOA's address becomes the validatorAddress the Router posts responses from
ROUTER_PRIVATE_KEY=0xYourPrivateKey...

IDENTITY_REGISTRY_ADDRESS=0x056a3452ab5F1A6a0e4A5A6c7fb7f2fD48ae6Cef
VALIDATION_REGISTRY_ADDRESS=0xE825d11F112EcCaF3215c08f8bec12EC4d8Ed3F7
REPUTATION_REGISTRY_ADDRESS=0x92c4Fe214c00A5B87EB8539F33aCbE68f7f93a3C
```

The contracts above are fully deployed on Base Sepolia. (You can also deploy your own using the included `erc-8004-contracts/` directory by running the deployment scripts).

---

## Running it

### Just want to see it work? Run the offline demo first

No chain, no private key needed:

```bash
npm run demo
```

This runs the full scoring flow on mocked data and prints something like:

```
═══════════════════════════════════════════════════════
  Validation Layer — End-to-end Demo (swap@1)
═══════════════════════════════════════════════════════

[1/4] Building and signing swap@1 mandate...
      ✔ Mandate signed by client and server
[2/4] Building swap receipt...
      ✔ Receipt built
[3/4] Packing ValidationRequestPayload...
      requestHash: 0x...
[4/4] Running verifiers...

  Verifier: mandate-integrity    Score: 100/100
  Verifier: swap-receipt         Score: 100/100

  FINAL SCORE:  100/100
═══════════════════════════════════════════════════════
```

### Against a real chain

**1. Start the Router**

```bash
npm run router
```

It'll connect to the RPC and start polling for `ValidationRequest` events targeted at your router address.

**2. Mint a Test Agent**

Since validation requests enforce exact agent ownership, you must own an Agent NFT on the IdentityRegistry. Run this quick script to mint an agent to your deployer wallet:

```bash
npx tsx scripts/mint-agent.ts
```

**3. Submit a request**

```bash
npm run submit-request -- --agentId 1 --payloadFile ./examples/swap-request.json
```

This hashes the payload, stores it locally, and calls `validationRequest` on-chain. The Router should pick it up and respond within a block or two.

**4. Check the trust snapshot**

```bash
npm run trust-snapshot -- --agentId 1
# filter by tag or validator if you want
npm run trust-snapshot -- --agentId 1 --tag swap@1
npm run trust-snapshot -- --agentId 1 --validator 0xROUTER_ADDRESS
```

Or hit the REST API:

```bash
npm run server
curl http://localhost:3000/trust/1
curl "http://localhost:3000/trust/1?tag=swap@1"
```

Response looks like:

```json
{
  "agentId": 1,
  "agentRegistry": "eip155:84532:0x056a3452...",
  "validation": {
    "totalRequests": 1,
    "scoredRequests": 1,
    "averageScore": 90,
    "history": [
      { "requestHash": "0x870bd3d80fc5e5bfc729ab9e6509a207c791cbb2b9c9b3e510b1de8f295c14a1", "score": 90, "tag": "swap@1", "lastUpdate": "..." }
    ]
  },
  "reputation": {
    "feedbackCount": 0,
    "scoreFormatted": "N/A"
  },
  "snapshotAt": "..."
}
```

### Live Testnet Execution Logs
During our end-to-end testing on Base Sepolia, the following transactions and outputs were recorded:

**1. Submitting the Validation Request**
```
Validation request submitted!
  Tx hash:      0x959ffc4792565c15bb16d257ae1583c0c52879a659dd8e70a3e59eb875796e18
  requestHash:  0x870bd3d80fc5e5bfc729ab9e6509a207c791cbb2b9c9b3e510b1de8f295c14a1
```
**View on BaseScan:** [0x959ffc47...](https://sepolia.basescan.org/tx/0x959ffc4792565c15bb16d257ae1583c0c52879a659dd8e70a3e59eb875796e18)

**2. Router Processing the Request**
```
[Router] Processing request 0x870bd3d80fc5e5bfc729ab9e6509a207c791cbb2b9c9b3e510b1de8f295c14a1 for agent 1
[Router] Running 2 verifier(s) for kind "swap@1"
[Router]   mandate-integrity: score=80
[Router]   swap-receipt: score=100
[Router] Final score: 90/100
[Router] validationResponse submitted. Tx: 0xcdefb33d616fbdd3fcc42e404612d4f571c30dc8c600983a7f87cf5d93fca48b
```
**View on BaseScan:** [0xcdefb33d...](https://sepolia.basescan.org/tx/0xcdefb33d616fbdd3fcc42e404612d4f571c30dc8c600983a7f87cf5d93fca48b)

**3. Trust Snapshot Verification**
```
  Total requests:   1
  Scored requests:  1
  Average score:    90/100
  Score history (newest first):
    [2026-03-29T19:03:52.000Z] 0x870bd3d8... score=90  tag="swap@1"
```

---

## Scoring

Two verifiers run for `swap@1`, each contributing equally to the final score.

**Mandate Integrity** checks the mandate itself regardless of kind:

| Check | Points |
|-------|--------|
| Required fields present | 20 |
| Deadline is in the future | 20 |
| Client EIP-712 signature | 30 |
| Server EIP-712 signature | 30 |

The EIP-712 type being signed:

```json
{
  "MandateCore": [
    { "name": "kind",        "type": "string"  },
    { "name": "deadline",    "type": "uint256" },
    { "name": "payloadHash", "type": "bytes32" }
  ]
}
```

`payloadHash = keccak256(JSON.stringify(core.payload))` — keeps large payloads off the typed data while still committing to them.

**Swap@1 Receipt** checks execution against what was agreed in the mandate:

| Check | Points | Field checked |
|-------|--------|---------------|
| receipt.kind | 10 | `core.kind` |
| Chain ID | 10 | `core.payload.chainId` |
| tokenIn | 10 | `core.payload.tokenIn` |
| tokenOut | 10 | `core.payload.tokenOut` |
| amountIn within ±10 bps | 20 | `core.payload.amountIn` |
| amountOut ≥ min | 20 | `core.payload.minAmountOut` |
| Slippage within limit | 10 | `core.payload.maxSlippageBps` |
| Executed before deadline | 10 | `core.payload.deadline` |

Final score = `Math.round(mean(verifier scores))`.

---

## Sybil resistance

Three layers, all on by default:

- **Age gate** — rejects agents whose NFT is younger than `SYBIL_MIN_AGENT_AGE_BLOCKS` (default: 100 blocks)
- **Rate limiting** — `SYBIL_MAX_REQUESTS_PER_WINDOW` requests per agent per rolling window
- **Replay protection** — nonce derived from `keccak256(agentId + clientSig + serverSig)`, so the exact same (mandate, receipt) pair can't be re-scored

The guard state is in-memory right now, so it resets on restart. Good enough for a prototype; you'd want Redis or a DB in production.

---

## Adding a new verifier

Implement `IVerifier` and register it in the Router:

```typescript
// src/verifiers/myVerifier.ts
export class MyVerifier implements IVerifier {
  readonly id = "my-verifier";
  readonly supportedKinds = ["my-primitive@1"]; // or ["*"] for all kinds

  async verify(payload: ValidationRequestPayload): Promise<VerifierResult> {
    const notes = [];
    let score = 0;
    // score against payload.mandate.core.payload
    return { verifierId: this.id, score, notes };
  }
}

// src/router/router.ts — inside the Router constructor:
this.registerVerifier(new MyVerifier());
```

Then add tests in `test/myVerifier.test.ts` — the existing tests are a good template.

## Adding a new primitive (core.kind)

1. Add the payload type to `src/types/mandate.ts` and add it to the `PrimitivePayload` union
2. Write a receipt verifier for it with `supportedKinds = ["your-kind@1"]`
3. Define a receipt type and add it to `ActionReceipt`

The Router dispatches by `mandate.core.kind` automatically, so nothing else needs changing.

---

## Tests

```bash
npm test
```

Runs fully offline — no RPC or private key needed.

---

## Project layout

```
vp-validation-layer/
├── erc-8004-contracts/    <-- (On-chain Registries)
├── src/
│   ├── types/
│   │   ├── mandate.ts
│   │   └── verifier.ts
│   ├── verifiers/
│   │   ├── mandateIntegrity.ts
│   │   └── swapReceipt.ts
│   ├── router/
│   │   └── router.ts
│   ├── registry/
│   │   └── client.ts
│   ├── reputation/
│   │   └── trust.ts
│   ├── sybil/
│   │   └── guard.ts
│   ├── store/
│   │   └── responseStore.ts
│   ├── server.ts
│   └── index.ts
├── scripts/
│   ├── demo.ts
│   ├── mint-agent.ts
│   ├── submit-request.ts
│   └── trust-snapshot.ts
├── test/
│   ├── mandateIntegrity.test.ts
│   ├── swapReceipt.test.ts
│   └── router.test.ts
├── abis/
│   ├── ValidationRegistry.json
│   ├── IdentityRegistry.json
│   └── ReputationRegistry.json
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## A few things to be aware of

- `ROUTER_PRIVATE_KEY` must match the `validatorAddress` used in every `validationRequest` call — the contract will reject responses from any other address
- Mandate signatures use EIP-712 with domain separation (`name`, `version`, `chainId`), so they can't be replayed across chains or apps
- `requestHash` verification means an attacker can't swap out the payload after it's been committed on-chain
- The sybil guard store is in-memory — see note above about production use
