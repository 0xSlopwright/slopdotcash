/** Synthetic fixtures only: no production vault, plan, refund, or wallet claim.
 * Regression for corrected or disputed refund records (RFC #500 section 10). */
/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertProjectCommitmentLedger,
  type ProjectCommitmentRecord,
} from "../src/lib/funding-commitment";
import type { FundingCommitmentInstrument } from "../src/lib/funding-instruments.mjs";
import {
  assertProjectVaultWindup,
  deriveProjectVaultWindup,
  projectVaultVerifiedBalanceMinor,
} from "../src/lib/project-vault-windup";
import { assertRewardAllocationManifest } from "../src/lib/rewards";
import { createSettlementExecutionPlan } from "../src/lib/settlement-plan";
import { deriveSquadsVaultAddress } from "../src/lib/squads-funding";

const RECIPIENT = "11111111111111111111111111111111";
const MULTISIG = "Vote111111111111111111111111111111111111111";
const FEE = "Stake11111111111111111111111111111111111111";
const PROPOSAL = "SysvarRent111111111111111111111111111111111";
const TRANSACTION = "SysvarC1ock11111111111111111111111111111111";
const CREATOR = "Config1111111111111111111111111111111111111";
const SLOP = "BPFLoaderUpgradeab1e11111111111111111111111";
const INDEPENDENT = "ComputeBudget111111111111111111111111111111";
const COMMIT = "a".repeat(40);
const DEPOSIT_AT = "2026-08-10T00:00:00.000Z";
const APPROVED_AT = "2026-08-15T00:00:00.000Z";
const REFUND_AT = "2026-08-20T00:00:00.000Z";
const OBSERVED_AT = "2026-08-21T00:00:00.000Z";
const RECORDED_AT = "2026-08-21T00:05:00.000Z";

async function fixture() {
  const vault = await deriveSquadsVaultAddress(MULTISIG, 0);
  const instrumentId = `squads-project-vault:solana:${MULTISIG}:0:${vault}`;
  const allocation = assertRewardAllocationManifest({
    fundingBasis: {
      cycleId: "2026-07",
      fundingState: "committed",
      committedMinor: "10000000000",
      monthlyCapMinor: "10000000000",
      instrumentId,
    },
    schemaVersion: "1",
    kind: "reward-allocation",
    projectId: "eliza",
    cycleId: "2026-07",
    status: "approved",
    generatedAt: "2026-08-01T00:00:00.000Z",
    approvedAt: APPROVED_AT,
    contributionWindow: {
      from: "2026-07-07T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    review: {
      days: 14,
      lastMaterialChangeAt: "2026-08-01T00:00:00.000Z",
      endsAt: APPROVED_AT,
    },
    currency: "USDC",
    chain: "solana",
    capMinor: "10000000000",
    feeBasisPoints: 100,
    scoringRuleVersion: "gitarmy-v1",
    sourceSnapshotSha256: "b".repeat(64),
    allocations: [
      {
        intentId: "pay_eliza_2026_07_u1",
        actor: { id: "U_1", login: "contributor" },
        score: 100,
        suggestedMinor: "1000000",
        approvedMinor: "1000000",
        state: "approved",
        wallet: {
          address: RECIPIENT,
          chain: "solana",
          observedAt: "2026-08-01T00:00:00.000Z",
          sourceCommit: COMMIT,
          sourceUrl: `https://github.com/contributor/contributor/blob/${COMMIT}/README.md`,
        },
        evidenceEventIds: ["event_1"],
        adjustmentReason: null,
        relatedParty: false,
        platformApproval: null,
      },
    ],
    totals: {
      suggestedMinor: "1000000",
      approvedMinor: "1000000",
      feeMinor: "10000",
    },
  });
  const allocationBytes = Buffer.from(JSON.stringify(allocation));
  const allocationSha256 = createHash("sha256")
    .update(allocationBytes)
    .digest("hex");
  const plan = createSettlementExecutionPlan({
    allocation,
    allocationSha256,
    createdAt: "2026-08-16T00:00:00.000Z",
    feeRecipient: FEE,
    sourceOwner: vault,
  });
  const planBytes = Buffer.from(JSON.stringify(plan));
  const planSha256 = createHash("sha256").update(planBytes).digest("hex");
  const binding = {
    schemaVersion: "1",
    kind: "squads-execution-binding",
    projectId: "eliza",
    cycleId: "2026-07",
    planSha256,
    multisig: MULTISIG,
    vault,
    vaultIndex: 0,
    transactionIndex: "1",
    proposalAccount: PROPOSAL,
    vaultTransactionAccount: TRANSACTION,
  };
  const refund = (
    overrides: Partial<ProjectCommitmentRecord> = {},
  ): ProjectCommitmentRecord => ({
    schemaVersion: "1",
    kind: "project-commitment",
    recordId: "cmt_windup_refund_01",
    projectId: "eliza",
    manifestRevision: COMMIT,
    event: "refund",
    network: "solana",
    asset: "USDC",
    instrument: {
      creatorMember: CREATOR,
      independentMember: INDEPENDENT,
      multisig: MULTISIG,
      slopMember: SLOP,
      vault,
      vaultIndex: 0,
    },
    transactionId: "5".repeat(88),
    amountMinor: "1000000",
    observedAt: REFUND_AT,
    state: "verified-on-chain",
    finality: { kind: "finalized" },
    verifier: {
      version: "project-vault-squads-v1",
      checkedAt: REFUND_AT,
      evidenceUrl: `https://solscan.io/tx/${"5".repeat(88)}`,
      reason: null,
    },
    supersedes: null,
    ...overrides,
  });
  /** A verified deposit that funded the vault before approval. */
  const deposit = (
    overrides: Partial<ProjectCommitmentRecord> = {},
  ): ProjectCommitmentRecord =>
    refund({
      recordId: "cmt_windup_deposit_01",
      event: "deposit",
      transactionId: "6".repeat(88),
      amountMinor: "1000000",
      observedAt: DEPOSIT_AT,
      verifier: {
        version: "project-vault-squads-v1",
        checkedAt: DEPOSIT_AT,
        evidenceUrl: `https://solscan.io/tx/${"6".repeat(88)}`,
        reason: null,
      },
      ...overrides,
    });
  const context = {
    allocation,
    allocationSha256,
    planBytes,
    ledger: [binding],
    fundingRecords: [deposit(), refund()],
  };
  const derive = (
    overrides: Partial<Parameters<typeof deriveProjectVaultWindup>[0]> = {},
  ) =>
    deriveProjectVaultWindup({
      ...context,
      vaultBalanceMinor: "0",
      observedAt: OBSERVED_AT,
      recordedAt: RECORDED_AT,
      ...overrides,
    });
  return {
    allocation,
    binding,
    context,
    deposit,
    derive,
    instrumentId,
    refund,
    vault,
  };
}

