/**
 * Fee-converter configuration. Every value comes from Worker vars or secrets;
 * a missing or malformed value refuses the network instead of guessing.
 */

export type Network = "base" | "ethereum" | "robinhood" | "solana";
export type Mode = "off" | "dry_run" | "live";

export const NETWORKS: readonly Network[] = [
  "base",
  "ethereum",
  "robinhood",
  "solana",
];

export interface NetworkDefinition {
  family: "evm" | "solana";
  /** EVM chain id, or null for Solana. */
  chainId: number | null;
  /** Escrow deployment network keys whose assets count as this network's reward assets. */
  escrowNetworks: readonly string[];
  /** The approved network stablecoin (PRD FND-02). All have 6 decimals. */
  stablecoin: string;
  stablecoinSymbol: "USDC" | "USDG";
  defaultRpcUrl: string;
  /** KyberSwap Aggregator chain slug; null for Solana. */
  kyberChain: string | null;
  /** The only contract an EVM swap may call and the only approval spender. */
  router: string | null;
}

/**
 * Stablecoin identities: Base and Solana USDC and Robinhood USDG match
 * src/lib/escrow-policy.mjs. Ethereum USDC is Circle's published mainnet
 * contract. Robinhood Chain has no Circle USDC; tokens named "USDC" there are
 * unrelated clones, so its target stays Paxos USDG.
 */
export const NETWORK_DEFINITIONS: Readonly<Record<Network, NetworkDefinition>> =
  Object.freeze({
    base: {
      family: "evm",
      chainId: 8453,
      escrowNetworks: ["base-mainnet"],
      stablecoin: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      stablecoinSymbol: "USDC",
      defaultRpcUrl: "https://mainnet.base.org",
      kyberChain: "base",
      router: "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
    },
    ethereum: {
      family: "evm",
      chainId: 1,
      escrowNetworks: ["ethereum"],
      stablecoin: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      stablecoinSymbol: "USDC",
      defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
      kyberChain: "ethereum",
      router: "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
    },
    robinhood: {
      family: "evm",
      chainId: 4663,
      escrowNetworks: ["robinhood-mainnet"],
      stablecoin: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      stablecoinSymbol: "USDG",
      defaultRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
      kyberChain: "robinhood",
      router: "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
    },
    solana: {
      family: "solana",
      chainId: null,
      escrowNetworks: ["solana-mainnet"],
      stablecoin: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      stablecoinSymbol: "USDC",
      defaultRpcUrl: "https://api.mainnet-beta.solana.com",
      kyberChain: null,
      router: null,
    },
  });

export interface FeeConverterEnv {
  FEE_CONVERTER_MODE?: string;
  FEE_CONVERTER_NETWORKS?: string;
  FEE_CONVERTER_ALLOWLIST?: string;
  FEE_CONVERTER_MIN_VALUE_MICRO?: string;
  FEE_CONVERTER_GAS_MULTIPLE?: string;
  FEE_CONVERTER_MAX_SLIPPAGE_BPS?: string;
  FEE_CONVERTER_MAX_PRICE_IMPACT_BPS?: string;
  FEE_CONVERTER_RUN_CAP_MICRO?: string;
  FEE_CONVERTER_DAILY_CAP_MICRO?: string;
  FEE_CONVERTER_SOLANA_FEE_MICRO?: string;
  FEE_WALLET_BASE?: string;
  FEE_WALLET_ETHEREUM?: string;
  FEE_WALLET_ROBINHOOD?: string;
  FEE_WALLET_SOLANA?: string;
  RPC_URL_BASE?: string;
  RPC_URL_ETHEREUM?: string;
  RPC_URL_ROBINHOOD?: string;
  RPC_URL_SOLANA?: string;
  KYBERSWAP_CLIENT_ID?: string;
  JUPITER_API_URL?: string;
  JUPITER_API_KEY?: string;
  /** Secrets. Never logged, never stored in D1, never set in CI. */
  FEE_WALLET_KEY_BASE?: string;
  FEE_WALLET_KEY_ETHEREUM?: string;
  FEE_WALLET_KEY_ROBINHOOD?: string;
  FEE_WALLET_KEY_SOLANA?: string;
}

export interface Limits {
  minValueMicro: bigint;
  gasMultiple: bigint;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  runCapMicro: bigint;
  dailyCapMicro: bigint;
  solanaFeeMicro: bigint;
}

export interface NetworkConfig {
  network: Network;
  definition: NetworkDefinition;
  feeWallet: string;
  rpcUrl: string;
  allowlist: string[];
}

