// Family and registry invariants for the escrow network registry. The
// registry is the only place a chain maps to an execution family; nothing
// downstream may infer "EVM" from the word "base".
import { describe, expect, test } from "bun:test";
import {
  assertEscrowPolicy,
  chainFamily,
  ESCROW_CHAINS,
  ESCROW_NETWORKS,
  EVM_CHAINS,
  isEscrowChain,
} from "../../src/lib/escrow-policy.mjs";

const evmDeployment = {
  network: "base-sepolia",
  vault: "0x1000000000000000000000000000000000000001",
  programId: null,
  upgradeAuthority: null,
  projectPda: null,
  networkDomain: null,
  asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  owner: "0x2000000000000000000000000000000000000002",
  identityAuthority: "0x3000000000000000000000000000000000000003",
  feeRecipient: "0x4000000000000000000000000000000000000004",
  deploymentTransaction: `0x${"ab".repeat(32)}`,
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  codeSha256: "ab".repeat(32),
  bindingDelaySeconds: "60",
  rotationDelaySeconds: null,
  factory: "0x5000000000000000000000000000000000000005",
  factoryCodeSha256: "cd".repeat(32),
  registrar: "0x6000000000000000000000000000000000000006",
};
const solanaDeployment = {
  network: "solana-devnet",
  vault: "So11111111111111111111111111111111111111112",
  programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  upgradeAuthority: null,
  projectPda: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  networkDomain: "cd".repeat(32),
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  owner: "11111111111111111111111111111111",
  identityAuthority: "SysvarRent111111111111111111111111111111111",
  feeRecipient: "SysvarC1ock11111111111111111111111111111111",
  deploymentTransaction: "1".repeat(64),
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  codeSha256: "ab".repeat(32),
  bindingDelaySeconds: "60",
  rotationDelaySeconds: "60",
  factory: null,
  factoryCodeSha256: null,
  registrar: null,
};
const robinhoodDeployment = {
  ...evmDeployment,
  network: "robinhood-testnet",
  asset: "0x7e955252e15c84f5768b83c41a71f9eba181802f",
};
const policy = (chain: string, deployment: object) => ({
  schemaVersion: "1",
  effectiveCycle: "2026-11",
  chain,
  feeBasisPoints: 200,
  withdrawalFeeBasisPoints: 1000,
  feeMode: "deduct-from-gross",
  deployments: [deployment],
});

describe("escrow chain families", () => {
  test("each chain maps to exactly one family", () => {
    expect([...ESCROW_CHAINS]).toEqual(["base", "solana", "robinhood"]);
    expect(chainFamily("base")).toBe("evm");
    expect(chainFamily("solana")).toBe("solana");
    expect(chainFamily("robinhood")).toBe("evm");
    expect([...EVM_CHAINS]).toEqual(["base", "robinhood"]);
  });
  test("an unknown chain is rejected, never defaulted to a family", () => {
    expect(isEscrowChain("evm")).toBe(false);
    expect(isEscrowChain("BASE")).toBe(false);
    expect(isEscrowChain(undefined)).toBe(false);
    expect(() => chainFamily("evm")).toThrow(TypeError);
    expect(() => chainFamily("BASE")).toThrow(TypeError);
  });
  test("EVM networks carry chain id, gas ceiling and scan page; Solana networks carry none", () => {
    for (const network of Object.values(ESCROW_NETWORKS)) {
      expect(chainFamily(network.chain)).toBe(network.family);
      expect(typeof network.assetSymbol).toBe("string");
      expect(network.assetSymbol.length).toBeGreaterThan(0);
      if (network.family === "evm") {
        expect(network.chainId).toMatch(/^[1-9][0-9]*$/);
        expect(network.gasCeiling).toMatch(/^[1-9][0-9]*$/);
        expect(network.scanPageBlocks).toMatch(/^[1-9][0-9]*$/);
      } else {
        expect(network.chainId).toBeUndefined();
        expect(network.gasCeiling).toBeUndefined();
        expect(network.scanPageBlocks).toBeUndefined();
      }
    }
  });
  test("Base keeps its executor and scanner limits", () => {
    for (const name of ["base-sepolia", "base-mainnet"] as const) {
      expect(ESCROW_NETWORKS[name].gasCeiling).toBe("500000");
      expect(ESCROW_NETWORKS[name].scanPageBlocks).toBe("2000");
      expect(ESCROW_NETWORKS[name].assetSymbol).toBe("USDC");
    }
    expect(ESCROW_NETWORKS["solana-testnet"].assetSymbol).toBe("TEST");
  });
  test("Robinhood Chain carries its own limits, chain ids and USDG", () => {
    const testnet = ESCROW_NETWORKS["robinhood-testnet"];
    const mainnet = ESCROW_NETWORKS["robinhood-mainnet"];
    expect(testnet).toEqual({
      chain: "robinhood",
      family: "evm",
      testnet: true,
      chainId: "46630",
      asset: "0x7e955252e15c84f5768b83c41a71f9eba181802f",
      assetSymbol: "USDG",
      gasCeiling: "2000000",
      scanPageBlocks: "9000",
    });
    expect(mainnet).toEqual({
      chain: "robinhood",
      family: "evm",
      testnet: false,
      chainId: "4663",
      asset: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      assetSymbol: "USDG",
      gasCeiling: "2000000",
      scanPageBlocks: "9000",
    });
    // Under the common 10,000-block eth_getLogs provider limit (spec section 4).
    expect(Number(mainnet.scanPageBlocks)).toBeLessThan(10_000);
  });
});

