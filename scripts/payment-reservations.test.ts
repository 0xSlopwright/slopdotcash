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
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_PLATFORM_FEE_RECIPIENT,
  platformFeeRecipientForNetwork,
  SOLANA_PLATFORM_FEE_RECIPIENT,
} from "../src/lib/fresh-cycle-policy.mjs";
import { assertFundingCommitments } from "../src/lib/funding-instruments.mjs";
import { fundingReviewProposalSha256 } from "../src/lib/funding-review-submission";
import {
  draftPaymentReservation,
  parsePaymentReservationLedger,
  paymentRecordBytes,
} from "../src/lib/payment-reservations";
import { assertProjectDefinition } from "../src/lib/project-schema.mjs";
import { assertRewardAllocationManifest } from "../src/lib/rewards";
import {
  createNetworkSettlementExecutionPlan,
  MAX_TRANSFERS_PER_PLAN,
} from "../src/lib/settlement-plan";
import { reviewedReservationPolicy } from "./check-payment-reservations";
import type { PaymentCheckpointSnapshot } from "./payment-checkpoints";

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

/**
 * A fresh-cycle policy may name only the published fee recipient of the
 * project's settlement network (protocol/fresh-cycle-payments.md). A project
 * vault plan carries no platform fee, so the plan builder never checks the
 * recipient; the manifest schema and the reservation gate must refuse the
 * other network's address, and any network without a fresh-cycle instrument,
 * before a permanent reservation binds it.
 */
describe("a fresh-cycle policy names its settlement network's fee recipient", () => {
  const eliza = JSON.parse(
    readFileSync("tests/fixtures/projects/eliza.json", "utf8"),
  );

  async function solanaProject(feeRecipient: string) {
    const { instrument } = projectVaultInstrument();
    return {
      ...eliza,
      reward: {
        ...eliza.reward,
        cycleCaps: [
          { cycleId: CYCLE, monthlyCapMinor: "10000000000" },
          ...eliza.reward.cycleCaps,
        ],
      },
      funding: {
        ...eliza.funding,
        commitments: [instrument],
        freshCyclePaymentPolicy: {
          schemaVersion: "1",
          kind: "fresh-cycle-payment-policy",
          projectId: "eliza",
          cycleId: CYCLE,
          effectiveAt: "2026-07-31T00:00:00.000Z",
          planningExpiresAt: "2026-09-01T00:00:00.000Z",
          instrumentSha256: await fundingReviewProposalSha256(
            new TextEncoder().encode(JSON.stringify(instrument)),
          ),
          feeRecipient,
        },
      },
    };
  }

  it("accepts the Solana recipient on a Solana project", async () => {
    const project = await solanaProject(SOLANA_PLATFORM_FEE_RECIPIENT);
    expect(() => assertProjectDefinition(project)).not.toThrow();
    expect(() => reviewedReservationPolicy(project)).not.toThrow();
  });

  it("the manifest schema refuses the Base recipient on a Solana project", async () => {
    const project = await solanaProject(BASE_PLATFORM_FEE_RECIPIENT);
    expect(() => assertProjectDefinition(project)).toThrow(
      /fee recipient of the settlement network/,
    );
  });

  it("the reservation gate refuses the Base recipient on a Solana project", async () => {
    const project = await solanaProject(BASE_PLATFORM_FEE_RECIPIENT);
    expect(() => reviewedReservationPolicy(project)).toThrow(
      /fee recipient of the settlement network/,
    );
  });

  // Only Base and Solana have a fresh-cycle instrument. The gate reads the
  // manifest without the project schema, so it must not settle any other
  // network as Solana.
  it.each([
    ["Robinhood Chain", "robinhood"],
    ["an unknown network", "ethereum"],
    ["a missing network", null],
  ])("the reservation gate refuses %s", async (_label, chain) => {
    const solana = await solanaProject(SOLANA_PLATFORM_FEE_RECIPIENT);
    const project = { ...solana, reward: { ...solana.reward, chain } };
    expect(() => assertProjectDefinition(project)).toThrow();
    expect(() => reviewedReservationPolicy(project)).toThrow(
      /Base or Solana settlement network/,
    );
  });

  it("maps each settlement network to its published recipient", () => {
    expect(platformFeeRecipientForNetwork("solana")).toBe(
      SOLANA_PLATFORM_FEE_RECIPIENT,
    );
    expect(platformFeeRecipientForNetwork("base")).toBe(
      BASE_PLATFORM_FEE_RECIPIENT,
    );
    expect(platformFeeRecipientForNetwork("robinhood")).toBeNull();
  });
});

/**
 * The reservation gate and the checkpoint chain compare payment records with
 * their exact `paymentRecordBytes`. Biome puts an array that fits on one line
 * there, so it rewrites the one-intent list of a single-contributor
 * reservation: `lint:check` would fail the reservation PR that
 * reward-cycle-actions.yml opens, and the formatted bytes fail the gate. Like
 * `cycles/`, these generated records stay out of the Biome formatter.
 */
describe("pinned payment records stay out of the Biome formatter", () => {
  const biome = (cwd: string, args: string[], input?: Uint8Array) =>
    spawnSync(
      process.execPath,
      [require.resolve("@biomejs/biome/bin/biome"), ...args],
      { cwd, input, encoding: "utf8" },
    );

  it("lint:check accepts a single-contributor reservation and its checkpoint snapshot", async () => {
    const instrument = projectVaultInstrument();
    const reservation = await draftPaymentReservation(
      paymentRecordBytes(approvedAllocation(instrument.instrumentId, 1)),
      {
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
      },
      "2026-08-20T00:00:00.000Z",
      instrument.instrument,
    );
    expect(reservation.intentIds).toHaveLength(1);
    const ledger = paymentRecordBytes([reservation]);
    const snapshot: PaymentCheckpointSnapshot = {
      schemaVersion: "1",
      revision: COMMIT,
      reservations: [reservation],
      policyHistory: [],
      obligationsHistory: [],
      signerHistory: [],
    };

    // The gate takes only the written bytes, and the Biome formatter rewrites
    // them wherever it runs.
    expect(parsePaymentReservationLedger(ledger)).toEqual([reservation]);
    const formatted = biome(
      ".",
      ["format", "--stdin-file-path=payment-record.json"],
      ledger,
    ).stdout;
    expect(formatted).not.toBe(new TextDecoder().decode(ledger));
    expect(() =>
      parsePaymentReservationLedger(new TextEncoder().encode(formatted)),
    ).toThrow(/Noncanonical reservation bytes/);

    const root = mkdtempSync(join(tmpdir(), "slop-pinned-records-"));
    try {
      copyFileSync("biome.json", join(root, "biome.json"));
      mkdirSync(join(root, "funding"));
      mkdirSync(join(root, "protocol", "payment-checkpoints"), {
        recursive: true,
      });
      writeFileSync(join(root, "funding", "payment-reservations.json"), ledger);
      writeFileSync(
        join(root, "protocol", "payment-checkpoints", `${COMMIT}.json`),
        paymentRecordBytes(snapshot),
      );
      const check = biome(root, ["check", "--vcs-enabled=false", "."]);
      expect(`${check.stdout}${check.stderr}`).not.toMatch(
        /payment-(reservations|checkpoints)/,
      );
      expect(check.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
