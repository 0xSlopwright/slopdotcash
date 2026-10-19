// Mainnet payout execution stays off per network until a reviewed change.
import { describe, expect, test } from "bun:test";
import { ESCROW_NETWORKS } from "../../src/lib/escrow-policy.mjs";
import {
  MAINNET_EXECUTION,
  mainnetExecutionEnabled,
} from "./mainnet-execution.mjs";

describe("MAINNET_EXECUTION", () => {
  test("lists every registry mainnet, and every value is off", () => {
    const mainnets = Object.entries(ESCROW_NETWORKS)
      .filter(([, network]) => !network.testnet)
      .map(([name]) => name)
      .sort();
    for (const name of mainnets)
      expect(Object.hasOwn(MAINNET_EXECUTION, name)).toBe(true);
    expect(Object.values(MAINNET_EXECUTION).every((v) => v === false)).toBe(
      true,
    );
    for (const name of [...mainnets, "anvil", "toString", "__proto__"])
      expect(mainnetExecutionEnabled(name)).toBe(false);
  });
});