describe("assertEscrowPolicy after the family refactor", () => {
  test("accepts a reviewed Base deployment", () => {
    expect(() =>
      assertEscrowPolicy(policy("base", evmDeployment)),
    ).not.toThrow();
  });
  test("accepts a reviewed Solana deployment", () => {
    expect(() =>
      assertEscrowPolicy(policy("solana", solanaDeployment)),
    ).not.toThrow();
  });
  test("rejects a family name used as a chain", () => {
    expect(() => assertEscrowPolicy(policy("evm", evmDeployment))).toThrow(
      /Invalid escrow chain/,
    );
  });
  test("rejects Solana-only fields on an EVM deployment", () => {
    expect(() =>
      assertEscrowPolicy(
        policy("base", { ...evmDeployment, programId: evmDeployment.vault }),
      ),
    ).toThrow(/does not match the network/);
  });
  test("rejects an EVM transaction hash on a Solana deployment", () => {
    expect(() =>
      assertEscrowPolicy(
        policy("solana", {
          ...solanaDeployment,
          deploymentTransaction: `0x${"ab".repeat(32)}`,
        }),
      ),
    ).toThrow(/immutable source and transaction evidence/);
  });
  test("accepts a reviewed Robinhood Chain testnet deployment", () => {
    expect(() =>
      assertEscrowPolicy(policy("robinhood", robinhoodDeployment)),
    ).not.toThrow();
  });
  test("a mainnet Robinhood Chain deployment must name USDG", () => {
    expect(() =>
      assertEscrowPolicy(
        policy("robinhood", {
          ...robinhoodDeployment,
          network: "robinhood-mainnet",
          bindingDelaySeconds: "172800",
        }),
      ),
    ).toThrow(/does not match the network/);
    expect(() =>
      assertEscrowPolicy(
        policy("robinhood", {
          ...robinhoodDeployment,
          network: "robinhood-mainnet",
          bindingDelaySeconds: "172800",
          asset: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        }),
      ),
    ).not.toThrow();
  });
  test("a Base network cannot sit on a Robinhood Chain policy", () => {
    expect(() =>
      assertEscrowPolicy(policy("robinhood", evmDeployment)),
    ).toThrow(/one chain and one escrow per network/);
  });
  test("rejects an owner who is also the fee recipient", () => {
    // The payout fee flows to the fee recipient, so the owner must not
    // collect it: "Escrow authorities must have separate roles".
    expect(() =>
      assertEscrowPolicy(
        policy("base", { ...evmDeployment, feeRecipient: evmDeployment.owner }),
      ),
    ).toThrow(/separate roles/);
  });
  test("rejects an identity authority who is also the fee recipient", () => {
    expect(() =>
      assertEscrowPolicy(
        policy("base", {
          ...evmDeployment,
          feeRecipient: evmDeployment.identityAuthority,
        }),
      ),
    ).toThrow(/separate roles/);
  });
});
