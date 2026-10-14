/// <reference types="bun-types" />
/**
 * The payment reservation validator must accept every plan the settlement
 * builder can produce. A no-fee plan (every RFC #500 project vault) carries one
 * intent per contributor transfer, so it reaches the full transfer-plan bound;
 * the reservation bound must therefore equal MAX_TRANSFERS_PER_PLAN, not one
 * less. This reproduces a valid 200-contributor project-vault cycle that the
 * builder accepts and the reservation gate rejected.
 */
import { describe, expect, it } from "bun:test";
import { assertFundingCommitments } from "../src/lib/funding-instruments.mjs";
import { fundingReviewProposalSha256 } from "../src/lib/funding-review-submission";
import {
  draftPaymentReservation,
  paymentRecordBytes,
} from "../src/lib/payment-reservations";
import { assertRewardAllocationManifest } from "../src/lib/rewards";
import {
  createNetworkSettlementExecutionPlan,
  MAX_TRANSFERS_PER_PLAN,
} from "../src/lib/settlement-plan";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) | BigInt(byte);
  let text = "";
  while (number > 0n) {
    text = ALPHABET[Number(number % 58n)] + text;
    number /= 58n;
  }
  let zeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    zeros += 1;
  }
  return "1".repeat(zeros) + text;
}
const SOLANA_FEE_RECIPIENT = "9EyxVhhnCJH4QL5bDsRyukrkHFyitFMuf45UDdLxm4BY";
const COMMIT = "a".repeat(40);
const CYCLE = "2026-07";

function address(seed: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = 1;
  bytes[30] = (seed >> 8) & 0xff;
  bytes[31] = seed & 0xff;
  return base58(bytes);
}

function projectVaultInstrument() {
  const multisig = address(1000);
  const vault = address(1001);
  const instrument = assertFundingCommitments([
    {
      kind: "squads-project-vault",
      network: "solana",
      asset: "USDC",
      multisig,
      vault,
      vaultIndex: 0,
      creatorActorId: "18633264",
      creatorMember: address(1002),
      creatorMultisig: address(1003),
      creatorVaultIndex: 0,
      slopMember: address(1004),
      independentMember: address(1005),
      independentGithub: {
        actorId: "42",
        nodeId: "U_42",
        login: "independent",
      },
      timeLockSeconds: 259200,
      fallbackWaitSeconds: 1209600,
      monthlyCommitment: {
        cycleId: CYCLE,
        amountMinor: "10000000000",
        accessibility: "unknown",
      },
      effectiveAt: "2026-07-01T00:00:00.000Z",
      deadline: "2026-08-01T00:00:00.000Z",
      replacedAt: null,
    },
  ])[0];
  return {
    instrument,
    instrumentId: `squads-project-vault:solana:${multisig}:0:${vault}`,
  };
}

function approvedAllocation(instrumentId: string, count: number) {
  const allocations = Array.from({ length: count }, (_, index) => ({
    intentId: `pay_eliza_2026_07_u${index}`,
    actor: { id: `U_${index}`, login: `contributor${index}` },
    score: 100,
    suggestedMinor: "2000000",
    approvedMinor: "2000000",
    state: "approved" as const,
    wallet: {
      address: address(index + 1),
      chain: "solana" as const,
      observedAt: "2026-08-01T00:00:00.000Z",
      sourceCommit: COMMIT,
      sourceUrl: `https://github.com/contributor${index}/contributor${index}/blob/${COMMIT}/README.md`,
    },
    evidenceEventIds: [`event_${index}`],
    adjustmentReason: null,
    relatedParty: false,
    platformApproval: null,
  }));
  const total = (2000000n * BigInt(count)).toString();
  const fee = ((2000000n * BigInt(count) * 100n) / 10000n).toString();
  return assertRewardAllocationManifest({
    schemaVersion: "1",
    kind: "reward-allocation",
    projectId: "eliza",
    cycleId: CYCLE,
    status: "approved",
    generatedAt: "2026-08-01T00:00:00.000Z",
    approvedAt: "2026-08-15T00:00:00.000Z",
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
    capMinor: "10000000000",
    feeBasisPoints: 100,
    scoringRuleVersion: "slop-score-v2",
    sourceSnapshotSha256: "b".repeat(64),
    allocations,
    totals: { suggestedMinor: total, approvedMinor: total, feeMinor: fee },
    fundingBasis: {
      cycleId: CYCLE,
      fundingState: "committed",
      instrumentId,
      monthlyCapMinor: "10000000000",
      committedMinor: "10000000000",
    },
  });
}

describe("payment reservations cover the full transfer-plan bound", () => {
  it("drafts a reservation for a no-fee plan at MAX_TRANSFERS_PER_PLAN intents", async () => {
    const instrument = projectVaultInstrument();
    const allocation = approvedAllocation(
      instrument.instrumentId,
      MAX_TRANSFERS_PER_PLAN,
    );
    const allocationBytes = paymentRecordBytes(allocation);
    const allocationSha256 = await fundingReviewProposalSha256(allocationBytes);
    const plan = createNetworkSettlementExecutionPlan({
      allocation,
      allocationSha256,
      createdAt: "2026-08-20T00:00:00.000Z",
      feeRecipient: SOLANA_FEE_RECIPIENT,
      instrument: instrument.instrument,
    });
    expect(plan.transfers.length).toBe(MAX_TRANSFERS_PER_PLAN);
    expect(plan.totals.platformFeeMinor).toBe("0");
    const policy = {
      schemaVersion: "1",
      kind: "fresh-cycle-payment-policy",
      projectId: "eliza",
      cycleId: CYCLE,
      effectiveAt: "2026-07-31T00:00:00.000Z",
      planningExpiresAt: "2026-09-01T00:00:00.000Z",
      instrumentSha256: await fundingReviewProposalSha256(
        new TextEncoder().encode(JSON.stringify(instrument.instrument)),
      ),
      feeRecipient: SOLANA_FEE_RECIPIENT,
    };
    const reservation = await draftPaymentReservation(
      allocationBytes,
      policy,
      "2026-08-20T00:00:00.000Z",
      instrument.instrument,
    );
    expect(reservation.intentIds.length).toBe(MAX_TRANSFERS_PER_PLAN);
    expect(reservation.feeMinor).toBe("0");
  });
});