const CORRECTED_AT = "2026-08-20T12:00:00.000Z";

/** A project-vault verifier block with a known non-null shape. */
function verifier(
  transactionId: string,
  checkedAt: string,
  reason: string | null = null,
) {
  return {
    version: "project-vault-squads-v1",
    checkedAt,
    evidenceUrl: `https://solscan.io/tx/${transactionId}`,
    reason,
  };
}

/** The ledger validator accepts only legal correction chains; every scenario
 * below passes it, so each one is a state the published ledger can hold. */
function assertLedgerLegal(
  records: readonly ProjectCommitmentRecord[],
  vault: string,
): void {
  const instrument = {
    kind: "squads-project-vault",
    network: "solana",
    asset: "USDC",
    multisig: MULTISIG,
    vault,
    vaultIndex: 0,
    creatorMember: CREATOR,
    slopMember: SLOP,
    independentMember: INDEPENDENT,
    effectiveAt: "2026-08-01T00:00:00.000Z",
    replacedAt: null,
  } as unknown as FundingCommitmentInstrument;
  expect(assertProjectCommitmentLedger(records, [instrument])).toHaveLength(
    records.length,
  );
}

function correction(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<ProjectCommitmentRecord>,
): ProjectCommitmentRecord {
  const base = f.refund();
  return f.refund({
    recordId: "cmt_windup_refund_02",
    observedAt: CORRECTED_AT,
    supersedes: base.recordId,
    verifier: verifier(base.transactionId, CORRECTED_AT),
    ...overrides,
  });
}

