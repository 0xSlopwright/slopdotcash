/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import type { FundingCommitmentInstrument } from "../src/lib/funding-instruments.mjs";
import {
  createSettlementExecutionPlan,
  SOLANA_MAINNET_USDC_MINT,
} from "../src/lib/settlement-plan";
import {
  type VerifiedSolanaTransaction,
  verifyRewardSettlementOnchain,
} from "../src/lib/solana-settlement";

// Deterministic 32-byte Solana public keys, validated with isSolanaAddress.
const SOURCE_OWNER = "8WAca8hqqN3XfBGcvgX8mTEKTUQyVAHUNRtyCcbkPo3y";
const RECIPIENT_OWNER = "Cvh7cQjy9y4bQFopRJ61BJVRSJLq92wLt85Kdt7eXAF";
const FEE_RECIPIENT = "BCvSJBLFVHvbEn5AfCw8SHfTXDJP6jGJ4PwM2JZyB1co";
// Deterministic 64-byte signatures, validated with isSolanaTransactionId.
const SIGNATURE =
  "6t3i3JkwP73fiVgoM4G6FHH1Mh5e6zMHrMYKpPiEJHGuQa9LjbMHXeNvfVE5Y44sgaWAR6nP5vvbWaTBbv1M8Lo";
const POSITIVE_SIGNATURE =
  "2fg9VT2bJbWWoo1nWwsigREvC8FVkzcYKJeQu4PeurWoiNEyPX4D2Aq7DkTAMyeFwabMJKQUjVgAPzAWByQAkt6K";

const INTENT_ID = "pay_intent-1";
const ALLOCATION_SHA256 = "a1".repeat(32);
const SOURCE_SNAPSHOT_SHA256 = "b2".repeat(32);
const PLAN_CREATED_AT = "2026-10-14T07:00:00.000Z";
const PLAN_CREATED_AT_SECONDS = Date.parse(PLAN_CREATED_AT) / 1_000;
// One hour before / after the plan was created.
const PRE_PLAN_BLOCK_TIME = PLAN_CREATED_AT_SECONDS - 3_600;
const POST_PLAN_BLOCK_TIME = PLAN_CREATED_AT_SECONDS + 3_600;

const WALLET_SOURCE_COMMIT = "ab".repeat(20);
const WALLET_OBSERVED_AT = "2026-07-31T00:00:00.000Z";
const GENERATION_AT = "2026-08-01T00:00:00.000Z";
const REVIEW_LAST_CHANGE_AT = "2026-08-01T00:00:00.000Z";
const REVIEW_ENDS_AT = "2026-08-15T00:00:00.000Z";
const APPROVED_AT = "2026-08-16T00:00:00.000Z";
const SETTLED_AT = "2026-10-14T09:00:00.000Z";

/** An approved allocation for the eliza project, cycle 2026-07 (a legacy
 * cap cycle, so no funding basis is required), with one approved contributor
 * row of 1_000_000 USDC micro-units. */
function buildAllocation() {
  return {
    schemaVersion: "1",
    kind: "reward-allocation",
    projectId: "eliza",
    cycleId: "2026-07",
    status: "approved",
    generatedAt: GENERATION_AT,
    approvedAt: APPROVED_AT,
    contributionWindow: {
      from: "2026-07-07T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    review: {
      days: 14,
      lastMaterialChangeAt: REVIEW_LAST_CHANGE_AT,
      endsAt: REVIEW_ENDS_AT,
    },
    currency: "USDC",
    chain: "solana",
    capMinor: "1000000000",
    feeBasisPoints: 100,
    scoringRuleVersion: "2026-07-v1",
    sourceSnapshotSha256: SOURCE_SNAPSHOT_SHA256,
    allocations: [
      {
        intentId: INTENT_ID,
        actor: { id: "actor-1", login: "contributor1" },
        score: 3,
        suggestedMinor: "1000000",
        approvedMinor: "1000000",
        state: "approved",
        adjustmentReason: null,
        relatedParty: false,
        platformApproval: null,
        evidenceEventIds: [],
        wallet: {
          chain: "solana",
          address: RECIPIENT_OWNER,
          observedAt: WALLET_OBSERVED_AT,
          sourceCommit: WALLET_SOURCE_COMMIT,
          sourceUrl: `https://github.com/contributor1/contributor1/blob/${WALLET_SOURCE_COMMIT}/README.md`,
        },
      },
    ],
    totals: {
      suggestedMinor: "1000000",
      approvedMinor: "1000000",
      feeMinor: "10000",
    },
  };
}

