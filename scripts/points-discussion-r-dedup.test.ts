import { describe, expect, it } from "bun:test";
import {
  POINTS_RULE,
  type PointAward,
  type PointsJournal,
  pointMembers,
} from "../src/lib/points";

const AT = "2026-10-14T17:30:00.000Z";
const MONTH = "2026-10";

function award(over: Partial<PointAward> & { key: string }): PointAward {
  return {
    actor: { id: "1", login: "alice" },
    projectId: "slopdotcash",
    category: "evaluated-contribution",
    amount: 100,
    occurredAt: `${MONTH}-05T10:00:00.000Z`,
    sourceId: "e1",
    sourceUrl: "https://github.com/SlopDotCash/slopdotcash/pull/5",
    workUnitId: "w1",
    provisional: false,
    ...over,
  };
}

function journal(awards: PointAward[]): PointsJournal {
  return {
    schemaVersion: "1",
    ruleVersion: POINTS_RULE,
    generatedAt: AT,
    coverage: [],
    revisions: awards.map((a, i) => ({
      id: `r${i}`,
      previous: null,
      recordedAt: AT,
      sourceDigest: "digest",
      sourceRule: POINTS_RULE,
      award: a,
    })),
  };
}

function aliceTotal(j: PointsJournal): number {
  return pointMembers(j, MONTH)[0]?.total ?? 0;
}

describe("evaluated-review dedup set fragment scoping", () => {
  it("dedups a substantive review when the evaluated award uses a discussion_r URL", () => {
    const evaluated = award({
      key: "e1",
      category: "evaluated-contribution",
      amount: 100,
      sourceUrl:
        "https://github.com/SlopDotCash/slopdotcash/pull/5#discussion_r123",
      workUnitId: "w1",
    });
    const review = award({
      key: "r1",
      category: "substantive-review",
      amount: 10,
      sourceId: "s1",
      sourceUrl:
        "https://github.com/SlopDotCash/slopdotcash/pull/5#pullrequestreview-1",
      workUnitId: "w2",
    });
    expect(aliceTotal(journal([evaluated, review]))).toBe(100);
  });

  it("still dedups through the legacy pullrequestreview fragment", () => {
    const evaluated = award({
      key: "e1",
      sourceUrl:
        "https://github.com/SlopDotCash/slopdotcash/pull/5#pullrequestreview-9",
      workUnitId: "w1",
    });
    const review = award({
      key: "r1",
      category: "substantive-review",
      amount: 10,
      sourceId: "s1",
      sourceUrl:
        "https://github.com/SlopDotCash/slopdotcash/pull/5#pullrequestreview-1",
      workUnitId: "w2",
    });
    expect(aliceTotal(journal([evaluated, review]))).toBe(100);
  });

  it("does not let a non-evaluated discussion_r award populate the dedup set", () => {
    const review = award({
      key: "r1",
      category: "substantive-review",
      amount: 10,
      sourceId: "s1",
      sourceUrl:
        "https://github.com/SlopDotCash/slopdotcash/pull/5#discussion_r123",
      workUnitId: "w2",
    });
    // Without the parentheses the fragment disjunction escapes the
    // amount/category predicates, so this review suppresses itself.
    expect(aliceTotal(journal([review]))).toBe(10);
  });

  it("does not let a zero-amount discussion_r award populate the dedup set", () => {
    const correction = award({
      key: "e0",
      amount: 0,
      sourceUrl:
        "https://github.com/SlopDotCash/slopdotcash/pull/5#discussion_r1",
      workUnitId: "w1",
    });
    const review = award({
      key: "r1",
      category: "substantive-review",
      amount: 10,
      sourceId: "s1",
      sourceUrl:
        "https://github.com/SlopDotCash/slopdotcash/pull/5#discussion_r123",
      workUnitId: "w2",
    });
    expect(aliceTotal(journal([correction, review]))).toBe(10);
  });

  it("dedups when the evaluated award URL differs only in repo-path casing", () => {
    const evaluated = award({
      key: "e1",
      category: "evaluated-contribution",
      amount: 100,
      sourceUrl:
        "https://github.com/slopdotcash/SLOPDOTCASH/pull/5#discussion_r123",
      workUnitId: "w1",
    });
    const review = award({
      key: "r1",
      category: "substantive-review",
      amount: 10,
      sourceId: "s1",
      sourceUrl:
        "https://github.com/SlopDotCash/slopdotcash/pull/5#pullrequestreview-1",
      workUnitId: "w2",
    });
    // The journal validator accepts owner/repo casing variants and preserves
    // the raw URL; without case normalization the dedup key misses and the
    // substantive review double-counts (110 instead of 100).
    expect(aliceTotal(journal([evaluated, review]))).toBe(100);
  });
});