describe("project vault windup uses only the current refund record", () => {
  it("does not name a verified refund that a later record disputes", async () => {
    const f = await fixture();
    // A second, undisputed refund of 500,000 leaves the vault short, so a
    // windup is due; the disputed transaction must not be named as its cause.
    const genuine = f.refund({
      recordId: "cmt_windup_refund_03",
      transactionId:
        "99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8",
      amountMinor: "500000",
      verifier: verifier(
        "99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8",
        REFUND_AT,
      ),
    });
    const disputed = correction(f, {
      state: "disputed",
      verifier: verifier(
        "5".repeat(88),
        CORRECTED_AT,
        "Refund transfer did not leave the project vault.",
      ),
    });
    const records = [f.deposit(), f.refund(), genuine, disputed];
    assertLedgerLegal(records, f.vault);
    expect(
      projectVaultVerifiedBalanceMinor(records, f.binding, OBSERVED_AT),
    ).toBe(500000n);
    const windup = await f.derive({
      fundingRecords: records,
      vaultBalanceMinor: "500000",
    });
    expect(windup.refunds.map((refund) => refund.recordId)).toEqual([
      "cmt_windup_refund_03",
    ]);
    expect(windup.reason).not.toContain("5".repeat(88));
    const context = { ...f.context, fundingRecords: records };
    expect(await assertProjectVaultWindup(windup, context)).toEqual(windup);
    // A windup written before the dispute no longer validates (re-check path).
    const earlier = await f.derive({
      fundingRecords: [f.deposit(), f.refund(), genuine],
    });
    await expect(assertProjectVaultWindup(earlier, context)).rejects.toThrow(
      /verified funding ledger does not hold/u,
    );
  });

  it("counts a corrected verified refund once, at its corrected amount", async () => {
    const f = await fixture();
    const corrected = correction(f, { amountMinor: "900000" });
    const records = [f.deposit(), f.refund(), corrected];
    assertLedgerLegal(records, f.vault);
    expect(
      projectVaultVerifiedBalanceMinor(records, f.binding, OBSERVED_AT),
    ).toBe(100000n);
    const windup = await f.derive({
      fundingRecords: records,
      vaultBalanceMinor: "100000",
    });
    expect(windup.refunds).toEqual([
      {
        recordId: "cmt_windup_refund_02",
        transactionId: "5".repeat(88),
        amountMinor: "900000",
        observedAt: CORRECTED_AT,
      },
    ]);
    const context = { ...f.context, fundingRecords: records };
    expect(await assertProjectVaultWindup(windup, context)).toEqual(windup);
    // A windup that still names the superseded amount is refused.
    const stale = await f.derive();
    await expect(assertProjectVaultWindup(stale, context)).rejects.toThrow(
      /verified funding ledger does not hold/u,
    );
  });

  it("applies disputes and corrections recorded after the windup observation to the verified balance", async () => {
    const f = await fixture();
    const laterAt = "2026-08-22T00:00:00.000Z";
    const disputedLater = correction(f, {
      observedAt: laterAt,
      state: "disputed",
      verifier: verifier(
        "5".repeat(88),
        laterAt,
        "Refund transfer did not leave the project vault.",
      ),
    });
    const disputedRecords = [
      f.deposit({ amountMinor: "1100000" }),
      f.refund(),
      disputedLater,
    ];
    assertLedgerLegal(disputedRecords, f.vault);
    expect(
      projectVaultVerifiedBalanceMinor(disputedRecords, f.binding, OBSERVED_AT),
    ).toBe(1100000n);

    const correctedLater = correction(f, {
      observedAt: laterAt,
      amountMinor: "900000",
      verifier: verifier("5".repeat(88), laterAt),
    });
    const correctedRecords = [f.deposit(), f.refund(), correctedLater];
    assertLedgerLegal(correctedRecords, f.vault);
    expect(
      projectVaultVerifiedBalanceMinor(
        correctedRecords,
        f.binding,
        OBSERVED_AT,
      ),
    ).toBe(100000n);
  });

  it("requires every verified refund in the observation window in canonical order and ignores later refunds", async () => {
    const f = await fixture();
    const secondRefund = f.refund({
      recordId: "cmt_windup_refund_03",
      transactionId:
        "99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8",
      amountMinor: "400000",
      observedAt: "2026-08-20T06:00:00.000Z",
      verifier: verifier(
        "99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8",
        "2026-08-20T06:00:00.000Z",
      ),
    });
    const laterRefund = f.refund({
      recordId: "cmt_windup_refund_04",
      transactionId: "4".repeat(88),
      amountMinor: "100000",
      observedAt: "2026-08-25T00:00:00.000Z",
      verifier: verifier("4".repeat(88), "2026-08-25T00:00:00.000Z"),
    });
    const firstRefund = f.refund({ amountMinor: "500000" });
    const records = [f.deposit(), firstRefund, secondRefund, laterRefund];
    assertLedgerLegal(records, f.vault);

    const windup = await f.derive({
      fundingRecords: records,
      vaultBalanceMinor: "100000",
    });
    expect(windup.refunds.map((row) => row.recordId)).toEqual([
      "cmt_windup_refund_01",
      "cmt_windup_refund_03",
    ]);

    const context = { ...f.context, fundingRecords: records };
    const omitted = {
      ...windup,
      refunds: [windup.refunds[0]],
    };
    await expect(assertProjectVaultWindup(omitted, context)).rejects.toThrow(
      /canonical order/u,
    );
    const reordered = {
      ...windup,
      refunds: [windup.refunds[1], windup.refunds[0]],
    };
    await expect(assertProjectVaultWindup(reordered, context)).rejects.toThrow(
      /canonical order/u,
    );
  });
});

describe("project vault windup orders refunds by their first observation", () => {
  it("records a windup when a verified refund is corrected after the balance observation", async () => {
    const f = await fixture();
    const laterAt = "2026-08-22T00:00:00.000Z";
    const correctedLater = correction(f, {
      observedAt: laterAt,
      amountMinor: "900000",
      verifier: verifier("5".repeat(88), laterAt),
    });
    const records = [f.deposit(), f.refund(), correctedLater];
    assertLedgerLegal(records, f.vault);
    const windup = await f.derive({
      fundingRecords: records,
      vaultBalanceMinor: "100000",
    });
    expect(windup.refunds).toEqual([
      {
        recordId: "cmt_windup_refund_02",
        transactionId: "5".repeat(88),
        amountMinor: "900000",
        observedAt: laterAt,
      },
    ]);
    const context = { ...f.context, fundingRecords: records };
    expect(await assertProjectVaultWindup(windup, context)).toEqual(windup);
    // A balance observed before the refund was first observed is still refused.
    const early = { ...windup, observedAt: "2026-08-19T00:00:00.000Z" };
    await expect(assertProjectVaultWindup(early, context)).rejects.toThrow(
      /observed before a named refund/u,
    );
  });
});
