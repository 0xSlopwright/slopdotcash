/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { preparePullRequestLedger } from "../../scripts/prepare-pr-ledger";
import {
  assertLeaderboardSnapshot,
  assertPublishableLeaderboardSnapshot,
  createLeaderboardSnapshot,
  type LeaderboardSnapshot,
  type MergedPullRequestOutcome,
} from "../../src/lib/leaderboard";
import { snapshotFixture } from "../fixtures";

function generatedSnapshot(): LeaderboardSnapshot {
  const fixture = snapshotFixture("2026-07-30T00:00:00.000Z");
  const mergedPullRequestOutcomes: MergedPullRequestOutcome[] = [];
  for (const [actorIndex, count] of [3, 3, 2, 2, 1].entries()) {
    const login = `contributor-${actorIndex}`;
    const actor = {
      id: `U_rank_${actorIndex}`,
      login,
      avatarUrl: `https://avatars.githubusercontent.com/u/${actorIndex + 1}`,
      url: `https://github.com/${login}`,
      kind: "User" as const,
    };
    for (let index = 0; index < count; index += 1) {
      const number = actorIndex * 10 + index + 1;
      mergedPullRequestOutcomes.push({
        id: `PR_rank_${number}`,
        number,
        title: "Accepted contribution",
        url: `https://github.com/elizaOS/eliza/pull/${number}`,
        body: "",
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
        mergedAt: "2026-07-29T00:00:00.000Z",
        author: actor,
        additions: 1,
        deletions: 0,
        baseRefName: "develop",
        commits: null,
      });
    }
  }
  return createLeaderboardSnapshot({
    generatedAt: fixture.generatedAt,
    windowFrom: fixture.window.from,
    windowTo: fixture.window.to,
    verificationWindowFrom: fixture.window.from,
    sourceUpdatedAt: "2026-07-29T00:00:00.000Z",
    source: {
      ...fixture.source,
      evidenceVerification: {
        ...fixture.source.evidenceVerification,
        sourceCount: 0,
        artifactCount: 0,
      },
    },
    mergedPullRequestOutcomes,
    mergedPullRequests: [],
    detailEligibleMergedPullRequestIds: [],
    closedIssueCount: 0,
    resolvedIssues: [],
    openIssues: [],
    openPullRequests: [],
    verifiedEvidence: [],
  });
}

test("normal collection publishes equal-score ranks and skips tied positions", () => {
  const snapshot = generatedSnapshot();
  expect(snapshot.leaders.map((entry) => entry.rank)).toEqual([1, 1, 3, 3, 5]);
  expect(snapshot.leaders.map((entry) => entry.scoreThirds)).toEqual([
    72, 72, 54, 54, 30,
  ]);
  expect(snapshot.leaders.map((entry) => entry.actor.login)).toEqual([
    "contributor-0",
    "contributor-1",
    "contributor-2",
    "contributor-3",
    "contributor-4",
  ]);
  assertPublishableLeaderboardSnapshot(snapshot);
});

test("fresh publication rejects legacy, mixed, and incorrectly skipped ranks", () => {
  const snapshot = generatedSnapshot();
  const legacy = structuredClone(snapshot);
  legacy.leaders.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  assertLeaderboardSnapshot(legacy);
  expect(() => assertPublishableLeaderboardSnapshot(legacy)).toThrow(
    "equal-score competition ranks",
  );
  const mixed = structuredClone(snapshot);
  mixed.leaders[3].rank = 4;
  expect(() => assertLeaderboardSnapshot(mixed)).toThrow(
    "equal-score competition ranks",
  );
  expect(() => preparePullRequestLedger(mixed)).toThrow(
    "equal-score competition ranks",
  );
  const wrongSkip = structuredClone(snapshot);
  wrongSkip.leaders[4].rank = 4;
  expect(() => assertPublishableLeaderboardSnapshot(wrongSkip)).toThrow(
    "equal-score competition ranks",
  );
});

test("schema 6 fallback normalizes deployed ranks without rewriting historical data", () => {
  const bytes = readFileSync(
    new URL("../../cycles/eliza/2026-09/source-snapshot.json", import.meta.url),
  );
  const deployed: LeaderboardSnapshot = JSON.parse(bytes.toString("utf8"));
  assertLeaderboardSnapshot(deployed);
  const original = structuredClone(deployed);
  const adapted = preparePullRequestLedger(deployed);
  const tieIndex = deployed.leaders.findIndex(
    (entry, index) =>
      index > 0 &&
      entry.scoreThirds === deployed.leaders[index - 1].scoreThirds,
  );
  expect(tieIndex).toBeGreaterThan(0);
  expect(deployed.leaders[tieIndex].rank).not.toBe(
    deployed.leaders[tieIndex - 1].rank,
  );
  expect(adapted.leaders[tieIndex].rank).toBe(
    adapted.leaders[tieIndex - 1].rank,
  );
  for (const entry of adapted.leaders) {
    expect(entry.rank).toBe(
      1 +
        adapted.leaders.filter((other) => other.scoreThirds > entry.scoreThirds)
          .length,
    );
  }
  expect({ ...adapted, leaders: original.leaders }).toEqual(original);
  expect(deployed).toEqual(original);
  expect(
    readFileSync(
      new URL(
        "../../cycles/eliza/2026-09/source-snapshot.json",
        import.meta.url,
      ),
    ),
  ).toEqual(bytes);
});

test("schema 5 fallback rebuilds equal-score ranks from the accepted ledger", () => {
  const snapshot = generatedSnapshot();
  const deployed = {
    ...structuredClone(snapshot),
    schemaVersion: "5",
  };
  deployed.leaders.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  const adapted = preparePullRequestLedger(deployed);
  expect(adapted.leaders.map((entry) => entry.rank)).toEqual([1, 1, 3, 3, 5]);
  expect(adapted.leaders).toEqual(snapshot.leaders);
  expect(adapted.ledger).toEqual(snapshot.ledger);
  assertPublishableLeaderboardSnapshot(adapted);
});
