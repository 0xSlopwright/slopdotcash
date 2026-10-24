import { describe, expect, test } from "bun:test";
import { ESCROW_CHAINS } from "./escrow-policy.mjs";
import type { DirectTransfer } from "./payments/contracts";
import { isDirectTransfer } from "./use-direct-transfers";

const transfer = (chain: string): DirectTransfer =>
  ({
    projectId: "eliza",
    contributionMonth: "2026-11",
    githubUserId: "18633264",
    login: "lalalune",
    network: `${chain}-mainnet`,
    chain,
    recipient: "recipient",
    amountMicro: "2000000",
    transactionId: "transaction",
    blockTime: "2026-12-01T00:00:00.000Z",
  }) as DirectTransfer;

describe("direct transfer validation", () => {
  test("a transfer on any approved network is accepted, so one Ethereum or Robinhood row cannot fail the project set", () => {
    expect(ESCROW_CHAINS).toEqual(["base", "solana", "robinhood", "ethereum"]);
    for (const chain of ESCROW_CHAINS)
      expect(isDirectTransfer(transfer(chain))).toBe(true);
  });
  test("an unknown chain still fails closed", () => {
    expect(isDirectTransfer(transfer("polygon"))).toBe(false);
  });
});
