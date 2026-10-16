/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertRewardAllocationManifest,
  assertRewardSettlementManifest,
} from "../src/lib/rewards";
import {
  createSettlementExecutionPlan,
  type SettlementPlanTransfer,
  SOLANA_MAINNET_USDC_MINT,
} from "../src/lib/settlement-plan";
import { verifyRewardSettlementOnchain } from "../src/lib/solana-settlement";
import { prepareSquadsBatchHandoff } from "../src/lib/squads-batch-handoff";
import { deriveSquadsVaultAddress } from "../src/lib/squads-funding";
import { parseSettlementEvidence } from "./verify-settlement";

// A 2-of-2 vault plan ends with its fee transfer, and the Squads Batch
// handoff packs five transfers per child, so the fee shares the last child
// with contributor transfers unless the contributor count is a multiple of
// five. A single VaultTransaction always carries both. That one finalized
// transaction must be recordable as the contributor attempt and the fee.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}
const address = (seed: string) =>
  base58(createHash("sha256").update(`address-${seed}`).digest());
const signature = (seed: string) =>
  base58(createHash("sha512").update(`signature-${seed}`).digest());

const MULTISIG = "8WAca8hqqN3XfBGcvgX8mTEKTUQyVAHUNRtyCcbkPo3y";
const FEE_RECIPIENT = "BCvSJBLFVHvbEn5AfCw8SHfTXDJP6jGJ4PwM2JZyB1co";
const MEMBER = "Cvh7cQjy9y4bQFopRJ61BJVRSJLq92wLt85Kdt7eXAF";
const PROJECT_VAULT_MULTISIG = "8o2tb5h4xnYS66yMzTvrUiWPqqfmx3jHFVWCnnvFEz4N";
const PROJECT_VAULT = "5vdqwRwVvefAmFcA6qNvRK9fJbZywUgqr5X1GQ9n56e3";
const PLAN_CREATED_AT = "2026-10-14T07:00:00.000Z";
const BLOCK_TIME = Date.parse(PLAN_CREATED_AT) / 1_000 + 3_600;
const SETTLED_AT = "2026-10-14T09:00:00.000Z";
const VAULT = await deriveSquadsVaultAddress(MULTISIG, 0);

function buildAllocation(contributors: number, instrumentId: string) {
  const rows = Array.from({ length: contributors }, (_, index) => {
    const login = `contributor${index + 1}`;
    const commit = "ab".repeat(20);
    return {
      intentId: `pay_intent-${index + 1}`,
      actor: { id: `actor-${index + 1}`, login },
      score: 1,
      suggestedMinor: String((index + 1) * 1_000_000),
      approvedMinor: String((index + 1) * 1_000_000),
      state: "approved",
      adjustmentReason: null,
      relatedParty: false,
      platformApproval: null,
      evidenceEventIds: [],
      wallet: {
        chain: "solana",
        address: address(login),
        observedAt: "2026-07-31T00:00:00.000Z",
        sourceCommit: commit,
        sourceUrl: `https://github.com/${login}/${login}/blob/${commit}/README.md`,
      },
    };
  });
  const approvedMinor = rows.reduce(
    (total, row) => total + BigInt(row.approvedMinor),
    0n,
  );
  return assertRewardAllocationManifest({
    schemaVersion: "1",
    kind: "reward-allocation",
    projectId: "eliza",
    cycleId: "2026-07",
    status: "approved",
    generatedAt: "2026-08-01T00:00:00.000Z",
    approvedAt: "2026-08-16T00:00:00.000Z",
    contributionWindow: {
      from: "2026-07-07T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    review: {
      days: 14,
      lastMaterialChangeAt: "2026-08-01T00:00:00.000Z",
      endsAt: "2026-08-15T00:00:00.000Z",
    },
    currency: "USDC",
    chain: "solana",
    capMinor: "1000000000",
    fundingBasis: {
      cycleId: "2026-07",
      instrumentId,
      fundingState: "committed",
      committedMinor: "1000000000",
      monthlyCapMinor: "1000000000",
    },
    feeBasisPoints: 100,
    scoringRuleVersion: "2026-07-v1",
    sourceSnapshotSha256: "b2".repeat(32),
    allocations: rows,
    totals: {
      suggestedMinor: String(approvedMinor),
      approvedMinor: String(approvedMinor),
      feeMinor: String(approvedMinor / 100n),
    },
  });
}

const bytes = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** The real 2-of-2 plan and its canonical Batch handoff. */
async function prepareVaultCycle(contributors: number) {
  const allocation = buildAllocation(
    contributors,
    `squads-v4-vault:solana:${MULTISIG}:0:${VAULT}`,
  );
  const allocationBytes = bytes(allocation);
  const allocationSha256 = sha256(allocationBytes);
  const plan = createSettlementExecutionPlan({
    allocation,
    allocationSha256,
    createdAt: PLAN_CREATED_AT,
    feeRecipient: FEE_RECIPIENT,
    sourceOwner: VAULT,
  });
  const handoff = await prepareSquadsBatchHandoff({
    allocationBytes,
    planBytes: bytes(plan),
    multisig: MULTISIG,
    vaultIndex: 0,
    transactionIndex: "7",
    member: MEMBER,
  });
  return {
    allocation,
    allocationSha256,
    plan,
    children: handoff.binding.children.map(
      (child: { transferIndexes: number[] }) =>
        child.transferIndexes.map((index) => plan.transfers[index]),
    ),
  };
}

