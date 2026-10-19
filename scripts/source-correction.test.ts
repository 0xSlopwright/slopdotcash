import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type LeaderboardSnapshot,
  PAYMENT_REVIEW_POLICY,
  PAYMENT_REVIEW_POLICY_AT,
  paymentReviewSnapshot,
} from "../src/lib/leaderboard";
import { findProject } from "../src/lib/projects.mjs";
import { prepareSourceCorrection, sha256 } from "./source-correction";

const PROVENANCE_ERROR =
  "Original collection provenance differs from preparation";
// The synthetic quality evidence below is intentionally not a valid quality
// record: reaching its validation error proves the provenance stage passed.
const QUALITY_STAGE_ERROR =
  "Invalid preparation fields: expected schemaVersion,projectId,cycleId,sourceSnapshotSha256,closureCensus,events,closures";

const archived = JSON.parse(
  readFileSync(
    "tests/fixtures/history/cycles/eliza/2026-09/source-snapshot.json",
    "utf8",
  ),
) as LeaderboardSnapshot;

/**
 * The archived September snapshot moved to the October cycle window, with a
 * payment review basis that removes one event of the last-ranked leader, so
 * the payment review ledger is one entry shorter than the raw ledger.
 */
function octoberSnapshot(): LeaderboardSnapshot {
  const snapshot = structuredClone(archived) as Record<string, any>;
  snapshot.window = {
    days: 35,
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-11-05T00:00:00.000Z",
  };
  snapshot.source.verificationWindow = { ...snapshot.window };
  snapshot.generatedAt = "2026-11-05T00:00:00.000Z";
  snapshot.source.fetchedAt = snapshot.generatedAt;
  snapshot.source.cutoffAt = snapshot.window.to;
  const last = [...snapshot.leaders].sort((a, b) => a.rank - b.rank).at(-1);
  const event = snapshot.ledger.find(
    (entry: any) => entry.actor.id === last.actor.id,
  );
  const key =
    event.category === "substantive-review"
      ? "substantiveReviews"
      : event.category === "merged-pull-request"
        ? "mergedPullRequests"
        : "evaluatedContributions";
  const leaders = snapshot.leaders.map((leader: any) =>
    leader.actor.id !== last.actor.id
      ? leader
      : {
          ...leader,
          score: Math.floor((leader.scoreThirds - event.scoreThirds) / 3),
          scoreThirds: leader.scoreThirds - event.scoreThirds,
          points: {
            ...leader.points,
            [key]: leader.points[key] - event.points,
          },
          pointThirds: {
            ...leader.pointThirds,
            [key]: leader.pointThirds[key] - event.scoreThirds,
          },
          acceptedOutcomes: {
            ...leader.acceptedOutcomes,
            [key]: leader.acceptedOutcomes[key] - 1,
          },
        },
  );
  snapshot.paymentReviewBasis = {
    policy: PAYMENT_REVIEW_POLICY,
    effectiveAt: PAYMENT_REVIEW_POLICY_AT,
    leaders,
    ledger: [],
    removedEventIds: [event.id],
    removedAttributionIds: [],
    attributionOrder: snapshot.attributions.map((a: any) => a.id),
    attributions: [],
    invalidAttributionMarkers: snapshot.invalidAttributionMarkers,
    attributionCoverage: snapshot.attributionCoverage,
    opportunities: snapshot.opportunities,
    reviewExclusions: snapshot.reviewExclusions ?? [],
  };
  return snapshot as LeaderboardSnapshot;
}

function inputs(
  snapshot: LeaderboardSnapshot,
  cycleId: string,
  snapshotLedgerCount: number,
  period: { from: string; to: string; observedAt: string },
) {
  const snapshotBytes = JSON.stringify(snapshot);
  const auditBytes = "audit-bytes";
  const historyBytes = "history-bytes";
  const preparationBytes = JSON.stringify({
    projectId: "eliza",
    cycleId,
    sourceSnapshotSha256: sha256(snapshotBytes),
    sourceAuditSha256: sha256(auditBytes),
    observedAt: period.observedAt,
    provenance: {
      ruleVersion: snapshot.ruleVersion,
      walletObservationsSha256: sha256("wallets"),
      snapshotFrom: snapshot.window.from,
      snapshotTo: snapshot.window.to,
      periodFrom: period.from,
      periodTo: period.to,
      snapshotLedgerCount,
      sourceMergedPullRequests: snapshot.source.counts.mergedPullRequests,
      mergedCensus: 200,
      scoredMerges: 100,
    },
    counts: { contributors: 1, events: 1, scoreThirds: "3", weight: "10" },
    contributors: [
      {
        actor: { id: "U_test1", login: "alice" },
        scoreThirds: "3",
        weight: "10",
        eventCount: 1,
        eventIdsSha256: sha256("events"),
        wallet: null,
        lookupUnavailable: false,
      },
    ],
  });
  return {
    preparationBytes,
    snapshotBytes,
    auditBytes,
    archiveBytes: snapshotBytes,
    historyBytes,
    qualityBytes: "{}",
    request: {
      schemaVersion: "1",
      kind: "historical-review-correction-request",
      projectId: "eliza",
      cycleId,
      predecessorPreparationSha256: sha256(preparationBytes),
      archiveSha256: sha256(snapshotBytes),
      historySha256: sha256(historyBytes),
      eventIds: ["evt-1"],
      reason: "Recover events the production review basis excluded.",
    },
    proposals: [],
  };
}

async function stageError(
  snapshot: LeaderboardSnapshot,
  cycleId: string,
  count: number,
  period: { from: string; to: string; observedAt: string },
): Promise<string> {
  try {
    await prepareSourceCorrection(inputs(snapshot, cycleId, count, period));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("prepareSourceCorrection did not reject the fixture");
}

const octoberPeriod = {
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-11-01T00:00:00.000Z",
  observedAt: "2026-11-05T00:00:00.000Z",
};
const septemberPeriod = {
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-10-01T00:00:00.000Z",
  observedAt: "2026-10-01T00:00:00.000Z",
};

describe("historical review correction provenance", () => {
  test("the eliza project is a monthly pool", () => {
    expect(findProject("eliza")?.reward.kind).toBe("monthly-pool");
  });

  test("accepts a 2026-10 preparation recording the payment review ledger count", async () => {
    const snapshot = octoberSnapshot();
    const paymentCount = paymentReviewSnapshot(snapshot).ledger.length;
    expect(paymentCount).toBe(snapshot.ledger.length - 1);
    expect(
      await stageError(snapshot, "2026-10", paymentCount, octoberPeriod),
    ).toBe(QUALITY_STAGE_ERROR);
  }, 30_000);

  test("refuses a 2026-10 preparation recording the raw ledger count", async () => {
    const snapshot = octoberSnapshot();
    expect(
      await stageError(
        snapshot,
        "2026-10",
        snapshot.ledger.length,
        octoberPeriod,
      ),
    ).toBe(PROVENANCE_ERROR);
  }, 30_000);

  test("keeps the raw count for a pre-2026-10 preparation", async () => {
    expect(
      await stageError(
        archived,
        "2026-09",
        archived.ledger.length,
        septemberPeriod,
      ),
    ).toBe(QUALITY_STAGE_ERROR);
    expect(
      await stageError(
        archived,
        "2026-09",
        archived.ledger.length - 1,
        septemberPeriod,
      ),
    ).toBe(PROVENANCE_ERROR);
  }, 30_000);
});