/** A finalized Solana USDC transaction that moves exactly 1_000_000
 * micro-units from SOURCE_OWNER to RECIPIENT_OWNER, signed by `signature`,
 * and sealed at `blockTime`. The delta set is otherwise empty, so it passes
 * the transfer-amount checks and only the plan-time guard can reject it. */
function buildGetTransaction(signature: string, blockTime: number) {
  const tokenBalance = (
    accountIndex: number,
    owner: string,
    amount: string,
  ) => ({
    accountIndex,
    mint: SOLANA_MAINNET_USDC_MINT,
    owner,
    uiTokenAmount: { decimals: 6, amount },
  });
  return async (requestedSignature: string) => {
    expect(requestedSignature).toBe(signature);
    return {
      slot: 321_654_987,
      blockTime,
      meta: {
        err: null,
        preTokenBalances: [
          tokenBalance(1, SOURCE_OWNER, "5000000"),
          tokenBalance(2, RECIPIENT_OWNER, "0"),
        ],
        postTokenBalances: [
          tokenBalance(1, SOURCE_OWNER, "4000000"),
          tokenBalance(2, RECIPIENT_OWNER, "1000000"),
        ],
      },
      transaction: { signatures: [signature] },
    };
  };
}

function buildSettlement(signature: string) {
  return {
    schemaVersion: "1",
    kind: "reward-settlement",
    projectId: "eliza",
    cycleId: "2026-07",
    allocationSha256: ALLOCATION_SHA256,
    settledAt: SETTLED_AT,
    currency: "USDC",
    chain: "solana",
    status: "partially-paid",
    recipients: [
      {
        intentId: INTENT_ID,
        approvedMinor: "1000000",
        paidMinor: "1000000",
        state: "paid",
      },
    ],
    attempts: [
      {
        attemptId: "attempt_replay-guard-1",
        intentIds: [INTENT_ID],
        signature,
        state: "finalized",
      },
    ],
    platformFee: {
      recipient: FEE_RECIPIENT,
      dueMinor: "10000",
      paidMinor: "0",
      signature: null,
      state: "pending",
    },
    totals: {
      approvedMinor: "1000000",
      paidMinor: "1000000",
      feeMinor: "10000",
    },
  };
}

describe("verifyRewardSettlementOnchain Solana pre-plan replay guard", () => {
  const allocation = buildAllocation();
  const plan = createSettlementExecutionPlan({
    allocation,
    allocationSha256: ALLOCATION_SHA256,
    createdAt: PLAN_CREATED_AT,
    feeRecipient: FEE_RECIPIENT,
    sourceOwner: SOURCE_OWNER,
  });

  it("rejects a fully valid finalized transaction whose blockTime predates the plan", async () => {
    // The fixture transaction is valid in every other respect: finalized,
    // signature matches, exact 1 USDC debit/credit on the plan's source and
    // the plan's contributor recipient. The ONLY invalid property is the
    // blockTime, which seals the replay guard as the rejecting check.
    await expect(
      verifyRewardSettlementOnchain({
        allocation,
        expectedAllocationSha256: ALLOCATION_SHA256,
        plan,
        settlement: buildSettlement(SIGNATURE),
        getTransaction: buildGetTransaction(SIGNATURE, PRE_PLAN_BLOCK_TIME),
      }),
    ).rejects.toThrow(/predates its plan/i);
  });

  it("accepts the same planned contributor transfer after the plan was created", async () => {
    const verified = await verifyRewardSettlementOnchain({
      allocation,
      expectedAllocationSha256: ALLOCATION_SHA256,
      plan,
      settlement: buildSettlement(POSITIVE_SIGNATURE),
      getTransaction: buildGetTransaction(
        POSITIVE_SIGNATURE,
        POST_PLAN_BLOCK_TIME,
      ),
    });
    expect(verified).toHaveLength(1);
    // This test only exercises the Solana path, so every entry is a
    // VerifiedSolanaTransaction; narrow the union before reading .signature
    // (VerifiedBaseSettlementTransaction carries transactionHash instead).
    const [transaction] = verified as [VerifiedSolanaTransaction];
    expect(transaction.signature).toBe(POSITIVE_SIGNATURE);
    expect(transaction.blockTime).toBe(POST_PLAN_BLOCK_TIME);
  });
});

