// A deploy script's token constant must equal the registry asset for its
// network, so a wrong address cannot be deployed from a stale script.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ESCROW_NETWORKS } from "../../src/lib/escrow-policy.mjs";

function constant(file: string, name: string): string {
  const source = readFileSync(`contracts/evm/script/${file}`, "utf8");
  const match = source.match(
    new RegExp(`address public constant ${name} = (0x[0-9a-fA-F]{40});`),
  );
  if (!match) throw new Error(`${file} has no ${name} constant`);
  return match[1].toLowerCase();
}

describe("deploy script constants match the registry", () => {
  test("Base mainnet USDC", () => {
    expect(constant("DeployBase.s.sol", "USDC")).toBe(
      ESCROW_NETWORKS["base-mainnet"].asset,
    );
  });
  test("Base Sepolia test USDC", () => {
    expect(constant("DeployBaseSepolia.s.sol", "TEST_USDC")).toBe(
      ESCROW_NETWORKS["base-sepolia"].asset,
    );
  });
  test("Robinhood Chain USDG", () => {
    expect(constant("DeployRobinhood.s.sol", "USDG")).toBe(
      ESCROW_NETWORKS["robinhood-mainnet"].asset,
    );
  });
  test("Robinhood Chain Testnet USDG", () => {
    expect(constant("DeployRobinhoodTestnet.s.sol", "TEST_USDG")).toBe(
      ESCROW_NETWORKS["robinhood-testnet"].asset,
    );
  });
  test("chain id guards name the registry chain ids", () => {
    const mainnet = readFileSync(
      "contracts/evm/script/DeployRobinhood.s.sol",
      "utf8",
    );
    const testnet = readFileSync(
      "contracts/evm/script/DeployRobinhoodTestnet.s.sol",
      "utf8",
    );
    expect(mainnet).toContain(
      `block.chainid == ${ESCROW_NETWORKS["robinhood-mainnet"].chainId},`,
    );
    expect(testnet).toContain(
      `block.chainid == ${ESCROW_NETWORKS["robinhood-testnet"].chainId},`,
    );
  });
});
