import { expect, it } from "bun:test";
import {
  appendPointAwards,
  emptyPointsJournal,
  type PointAward,
  pointKey,
  pointMembers,
} from "../src/lib/points";

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