export interface FeeConverterConfig {
  mode: Mode;
  networks: NetworkConfig[];
  limits: Limits;
  kyberClientId: string;
  jupiterApiUrl: string;
  jupiterApiKey: string | null;
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/u;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;

export function isTokenAddress(network: Network, value: unknown): boolean {
  if (typeof value !== "string") return false;
  return NETWORK_DEFINITIONS[network].family === "evm"
    ? EVM_ADDRESS.test(value)
    : SOLANA_ADDRESS.test(value);
}

/** Lowercases EVM addresses; Solana addresses are case-sensitive. */
export function normalizeToken(network: Network, value: string): string {
  return NETWORK_DEFINITIONS[network].family === "evm"
    ? value.toLowerCase()
    : value;
}

function integer(
  value: string | undefined,
  fallback: bigint,
  name: string,
): bigint {
  if (value === undefined || value === "") return fallback;
  if (!/^(0|[1-9][0-9]{0,30})$/u.test(value))
    throw new TypeError(`${name} must be a non-negative integer`);
  return BigInt(value);
}

function bps(value: string | undefined, fallback: number, name: string) {
  const parsed = integer(value, BigInt(fallback), name);
  if (parsed > 10_000n) throw new TypeError(`${name} must be at most 10000`);
  return Number(parsed);
}

const upper = (network: Network) => network.toUpperCase() as Uppercase<Network>;

export function parseConfig(env: FeeConverterEnv): FeeConverterConfig {
  const mode = (env.FEE_CONVERTER_MODE ?? "off").trim();
  if (mode !== "off" && mode !== "dry_run" && mode !== "live")
    throw new TypeError("FEE_CONVERTER_MODE must be off, dry_run or live");
  const enabled = (env.FEE_CONVERTER_NETWORKS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const name of enabled)
    if (!NETWORKS.includes(name as Network))
      throw new TypeError(`Unknown fee-converter network: ${name}`);
  let allowlist: Record<string, unknown> = {};
  if (env.FEE_CONVERTER_ALLOWLIST?.trim()) {
    const parsed: unknown = JSON.parse(env.FEE_CONVERTER_ALLOWLIST);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new TypeError("FEE_CONVERTER_ALLOWLIST must be a JSON object");
    allowlist = parsed as Record<string, unknown>;
    for (const key of Object.keys(allowlist))
      if (!NETWORKS.includes(key as Network))
        throw new TypeError(`Unknown allowlist network: ${key}`);
  }
  const networks = [...new Set(enabled as Network[])].map((network) => {
    const definition = NETWORK_DEFINITIONS[network];
    const feeWallet = env[`FEE_WALLET_${upper(network)}`]?.trim() ?? "";
    if (!isTokenAddress(network, feeWallet))
      throw new TypeError(`FEE_WALLET_${upper(network)} is not set or invalid`);
    const list = allowlist[network] ?? [];
    if (!Array.isArray(list) || !list.every((t) => isTokenAddress(network, t)))
      throw new TypeError(`Allowlist for ${network} has an invalid token`);
    const rpcUrl =
      env[`RPC_URL_${upper(network)}`]?.trim() || definition.defaultRpcUrl;
    if (!/^https?:\/\//u.test(rpcUrl))
      throw new TypeError(`RPC_URL_${upper(network)} must be an http(s) URL`);
    return {
      network,
      definition,
      feeWallet: normalizeToken(network, feeWallet),
      rpcUrl,
      allowlist: (list as string[]).map((t) => normalizeToken(network, t)),
    };
  });
  const jupiterApiKey = env.JUPITER_API_KEY?.trim() || null;
  return {
    mode,
    networks,
    limits: {
      minValueMicro: integer(
        env.FEE_CONVERTER_MIN_VALUE_MICRO,
        5_000_000n,
        "FEE_CONVERTER_MIN_VALUE_MICRO",
      ),
      gasMultiple: integer(
        env.FEE_CONVERTER_GAS_MULTIPLE,
        10n,
        "FEE_CONVERTER_GAS_MULTIPLE",
      ),
      maxSlippageBps: bps(
        env.FEE_CONVERTER_MAX_SLIPPAGE_BPS,
        100,
        "FEE_CONVERTER_MAX_SLIPPAGE_BPS",
      ),
      maxPriceImpactBps: bps(
        env.FEE_CONVERTER_MAX_PRICE_IMPACT_BPS,
        200,
        "FEE_CONVERTER_MAX_PRICE_IMPACT_BPS",
      ),
      runCapMicro: integer(
        env.FEE_CONVERTER_RUN_CAP_MICRO,
        1_000_000_000n,
        "FEE_CONVERTER_RUN_CAP_MICRO",
      ),
      dailyCapMicro: integer(
        env.FEE_CONVERTER_DAILY_CAP_MICRO,
        5_000_000_000n,
        "FEE_CONVERTER_DAILY_CAP_MICRO",
      ),
      solanaFeeMicro: integer(
        env.FEE_CONVERTER_SOLANA_FEE_MICRO,
        2_000n,
        "FEE_CONVERTER_SOLANA_FEE_MICRO",
      ),
    },
    kyberClientId: env.KYBERSWAP_CLIENT_ID?.trim() || "slop-fee-converter",
    jupiterApiUrl:
      env.JUPITER_API_URL?.trim() ||
      (jupiterApiKey
        ? "https://api.jup.ag/swap/v1"
        : "https://lite-api.jup.ag/swap/v1"),
    jupiterApiKey,
  };
}

/** Returns the signing secret for a network; undefined when not configured. */
export function networkKey(
  env: FeeConverterEnv,
  network: Network,
): string | undefined {
  const value = env[`FEE_WALLET_KEY_${upper(network)}`];
  return value?.trim() ? value.trim() : undefined;
}
