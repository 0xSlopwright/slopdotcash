// Explorer links per network; unknown networks stay null.
import { describe, expect, test } from "bun:test";
import { transactionUrl } from "./contracts";

describe("transactionUrl", () => {
  test("Robinhood Chain uses Blockscout", () => {
    expect(transactionUrl("robinhood-mainnet", "0xab")).toBe(
      "https://robinhoodchain.blockscout.com/tx/0xab",
    );
    expect(transactionUrl("robinhood-testnet", "0xab")).toBe(
      "https://explorer.testnet.chain.robinhood.com/tx/0xab",
    );
  });
  test("Base, Solana and unknown networks are unchanged", () => {
    expect(transactionUrl("base-mainnet", "0xab")).toBe(
      "https://basescan.org/tx/0xab",
    );
    expect(transactionUrl("solana-devnet", "sig")).toBe(
      "https://explorer.solana.com/tx/sig?cluster=devnet",
    );
    expect(transactionUrl("anvil", "0xab")).toBeNull();
    expect(transactionUrl("robinhood-mainnet", null)).toBeNull();
  });
});
