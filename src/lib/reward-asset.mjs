/**
 * The one reward asset a project pays in: a network and either that
 * network's reviewed stablecoin or one standard token (ERC-20 or classic SPL
 * mint). The manifest stores the chain identity, address, symbol and decimals
 * as display metadata. The server reads decimals from chain once, when the
 * asset is submitted or changed; page views never read chain.
 */

import { isFundingAddress } from "./funding-address.mjs";

/** Reviewed mainnet identities; the stablecoin rows match ESCROW_NETWORKS. */
export const REWARD_ASSET_NETWORKS = Object.freeze({
  base: Object.freeze({
    name: "Base",
    family: "evm",
    chainId: "8453",
    cluster: null,
    stablecoin: Object.freeze({
      address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      symbol: "USDC",
      decimals: 6,
    }),
  }),
  ethereum: Object.freeze({
    name: "Ethereum",
    family: "evm",
    chainId: "1",
    cluster: null,
    stablecoin: Object.freeze({
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      decimals: 6,
    }),
  }),
  robinhood: Object.freeze({
    name: "Robinhood Chain",
    family: "evm",
    chainId: "4663",
    cluster: null,
    stablecoin: Object.freeze({
      address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      symbol: "USDG",
      decimals: 6,
    }),
  }),
  solana: Object.freeze({
    name: "Solana",
    family: "solana",
    chainId: null,
    cluster: "mainnet-beta",
    stablecoin: Object.freeze({
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      decimals: 6,
    }),
  }),
});

export const REWARD_ASSET_NETWORK_IDS = Object.freeze(
  Object.keys(REWARD_ASSET_NETWORKS),
);

const SYMBOL = /^[A-Za-z0-9$._-]{1,16}$/u;
export const MAX_REWARD_ASSET_DECIMALS = 36;

export function isRewardAssetNetwork(value) {
  return Object.hasOwn(REWARD_ASSET_NETWORKS, value);
}

/** Lowercases EVM addresses; Solana mints are case-sensitive base58. */
export function canonicalRewardAssetAddress(network, value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const definition = REWARD_ASSET_NETWORKS[network];
  if (!definition) return null;
  const canonical =
    definition.family === "evm" ? trimmed.toLowerCase() : trimmed;
  return isFundingAddress(network, canonical) ? canonical : null;
}

/** The unverified part of an asset choice: what a maintainer enters. */
export function rewardAssetChoice(network, kind, address, symbol) {
  const definition = REWARD_ASSET_NETWORKS[network];
  if (!definition) throw new TypeError("Choose a supported reward network");
  if (kind === "stablecoin") {
    return {
      network,
      kind,
      address: definition.stablecoin.address,
      symbol: definition.stablecoin.symbol,
    };
  }
  if (kind !== "token") throw new TypeError("Choose stablecoin or token");
  const canonical = canonicalRewardAssetAddress(network, address);
  if (canonical === null)
    throw new TypeError(
      definition.family === "evm"
        ? "Enter a 0x token contract address with 40 hexadecimal characters"
        : "Enter a base58 SPL mint address",
    );
  if (canonical === definition.stablecoin.address)
    throw new TypeError(
      `That address is the network stablecoin; choose ${definition.stablecoin.symbol}`,
    );
  if (typeof symbol !== "string" || !SYMBOL.test(symbol.trim()))
    throw new TypeError("Enter a token symbol of 1 to 16 letters or digits");
  return { network, kind, address: canonical, symbol: symbol.trim() };
}

/**
 * Validates a stored reward asset. Throws a TypeError naming the field.
 */
export function assertRewardAsset(value, field = "project.rewardAsset") {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${field} must be an object`);
  const keys = [
    "address",
    "chainId",
    "cluster",
    "decimals",
    "kind",
    "network",
    "symbol",
    "verifiedAt",
  ];
  if (Object.keys(value).sort().join("\0") !== keys.join("\0"))
    throw new TypeError(`${field} has unexpected or missing fields`);
  const definition = REWARD_ASSET_NETWORKS[value.network];
  if (!definition) throw new TypeError(`${field}.network is unsupported`);
  if (
    value.chainId !== definition.chainId ||
    value.cluster !== definition.cluster
  )
    throw new TypeError(`${field} chain identity does not match its network`);
  if (
    canonicalRewardAssetAddress(value.network, value.address) !== value.address
  )
    throw new TypeError(`${field}.address is not a canonical address`);
  if (
    !Number.isSafeInteger(value.decimals) ||
    value.decimals < 0 ||
    value.decimals > MAX_REWARD_ASSET_DECIMALS
  )
    throw new TypeError(`${field}.decimals is invalid`);
  if (typeof value.symbol !== "string" || !SYMBOL.test(value.symbol))
    throw new TypeError(`${field}.symbol is invalid`);
  if (
    typeof value.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(value.verifiedAt)) ||
    new Date(value.verifiedAt).toISOString() !== value.verifiedAt
  )
    throw new TypeError(`${field}.verifiedAt is invalid`);
  const stablecoin = definition.stablecoin;
  if (value.kind === "stablecoin") {
    if (
      value.address !== stablecoin.address ||
      value.symbol !== stablecoin.symbol ||
      value.decimals !== stablecoin.decimals
    )
      throw new TypeError(`${field} is not the network stablecoin`);
  } else if (value.kind === "token") {
    if (value.address === stablecoin.address)
      throw new TypeError(`${field} names the network stablecoin as a token`);
  } else {
    throw new TypeError(`${field}.kind is invalid`);
  }
  return value;
}

/** True when two assets name the same chain object, so decimals carry over. */
export function sameRewardAsset(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.network === right.network &&
    left.kind === right.kind &&
    left.address === right.address
  );
}
