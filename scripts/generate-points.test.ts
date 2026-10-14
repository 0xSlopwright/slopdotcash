/// <reference types="bun-types" />
/**
 * Generator-level tests for the retained review history batch in
 * generate-points.ts: corrections, removals, replay, and rejection.
 */
import { describe, expect, it } from "bun:test";
import type { ScoreEvent } from "../src/lib/leaderboard-types";
import {
  appendPointAwards,
  awardForScore,
  emptyPointsJournal,
  latestPoints,
  type PointAward,
  type PointsJournal,
  pointMembers,
} from "../src/lib/points";
import { retainedHistoryCorrections } from "./generate-points";

const DIGEST = "a".repeat(64);
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";

function reviewEvent(scoreThirds: number): ScoreEvent {
  return {
    id: "PR_kwDOMT5cIs8AAAABAr9NwA:reviewer:U_kgDOCzScNQ",
    actor: {
      id: "U_kgDOCzScNQ",
      login: "mashingaan",
      avatarUrl: "https://avatars.githubusercontent.com/u/187997237?v=4",
      url: "https://github.com/mashingaan",
      kind: "User",
    },
    category: "substantive-review",
    points: 1,
    scoreThirds,
    occurredAt: "2026-08-23T11:10:49.000Z",
    repository: "elizaOS/eliza",
    source: {
      id: "PRR_kwDOMT5cIs8AAAABKig2Kw",
      kind: "review",
      number: 25187,
      title: "test(app-core): cover electrobun window construction",
      url: "https://github.com/elizaOS/eliza/pull/25187#pullrequestreview-5002245675",
    },
    reason: "First qualifying substantive, non-self review before merge.",
    workUnitId: "wu_eliza_prr_kwdomt5cis8aaaabkig2kw",
  } as ScoreEvent;
}

function seedJournal(award: PointAward): PointsJournal {
  return appendPointAwards(
    emptyPointsJournal(T0),
    [award],
    DIGEST,
    "slop-score-v2",
    T0,
  );
}

describe("retained review history corrections", () => {
  it("appends exactly one predecessor-linked revision for a changed award and updates the projection", () => {
    const before = awardForScore(reviewEvent(3));
    const after = awardForScore(reviewEvent(1));
    const journal = seedJournal(before);
    const next = appendPointAwards(
      journal,
      [after, ...retainedHistoryCorrections(journal, [after], [])],
      DIGEST,
      "slop-score-v2",
      T1,
    );
    expect(next.revisions.length).toBe(2);
    expect(next.revisions[1]?.previous).toBe(next.revisions[0]?.id);
    expect(next.revisions[1]?.award.amount).toBe(10);
    expect(latestPoints(next).get(before.key)?.award.amount).toBe(10);
    expect(pointMembers(next)[0]?.total).toBe(10);
  });

  it("is idempotent when the same retained input is replayed unchanged", () => {
    const award = awardForScore(reviewEvent(3));
    const journal = seedJournal(award);
    const replayed = appendPointAwards(
      journal,
      [award, ...retainedHistoryCorrections(journal, [award], [])],
      DIGEST,
      "slop-score-v2",
      T1,
    );
    expect(replayed.revisions.length).toBe(1);
    expect(replayed.revisions[0]?.id).toBe(journal.revisions[0]?.id);
  });

  it("appends one zero-valued successor when a retained review is removed, and replay adds no further revision", () => {
    const award = awardForScore(reviewEvent(3));
    const journal = seedJournal(award);
    const corrections = retainedHistoryCorrections(journal, [], []);
    expect(corrections).toEqual([{ ...award, amount: 0 }]);
    const corrected = appendPointAwards(
      journal,
      corrections,
      DIGEST,
      "slop-score-v2",
      T1,
    );
    expect(corrected.revisions.length).toBe(2);
    expect(corrected.revisions[1]?.previous).toBe(corrected.revisions[0]?.id);
    expect(latestPoints(corrected).get(award.key)?.award.amount).toBe(0);
    expect(pointMembers(corrected)).toEqual([]);
    const replayed = appendPointAwards(
      corrected,
      retainedHistoryCorrections(corrected, [], []),
      DIGEST,
      "slop-score-v2",
      T2,
    );
    expect(retainedHistoryCorrections(corrected, [], [])).toEqual([]);
    expect(replayed.revisions.length).toBe(2);
  });

  it("never zeroes an award that a snapshot from this run still supplies", () => {
    const award = awardForScore(reviewEvent(3));
    const journal = seedJournal(award);
    expect(retainedHistoryCorrections(journal, [], [award])).toEqual([]);
  });

  it("rejects a moved or invalid successor and leaves the journal unchanged", () => {
    const award = awardForScore(reviewEvent(3));
    const journal = seedJournal(award);
    const moved = { ...award, occurredAt: "2026-08-24T11:10:49.000Z" };
    expect(() =>
      appendPointAwards(journal, [moved], DIGEST, "slop-score-v2", T1),
    ).toThrow();
    expect(() =>
      appendPointAwards(
        journal,
        [{ ...award, amount: -10 }],
        DIGEST,
        "slop-score-v2",
        T1,
      ),
    ).toThrow();
    expect(journal.revisions.length).toBe(1);
    expect(latestPoints(journal).get(award.key)?.award.amount).toBe(30);
  });
});
