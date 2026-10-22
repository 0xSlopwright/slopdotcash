import { expect, it } from "bun:test";
import {
  appendPointAwards,
  emptyPointsJournal,
  type PointAward,
  pointKey,
  pointMembers,
} from "../src/lib/points";

it("keeps renamed identities through grouping, project filters and assessed zero without moving points", () => {
  const t0 = "2026-10-15T00:00:00.000Z";
  const t1 = "2026-10-16T00:00:00.000Z";
  const t2 = "2026-10-17T00:00:00.000Z";
  const first = review(
    "review1",
    "https://github.com/elizaOS/asi/pull/1#pullrequestreview-1",
  );
  const duplicate = review(
    "review2",
    "https://github.com/elizaOS/asi/pull/1#pullrequestreview-2",
  );
  const reused: PointAward = {
    ...first,
    key: pointKey("asi", "U_other", first.category, "review3"),
    actor: { id: "U_other", login: "alice" },
    sourceId: "review3",
    sourceUrl: "https://github.com/elizaOS/asi/pull/2#pullrequestreview-3",
    workUnitId: "review3",
  };
  let journal = appendPointAwards(
    emptyPointsJournal(t0),
    [first, duplicate, reused],
    "a".repeat(64),
    "slop-score-v2",
    t0,
  );
  const before = pointMembers(journal, "2026-10", "asi");
  const preserved = JSON.stringify(journal);
  journal = appendPointAwards(
    journal,
    [{ ...duplicate, actor: { ...actor, login: "renamed" } }],
    "b".repeat(64),
    "slop-score-v2",
    t1,
  );
  const grouped = pointMembers(journal, "2026-10", "asi");
  expect(grouped.find((m) => m.actor.id === actor.id)?.actor.login).toBe(
    "renamed",
  );
  expect(
    grouped.map((m) => ({ ...m, actor: { ...m.actor, login: "alice" } })),
  ).toEqual(before);
  expect(
    JSON.stringify({
      ...journal,
      generatedAt: t0,
      revisions: journal.revisions.slice(0, 3),
    }),
  ).toBe(preserved);
  const zero: PointAward = {
    ...first,
    key: pointKey("eliza", actor.id, "merged-pull-request", "PR_zero"),
    actor: { ...actor, login: "latest-login" },
    projectId: "eliza",
    category: "merged-pull-request",
    amount: 0,
    sourceId: "PR_zero",
    sourceUrl: "https://github.com/elizaOS/eliza/pull/1",
    workUnitId: "PR_zero",
    provisional: true,
  };
  journal = appendPointAwards(
    journal,
    [zero],
    "c".repeat(64),
    "slop-score-v2",
    t2,
    new Map([
      [
        zero.key,
        {
          sourceId: `value:${"d".repeat(64)}`,
          effectiveAt: t2,
          reason: "Source-bound assessed zero.",
        },
      ],
    ]),
  );
  const bytes = JSON.stringify(journal);
  const filtered = pointMembers(journal, "2026-10", "asi");
  expect(filtered.find((m) => m.actor.id === actor.id)?.actor.login).toBe(
    "latest-login",
  );
  expect(filtered.find((m) => m.actor.id === "U_other")?.actor.login).toBe(
    "alice",
  );
  expect(
    filtered.map((m) => ({ ...m, actor: { ...m.actor, login: "alice" } })),
  ).toEqual(before);
  expect(pointMembers(journal, "2026-10", "eliza")).toEqual([
    {
      actor: zero.actor,
      total: 0,
      monthly: 0,
      firstContributionAt: zero.occurredAt,
      projects: 0,
      badges: [],
      awards: [],
    },
  ]);
  expect(JSON.stringify(journal)).toBe(bytes);
});

const at = "2026-10-15T00:00:00.000Z";
const actor = { id: "U_alice", login: "alice" };
function review(sourceId: string, sourceUrl: string): PointAward {
  return {
    key: pointKey("asi", actor.id, "substantive-review", sourceId),
    actor,
    projectId: "asi",
    category: "substantive-review",
    amount: 10,
    occurredAt: "2026-10-05T00:00:00.000Z",
    sourceId,
    sourceUrl,
    workUnitId: sourceId,
    provisional: false,
  };
}

it.each([
  "https://github.com/ELIZAOS/ASI/pull/1#pullrequestreview-2",
  "https://github.com/SlopDotCash/asi/pull/1#pullrequestreview-2",
])("groups ordinary reviews of the same PR through %s", (sourceUrl) => {
  const journal = appendPointAwards(
    emptyPointsJournal(at),
    [
      review(
        "review1",
        "https://github.com/elizaOS/asi/pull/1#pullrequestreview-1",
      ),
      review("review2", sourceUrl),
      review(
        "review3",
        "https://github.com/elizaOS/asi/pull/2#pullrequestreview-3",
      ),
    ],
    "a".repeat(64),
    "slop-score-v2",
    at,
  );
  const member = pointMembers(journal, "2026-10", "asi")[0];
  expect(member?.total).toBe(20);
  expect(member?.monthly).toBe(20);
  expect(member?.awards).toHaveLength(2);
  expect(journal.revisions).toHaveLength(3);
});
