// Manifest rules for Robinhood Chain: escrow only, USDG only, no direct address.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertProjectDefinition } from "./project-schema.mjs";

const eliza = JSON.parse(
  readFileSync("tests/fixtures/projects/eliza.json", "utf8"),
);
const evm = "0x8f77c37d8650776bfe73c9b12b15209ee15d9b86";
// Same keys as the reviewed `evmDeployment` in workers/payments/escrow-policy.test.ts.
const deployment = {
  network: "robinhood-testnet",
  vault: "0x1000000000000000000000000000000000000001",
  programId: null,
  upgradeAuthority: null,
  projectPda: null,
  networkDomain: null,
  asset: "0x7e955252e15c84f5768b83c41a71f9eba181802f",
  owner: evm,
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

// Same keys as the generated escrow block in src/ProjectProposalPage.tsx.
function manifest() {
  return {
    ...eliza,
    reward: {
      ...eliza.reward,
      chain: "robinhood",
      currency: "USDG",
      feeBasisPoints: 200,
    },
    escrow: {
      schemaVersion: "1",
      effectiveCycle: "2026-11",
      chain: "robinhood",
      feeBasisPoints: 200,
      withdrawalFeeBasisPoints: 500,
      feeMode: "deduct-from-gross",
      deployments: [deployment],
    },
  };
}

describe("Robinhood Chain manifests", () => {
  test("an escrow project on Robinhood Chain settles in USDG", () => {
    expect(() => assertProjectDefinition(manifest())).not.toThrow();
  });
  test("USDC on Robinhood Chain is inconsistent", () => {
    const m = manifest();
    expect(() =>
      assertProjectDefinition({
        ...m,
        reward: { ...m.reward, currency: "USDC" },
      }),
    ).toThrow(/monthly pool policy is inconsistent/);
  });
  test("a direct funding address on Robinhood Chain is refused", () => {
    const m = manifest();
    expect(() =>
      assertProjectDefinition({
        ...m,
        funding: {
          ...m.funding,
          addresses: [
            {
              network: "robinhood",
              asset: "USDG",
              address: evm,
              effectiveAt: "2026-10-01T00:00:00.000Z",
              replacedAt: null,
            },
          ],
        },
      }),
    ).toThrow(/direct funding address is not supported/);
  });
  test("the legacy rail does not reach Robinhood Chain", () => {
    const { escrow: _escrow, ...legacy } = manifest();
    expect(() =>
      assertProjectDefinition({
        ...legacy,
        reward: { ...legacy.reward, feeBasisPoints: 100 },
      }),
    ).toThrow(/monthly pool policy is inconsistent/);
  });
});
