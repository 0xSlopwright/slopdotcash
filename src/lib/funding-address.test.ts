// Chain primitives for Robinhood Chain: USDG asset, EVM address rule.
import { describe, expect, test } from "bun:test";
import { ESCROW_CHAINS } from "./escrow-policy.mjs";
import {
  type FundingNetwork,
  fundingAssetForNetwork,
  isFundingAddress,
} from "./funding-address.mjs";
import { WALLET_CHAINS } from "./wallets";

const evm = "0x8f77c37d8650776bfe73c9b12b15209ee15d9b86";

describe("funding address primitives", () => {
  test("Robinhood Chain settles in USDG; Base and Solana stay USDC", () => {
    expect(fundingAssetForNetwork("robinhood")).toBe("USDG");
    expect(fundingAssetForNetwork("base")).toBe("USDC");
    expect(fundingAssetForNetwork("solana")).toBe("USDC");
    expect(fundingAssetForNetwork("evm")).toBeNull();
  });
  test("Robinhood Chain addresses follow the EVM rule", () => {
    expect(isFundingAddress("robinhood", evm)).toBe(true);
    expect(isFundingAddress("robinhood", evm.toUpperCase())).toBe(false);
    expect(isFundingAddress("robinhood", `0x${"0".repeat(40)}`)).toBe(false);
    expect(
      isFundingAddress(
        "robinhood",
        "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
      ),
    ).toBe(false);
    expect(isFundingAddress("evm" as unknown as FundingNetwork, evm)).toBe(
      false,
    );
  });
  test("every wallet chain is an escrow chain", () => {
    expect(new Set(WALLET_CHAINS)).toEqual(new Set(ESCROW_CHAINS));
  });
});