/** The finalized transaction that executing one Batch child produces: the
 * vault's USDC moves to exactly that child's recipients. */
function finalizedTransaction(
  transactionSignature: string,
  source: string,
  transfers: readonly SettlementPlanTransfer[],
) {
  const debit = transfers.reduce(
    (total, transfer) => total + BigInt(transfer.amountMinor),
    0n,
  );
  const balance = (accountIndex: number, owner: string, amount: bigint) => ({
    accountIndex,
    mint: SOLANA_MAINNET_USDC_MINT,
    owner,
    uiTokenAmount: { decimals: 6, amount: String(amount) },
  });
  return {
    slot: 400_000_000,
    blockTime: BLOCK_TIME,
    meta: {
      err: null,
      preTokenBalances: [
        balance(0, source, 1_000_000_000n),
        ...transfers.map((transfer, index) =>
          balance(index + 1, transfer.recipientOwner, 0n),
        ),
      ],
      postTokenBalances: [
        balance(0, source, 1_000_000_000n - debit),
        ...transfers.map((transfer, index) =>
          balance(
            index + 1,
            transfer.recipientOwner,
            BigInt(transfer.amountMinor),
          ),
        ),
      ],
    },
    transaction: { signatures: [transactionSignature] },
  };
}

/** The settlement `verify-settlement.ts` builds from `transactions.json` for a
 * 2-of-2 plan: every approved row paid, the plan's fee paid. */
function buildSettlement(
  cycle: Awaited<ReturnType<typeof prepareVaultCycle>>,
  evidence: ReturnType<typeof parseSettlementEvidence>,
) {
  const fee = cycle.plan.transfers.find(
    (transfer) => transfer.kind === "platform-fee",
  );
  if (!fee) throw new Error("2-of-2 plan has no fee transfer");
  return {
    schemaVersion: "1",
    kind: "reward-settlement",
    projectId: "eliza",
    cycleId: "2026-07",
    allocationSha256: cycle.allocationSha256,
    settledAt: SETTLED_AT,
    currency: "USDC",
    chain: "solana",
    status: "paid",
    recipients: cycle.allocation.allocations.map((row) => ({
      intentId: row.intentId,
      approvedMinor: row.approvedMinor,
      paidMinor: row.approvedMinor,
      state: "paid",
    })),
    attempts: evidence.attempts.map((attempt) => ({
      ...attempt,
      state: "finalized",
    })),
    platformFee: {
      recipient: fee.recipientOwner,
      dueMinor: fee.amountMinor,
      paidMinor: fee.amountMinor,
      signature: evidence.platformFeeSignature,
      state: "paid",
    },
    totals: {
      approvedMinor: cycle.allocation.totals.approvedMinor,
      paidMinor: cycle.allocation.totals.approvedMinor,
      feeMinor: cycle.allocation.totals.feeMinor,
    },
  };
}

/** `transactions.json` for the executed Batch: one attempt per child that pays
 * contributors, and the fee named by the child that carried it. */
function batchEvidence(children: SettlementPlanTransfer[][]) {
  const childSignature = (index: number) => signature(`child-${index + 1}`);
  const attempts = children.flatMap((transfers, index) => {
    const intentIds = transfers
      .filter((transfer) => transfer.kind === "contributor")
      .flatMap((transfer) => transfer.intentIds);
    return intentIds.length === 0
      ? []
      : [
          {
            attemptId: `attempt_batch-child-${index + 1}`,
            intentIds,
            signature: childSignature(index),
          },
        ];
  });
  const feeChild = children.findIndex((transfers) =>
    transfers.some((transfer) => transfer.kind === "platform-fee"),
  );
  return {
    value: {
      schemaVersion: "1",
      kind: "solana-settlement-evidence",
      cycleId: "2026-07",
      attempts,
      platformFeeSignature: childSignature(feeChild),
    },
    transactions: new Map(
      children.map((transfers, index) => [
        childSignature(index),
        finalizedTransaction(childSignature(index), VAULT, transfers),
      ]),
    ),
  };
}

