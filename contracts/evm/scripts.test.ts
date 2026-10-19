// Each deploy script must target the chain id of its registry network, and no
// script may fix a token or a new role address: the factory serves any ERC-20,
// and the registrar, fee recipient and identity authority come from the
// environment (Base alone defaults to the published Base fee recipient).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ESCROW_NETWORKS } from "../../src/lib/escrow-policy.mjs";
import { BASE_PLATFORM_FEE_RECIPIENT } from "../../src/lib/platform-fee-recipients.mjs";

const read = (file: string) =>
  readFileSync(`contracts/evm/script/${file}`, "utf8");
const SCRIPTS = {
  "DeployBase.s.sol": ["base-mainnet", "true"],
  "DeployBaseSepolia.s.sol": ["base-sepolia", "false"],
  "DeployRobinhood.s.sol": ["robinhood-mainnet", "false"],
  "DeployRobinhoodTestnet.s.sol": ["robinhood-testnet", "false"],
  "DeployEthereum.s.sol": ["ethereum", "false"],
  "DeployEthereumSepolia.s.sol": ["ethereum-sepolia", "false"],
} as const;

describe("deploy scripts match the registry", () => {
  for (const [file, [network, baseDefault]] of Object.entries(SCRIPTS)) {
    test(`${file} deploys only to ${network}`, () => {
      const source = read(file);
      expect(source).toContain(
        `return deploy(${ESCROW_NETWORKS[network].chainId}, ${baseDefault});`,
      );
      expect(source).not.toMatch(/0x[0-9a-fA-F]{40}/);
    });
  }
  test("roles come from the environment; only Base has a default fee recipient", () => {
    const shared = read("DeployEscrowFactory.sol");
    for (const key of [
      'envAddress("ESCROW_REGISTRAR")',
      'envAddress("ESCROW_IDENTITY_AUTHORITY")',
      'envAddress("ESCROW_FEE_RECIPIENT")',
      'envOr("ESCROW_FEE_RECIPIENT", BASE_PUBLISHED_FEE_RECIPIENT)',
    ])
      expect(shared).toContain(key);
    const addresses = shared.match(/0x[0-9a-fA-F]{40}/g) ?? [];
    expect(addresses.map((value) => value.toLowerCase())).toEqual([
      BASE_PLATFORM_FEE_RECIPIENT,
    ]);
  });
});
