/** Lifecycle boundary preservation against the published July proposal. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertLeaderboardSnapshot } from "../src/lib/leaderboard";
import { createPaymentProjectView } from "../src/lib/project-view";
import { lapseRewardAllocation } from "../src/lib/review-lapse";
import { ensureCompleteCycle } from "../src/lib/reward-cycle";
import { finalizeRewardAllocation } from "../src/lib/reward-finalization";
import { assertRewardAllocationManifest } from "../src/lib/rewards";

const proposal = assertRewardAllocationManifest(
  JSON.parse(readFileSync("cycles/eliza/2026-07/proposal.json", "utf8")),
);
const snapshot = JSON.parse(
  readFileSync("cycles/eliza/2026-07/source-snapshot.json", "utf8"),
);
assertLeaderboardSnapshot(snapshot);
const view = createPaymentProjectView(snapshot, "eliza", "2026-07");
const reviewEnds = Date.parse(proposal.review.endsAt);
const input = {
  projectId: "eliza" as const,
  cycleId: "2026-07",
  generatedAt: proposal.generatedAt,
  sourceSnapshotSha256: proposal.sourceSnapshotSha256,
  snapshot,
};

for (const [field, validate] of [
  [
    "generatedAt",
    (value: string) =>
      ensureCompleteCycle({ ...input, generatedAt: value }, view),
  ],
  [
    "approvedAt",
    (value: string) => finalizeRewardAllocation(proposal, value, reviewEnds),
  ],
  [
    "lapsedAt",
    (value: string) => lapseRewardAllocation(proposal, value, reviewEnds),
  ],
] as const) {
  test(`${field} keeps its exact UTC format and field-specific error`, () => {
    for (const value of [
      "2026-09-04T02:59:01Z",
      "2026-09-04T02:59:01.753+00:00",
      "2026-02-30T00:00:00.000Z",
      "2026-09-04T02:59:60.000Z",
      "not-a-date",
    ]) {
      expect(() => validate(value)).toThrow(
        new TypeError(`${field} must be an exact UTC timestamp`),
      );
    }
  });
}

test("proposal creation still requires the complete month boundary", () => {
  const boundary = Date.parse(view.cycle.to);
  expect(() =>
    ensureCompleteCycle(
      { ...input, generatedAt: new Date(boundary - 1).toISOString() },
      view,
    ),
  ).toThrow("does not have complete closed-window evidence");
  expect(() =>
    ensureCompleteCycle(
      { ...input, generatedAt: new Date(boundary).toISOString() },
      view,
    ),
  ).not.toThrow();
});

test("approval and lapse retain the review deadline and future-clock guards", () => {
  for (const transition of [finalizeRewardAllocation, lapseRewardAllocation]) {
    expect(() =>
      transition(proposal, new Date(reviewEnds - 1).toISOString(), reviewEnds),
    ).toThrow("Reward allocation review period has not ended");
    expect(() =>
      transition(
        proposal,
        new Date(reviewEnds + 5 * 60_000 + 1).toISOString(),
        reviewEnds,
      ),
    ).toThrow("cannot be in the future");
  }
  expect(() =>
    finalizeRewardAllocation(proposal, proposal.review.endsAt, reviewEnds),
  ).toThrow("unresolved proposed payment");
});

test("lapse at the deadline holds undecided rows without approving or mutating", () => {
  const original = structuredClone(proposal);
  const lapsed = lapseRewardAllocation(
    proposal,
    proposal.review.endsAt,
    reviewEnds,
  );
  expect(lapsed.review.lapsedAt).toBe(proposal.review.endsAt);
  expect(lapsed.totals.approvedMinor).toBe("0");
  expect(lapsed.allocations.filter((row) => row.state === "proposed")).toEqual(
    [],
  );
  expect(
    lapsed.allocations.filter((row) => row.hold?.kind === "review-lapsed"),
  ).toHaveLength(
    proposal.allocations.filter((row) => row.state === "proposed").length,
  );
  expect(proposal).toEqual(original);
});

test("manifest validation rejects forged review-lapse states that bypass lapseRewardAllocation", () => {
  const lapsed = lapseRewardAllocation(
    proposal,
    proposal.review.endsAt,
    reviewEnds,
  );
  const lapsedIndex = lapsed.allocations.findIndex(
    (row) => row.hold?.kind === "review-lapsed",
  );
  if (lapsedIndex < 0) throw new Error("Expected a review-lapsed row");

  const withApprovedRow = structuredClone(lapsed);
  const approvedRow = withApprovedRow.allocations[lapsedIndex];
  delete approvedRow.hold;
  approvedRow.state = "approved";
  approvedRow.approvedMinor = approvedRow.suggestedMinor;
  withApprovedRow.totals.approvedMinor = approvedRow.approvedMinor;
  withApprovedRow.totals.feeMinor = (
    BigInt(approvedRow.approvedMinor) / 100n
  ).toString();
  expect(() => assertRewardAllocationManifest(withApprovedRow)).toThrow(
    "lapsed allocation requires a proposed manifest with lapsed rows and no approved payments",
  );

  const withoutLapsedRows = structuredClone(lapsed);
  for (const row of withoutLapsedRows.allocations) {
    if (row.hold?.kind === "review-lapsed") {
      delete row.hold;
      row.state = "excluded";
    }
  }
  expect(() => assertRewardAllocationManifest(withoutLapsedRows)).toThrow(
    "lapsed allocation requires a proposed manifest with lapsed rows and no approved payments",
  );

  const withApprovedStatus = {
    ...structuredClone(lapsed),
    status: "approved",
    approvedAt: proposal.review.endsAt,
  };
  expect(() => assertRewardAllocationManifest(withApprovedStatus)).toThrow(
    "lapsed allocation requires a proposed manifest with lapsed rows and no approved payments",
  );

  const withMismatchedCarry = structuredClone(lapsed);
  withMismatchedCarry.allocations[lapsedIndex].accruedMinor = "0";
  expect(() => assertRewardAllocationManifest(withMismatchedCarry)).toThrow(
    "review-lapsed carry must equal its frozen suggested amount",
  );
});
