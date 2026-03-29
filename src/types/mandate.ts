/**
 * Mandate types for ERC-8004 Validation Layer
 *
 * A Mandate is a signed agreement between a client and a server (agent)
 * that describes the task to be performed.  The Router verifies mandates
 * and dispatches them to primitive-specific verifiers keyed on core.kind.
 *
 * Naming convention:  kind strings follow the pattern  <primitive>@<version>
 * e.g. "swap@1", "transfer@1", "inference@1"
 */

// ── Swap primitive payload (kind = "swap@1") ─────────────────────────────────

export interface SwapPayload {
  /** ERC-20 token address being sold */
  tokenIn: string;
  /** ERC-20 token address being bought */
  tokenOut: string;
  /** Exact amount sold, in tokenIn's smallest unit (uint256 as string) */
  amountIn: string;
  /** Minimum acceptable amount received, in tokenOut's smallest unit */
  minAmountOut: string;
  /** Maximum allowed slippage in basis points (1 bps = 0.01%). e.g. 50 = 0.5% */
  maxSlippageBps: number;
  /** EVM chain where the swap executes */
  chainId: number;
  /** Unix timestamp after which this mandate is invalid */
  deadline: number;
}

// ── Union of all known primitive payloads ────────────────────────────────────

export type PrimitivePayload = SwapPayload;

// ── Mandate core (the signed portion) ────────────────────────────────────────

export interface MandateCore {
  /**
   * Identifies the primitive and its schema version.
   * Format: "<primitive>@<version>"   e.g. "swap@1"
   */
  kind: string;
  /** Unix timestamp after which the mandate expires */
  deadline: number;
  /** Primitive-specific fields; shape is determined by `kind` */
  payload: PrimitivePayload;
}

// ── Full Mandate ──────────────────────────────────────────────────────────────

export interface Mandate {
  core: MandateCore;
  /** Ethereum address of the party requesting the task */
  clientAddress: string;
  /** Ethereum address of the agent that accepted the task */
  serverAddress: string;
  /**
   * EIP-712 signature over MandateCore by the client.
   * Covers: kind, deadline, keccak256(JSON.stringify(payload))
   */
  clientSig: string;
  /**
   * EIP-712 signature over MandateCore by the server/agent.
   * Same type hash as clientSig.
   */
  serverSig: string;
  /** Chain ID used in the EIP-712 domain separator */
  chainId: number;
}

// ── EIP-712 domain + types used for mandate signing ──────────────────────────

export const MANDATE_DOMAIN_NAME = "MandateProtocol";
export const MANDATE_DOMAIN_VERSION = "1";

export const MANDATE_TYPES: Record<string, { name: string; type: string }[]> = {
  MandateCore: [
    { name: "kind", type: "string" },
    { name: "deadline", type: "uint256" },
    { name: "payloadHash", type: "bytes32" },
  ],
};

// ── Action Receipt ────────────────────────────────────────────────────────────

/**
 * Submitted by the agent as evidence that it executed the mandated task.
 * For swap@1 this is the on-chain swap transaction.
 */
export interface SwapReceipt {
  kind: "swap@1";
  /** Transaction hash on the execution chain */
  txHash: string;
  /** Chain where the swap was executed */
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  /** Actual amount spent (uint256 as string) */
  amountIn: string;
  /** Actual amount received (uint256 as string) */
  amountOut: string;
  /** Unix timestamp of the swap transaction */
  executedAt: number;
  /** DEX/router address used */
  routerAddress?: string;
}

export type ActionReceipt = SwapReceipt;

// ── Validation Request Payload ────────────────────────────────────────────────

/**
 * The off-chain JSON payload stored at requestURI.
 * Its keccak256 hash is the requestHash committed on-chain.
 */
export interface ValidationRequestPayload {
  /** ERC-8004 agentId (ERC-721 tokenId) */
  agentId: number;
  /**
   * Fully-qualified agent registry identifier.
   * Format: "{namespace}:{chainId}:{identityRegistry}"
   * e.g. "eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e"
   */
  agentRegistry: string;
  /** Full mandate including signatures */
  mandate: Mandate;
  /** Execution evidence for the mandated task */
  receipt: ActionReceipt;
  /** ISO-8601 timestamp when the request was created */
  createdAt: string;
}