describe("verifyRewardSettlementOnchain project-vault fee chronology guard", () => {
  // A project vault: the fee is a separate transfer from the creator's own
  // wallet, so the plan carries no fee transfer and the fee path calls
  // assertFinalizedUsdcFundingTransfer directly. The chronology guard must
  // still bind the fee to the plan: with no verified contributor payout the
  // contributor-ordering check is vacuous.
  const VAULT_MULTISIG = "8o2tb5h4xnYS66yMzTvrUiWPqqfmx3jHFVWCnnvFEz4N";
  const VAULT_OWNER = "5vdqwRwVvefAmFcA6qNvRK9fJbZywUgqr5X1GQ9n56e3";
  const CREATOR_OWNER = "3XjjCR7iWuri2c4WyaTK2PeFyxSig5eHjcDCratfKYYd";
  // Deterministic fixture addresses for the remaining required
  // SquadsProjectVaultInstrument fields (typecheck completeness only).
  const CREATOR_MULTISIG = "CeJxxMwd6S5m97vVH3SDLvmzXQJJkD81VYUHMaD3pjy2";
  const SLOP_MEMBER = "DbvZpGgxCVfkA5L5SVX73L6mVtUdBv8QubT3YkqMTXSm";
  const INDEPENDENT_MEMBER = "5xL2TYyEcpLhfxQ53LWyYMg9nJuzpENpV867Akfp3vc3";
  const INSTRUMENT_ID = `squads-project-vault:solana:${VAULT_MULTISIG}:0:${VAULT_OWNER}`;
  const FEE_SIGNATURE =
    "4T2oWuVZDGcfDusJdVNsCD2kDs7kykWne7MHangMKZmT1gq61t6yokCN3mZyAd82imMuTbTS2PHmmcohgzFrwfgc";
  const FEE_DUE_MINOR = "10000";

  const vaultAllocation = {
    ...buildAllocation(),
    fundingBasis: {
      cycleId: "2026-07",
      fundingState: "committed",
      committedMinor: "1000000000",
      monthlyCapMinor: "1000000000",
      instrumentId: INSTRUMENT_ID,
    },
  };
  const vaultPlan = createSettlementExecutionPlan({
    allocation: vaultAllocation,
    allocationSha256: ALLOCATION_SHA256,
    createdAt: PLAN_CREATED_AT,
    feeRecipient: FEE_RECIPIENT,
    sourceOwner: VAULT_OWNER,
  });
  /** A complete reviewed project-vault instrument fixture. Only
   * `kind`/`multisig`/`vaultIndex`/`vault` (ID matching) and `creatorMember`
   * (required sender of the fee transfer) are exercised at runtime; the rest
   * is `SquadsProjectVaultInstrument` typecheck completeness. */
  const fundingInstruments = [
    {
      kind: "squads-project-vault",
      network: "solana",
      asset: "USDC",
      multisig: VAULT_MULTISIG,
      vault: VAULT_OWNER,
      vaultIndex: 0,
      creatorActorId: "fixture-creator-actor",
      creatorMember: CREATOR_OWNER,
      creatorMultisig: CREATOR_MULTISIG,
      creatorVaultIndex: 0,
      slopMember: SLOP_MEMBER,
      independentMember: INDEPENDENT_MEMBER,
      independentGithub: {
        actorId: "fixture-independent-actor",
        nodeId: "fixture-independent-node",
        login: "fixture-independent",
      },
      timeLockSeconds: 86_400,
      fallbackWaitSeconds: 604_800,
      monthlyCommitment: {
        cycleId: "2026-07",
        amountMinor: "1000000000",
        accessibility: "unknown",
      },
      deadline: "2026-12-31T00:00:00.000Z",
      effectiveAt: "2026-07-01T00:00:00.000Z",
      replacedAt: null,
    },
  ] satisfies readonly FundingCommitmentInstrument[];

  /** A finalized fee transfer from the creator wallet to the fee recipient,
   * moving exactly the due fee, sealed at `blockTime`. */
  function buildFeeGetTransaction(blockTime: number) {
    const tokenBalance = (
      accountIndex: number,
      owner: string,
      amount: string,
    ) => ({
      accountIndex,
      mint: SOLANA_MAINNET_USDC_MINT,
      owner,
      uiTokenAmount: { decimals: 6, amount },
    });
    return async (requestedSignature: string) => {
      expect(requestedSignature).toBe(FEE_SIGNATURE);
      return {
        slot: 321_654_988,
        blockTime,
        meta: {
          err: null,
          preTokenBalances: [
            tokenBalance(1, CREATOR_OWNER, "50000"),
            tokenBalance(2, FEE_RECIPIENT, "0"),
          ],
          postTokenBalances: [
            tokenBalance(1, CREATOR_OWNER, "40000"),
            tokenBalance(2, FEE_RECIPIENT, FEE_DUE_MINOR),
          ],
        },
        transaction: { signatures: [FEE_SIGNATURE] },
      };
    };
  }

  function buildFeeOnlySettlement() {
    return {
      schemaVersion: "1",
      kind: "reward-settlement",
      projectId: "eliza",
      cycleId: "2026-07",
      allocationSha256: ALLOCATION_SHA256,
      settledAt: SETTLED_AT,
      currency: "USDC",
      chain: "solana",
      status: "failed",
      recipients: [
        {
          intentId: INTENT_ID,
          approvedMinor: "1000000",
          paidMinor: "0",
          state: "pending",
        },
      ],
      attempts: [],
      platformFee: {
        recipient: FEE_RECIPIENT,
        dueMinor: FEE_DUE_MINOR,
        paidMinor: "0",
        signature: FEE_SIGNATURE,
        state: "reported",
      },
      totals: {
        approvedMinor: "1000000",
        paidMinor: "0",
        feeMinor: "10000",
      },
    };
  }

  it("rejects a project-vault fee transfer that predates the plan", async () => {
    await expect(
      verifyRewardSettlementOnchain({
        allocation: vaultAllocation,
        expectedAllocationSha256: ALLOCATION_SHA256,
        fundingInstruments,
        plan: vaultPlan,
        settlement: buildFeeOnlySettlement(),
        getTransaction: buildFeeGetTransaction(PRE_PLAN_BLOCK_TIME),
      }),
    ).rejects.toThrow(/predates its plan/i);
  });

  it("accepts the same project-vault fee transfer after the plan was created", async () => {
    const verified = await verifyRewardSettlementOnchain({
      allocation: vaultAllocation,
      expectedAllocationSha256: ALLOCATION_SHA256,
      fundingInstruments,
      plan: vaultPlan,
      settlement: buildFeeOnlySettlement(),
      getTransaction: buildFeeGetTransaction(POST_PLAN_BLOCK_TIME),
    });
    expect(verified).toHaveLength(1);
    const [fee] = verified as [VerifiedSolanaTransaction];
    expect(fee.blockTime).toBe(POST_PLAN_BLOCK_TIME);
  });
});