describe("settlement of a 2-of-2 fee executed with contributor transfers", () => {
  it.each([
    [3, [[0, 1, 2, 3]]],
    [
      6,
      [
        [0, 1, 2, 3, 4],
        [5, 6],
      ],
    ],
  ])(
    "records the Batch for %i contributors whose fee shares a child",
    async (contributors, layout) => {
      const cycle = await prepareVaultCycle(contributors);
      expect(
        cycle.children.map((transfers) =>
          transfers.map((transfer) => cycle.plan.transfers.indexOf(transfer)),
        ),
      ).toEqual(layout);
      const evidence = batchEvidence(cycle.children);
      const parsed = parseSettlementEvidence(
        evidence.value,
        "2026-07",
        "solana",
      );
      const settlement = assertRewardSettlementManifest(
        buildSettlement(cycle, parsed),
        cycle.allocation,
      );
      const requested: string[] = [];
      const verified = await verifyRewardSettlementOnchain({
        allocation: cycle.allocation,
        expectedAllocationSha256: cycle.allocationSha256,
        plan: cycle.plan,
        settlement,
        getTransaction: async (requestedSignature) => {
          requested.push(requestedSignature);
          return evidence.transactions.get(requestedSignature);
        },
      });
      expect(settlement.status).toBe("paid");
      expect(settlement.platformFee.signature).toBe(
        evidence.value.platformFeeSignature,
      );
      // Each finalized transaction is read and reconciled exactly once.
      expect(requested).toEqual(
        cycle.children.map((_, i) => signature(`child-${i + 1}`)),
      );
      expect(verified).toHaveLength(cycle.children.length);
    },
  );

  it("still records a fee that sits alone in its own child", async () => {
    const cycle = await prepareVaultCycle(5);
    expect(cycle.children.map((transfers) => transfers.length)).toEqual([5, 1]);
    const evidence = batchEvidence(cycle.children);
    const settlement = assertRewardSettlementManifest(
      buildSettlement(
        cycle,
        parseSettlementEvidence(evidence.value, "2026-07", "solana"),
      ),
      cycle.allocation,
    );
    const verified = await verifyRewardSettlementOnchain({
      allocation: cycle.allocation,
      expectedAllocationSha256: cycle.allocationSha256,
      plan: cycle.plan,
      settlement,
      getTransaction: async (requestedSignature) =>
        evidence.transactions.get(requestedSignature),
    });
    expect(verified).toHaveLength(2);
  });

  it("refuses a shared signature whose transaction did not pay the fee", async () => {
    const cycle = await prepareVaultCycle(3);
    const evidence = batchEvidence(cycle.children);
    const [shared] = evidence.value.attempts;
    const contributorsOnly = cycle.children[0].filter(
      (transfer) => transfer.kind === "contributor",
    );
    const settlement = assertRewardSettlementManifest(
      buildSettlement(
        cycle,
        parseSettlementEvidence(evidence.value, "2026-07", "solana"),
      ),
      cycle.allocation,
    );
    await expect(
      verifyRewardSettlementOnchain({
        allocation: cycle.allocation,
        expectedAllocationSha256: cycle.allocationSha256,
        plan: cycle.plan,
        settlement,
        getTransaction: async () =>
          finalizedTransaction(shared.signature, VAULT, contributorsOnly),
      }),
    ).rejects.toThrow("Solana source USDC debit is not exact");
  });

  it("refuses a fee that names an attempt which did not finalize", async () => {
    const cycle = await prepareVaultCycle(3);
    const evidence = batchEvidence(cycle.children);
    const settlement = buildSettlement(
      cycle,
      parseSettlementEvidence(evidence.value, "2026-07", "solana"),
    );
    expect(() =>
      assertRewardSettlementManifest(
        {
          ...settlement,
          status: "failed",
          recipients: settlement.recipients.map((recipient) => ({
            ...recipient,
            paidMinor: "0",
            state: "pending",
          })),
          attempts: settlement.attempts.map((attempt) => ({
            ...attempt,
            state: "broadcast",
          })),
          totals: { ...settlement.totals, paidMinor: "0" },
        },
        cycle.allocation,
      ),
    ).toThrow("platform fee and contributor payout reuse a signature");
  });

  it("keeps a project vault fee in the creator's separate transaction", () => {
    const allocation = buildAllocation(
      1,
      `squads-project-vault:solana:${PROJECT_VAULT_MULTISIG}:0:${PROJECT_VAULT}`,
    );
    const shared = signature("project-vault-payout");
    expect(() =>
      assertRewardSettlementManifest(
        {
          schemaVersion: "1",
          kind: "reward-settlement",
          projectId: "eliza",
          cycleId: "2026-07",
          allocationSha256: sha256(bytes(allocation)),
          settledAt: SETTLED_AT,
          currency: "USDC",
          chain: "solana",
          status: "paid",
          recipients: [
            {
              intentId: "pay_intent-1",
              approvedMinor: "1000000",
              paidMinor: "1000000",
              state: "paid",
            },
          ],
          attempts: [
            {
              attemptId: "attempt_project-vault-1",
              intentIds: ["pay_intent-1"],
              signature: shared,
              state: "finalized",
            },
          ],
          platformFee: {
            recipient: FEE_RECIPIENT,
            dueMinor: "10000",
            paidMinor: "10000",
            signature: shared,
            state: "paid",
          },
          totals: {
            approvedMinor: "1000000",
            paidMinor: "1000000",
            feeMinor: "10000",
          },
        },
        allocation,
      ),
    ).toThrow("platform fee and contributor payout reuse a signature");
  });
});
