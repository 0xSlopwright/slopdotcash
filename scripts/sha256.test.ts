import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  assemblePoints,
  type PointAward,
  type PointRevision,
  type PointsIndex,
  type PointsJournal,
  pointMembers,
} from "../src/lib/points";
import { sha256Hex } from "../src/lib/sha256";

function nodeHash(input: string | Uint8Array) {
  return createHash("sha256").update(input).digest("hex");
}

/** Independent generator-side digests, including a predecessor-linked correction. */
function pointsFixture() {
  const award: PointAward = {
    key: nodeHash(
      JSON.stringify([
        "slopdotcash",
        "U_kgDOExampleA",
        "merged-pull-request",
        "PR_example",
      ]),
    ),
    actor: { id: "U_kgDOExampleA", login: "example-contributor" },
    projectId: "slopdotcash",
    category: "merged-pull-request",
    amount: 30,
    occurredAt: "2026-09-15T00:00:00.000Z",
    sourceId: "PR_example",
    sourceUrl: "https://github.com/SlopDotCash/slopdotcash/pull/1",
    workUnitId: "wu_example",
    provisional: true,
  };
  const revision = (
    award: PointAward,
    recordedAt: string,
    previous: string | null = null,
  ): PointRevision => {
    const body = {
      previous,
      recordedAt,
      sourceDigest: "a".repeat(64),
      sourceRule: "slop-score-v2",
      award,
    };
    return { id: nodeHash(JSON.stringify(body)), ...body };
  };
  const original = revision(award, "2026-10-01T00:00:00.000Z");
  const correction = revision(
    { ...award, amount: 90, provisional: false },
    "2026-10-02T00:00:00.000Z",
    original.id,
  );
  const review = revision(
    {
      ...award,
      key: nodeHash(
        JSON.stringify([
          "slopdotcash",
          award.actor.id,
          "substantive-review",
          "PRR_example",
        ]),
      ),
      category: "substantive-review",
      amount: 10,
      occurredAt: "2026-10-02T00:00:00.000Z",
      sourceId: "PRR_example",
      sourceUrl:
        "https://github.com/SlopDotCash/slopdotcash/pull/2#pullrequestreview-1",
      workUnitId: "wu_review",
      provisional: false,
    },
    "2026-10-02T00:00:00.000Z",
  );
  const journal: PointsJournal = {
    schemaVersion: "1",
    ruleVersion: "slop-points-v1",
    generatedAt: "2026-10-03T00:00:00.000Z",
    coverage: [],
    revisions: [original, correction, review],
  };
  const parts = Array.from({ length: 16 }, (_, i) => {
    const rows = journal.revisions
      .map((revision, sequence) => ({ sequence, revision }))
      .filter((row) => row.revision.award.key.startsWith(i.toString(16)));
    return `${JSON.stringify(rows)}\n`;
  });
  const index: PointsIndex = {
    schemaVersion: "1",
    ruleVersion: journal.ruleVersion,
    generatedAt: journal.generatedAt,
    coverage: journal.coverage,
    revisionCount: journal.revisions.length,
    shards: parts.map((part, i) => ({
      path: `/data/points/${i.toString(16)}.json`,
      sha256: nodeHash(part),
      count: JSON.parse(part).length,
    })),
  };
  return { journal, index, parts, correction, review };
}

describe("browser-safe SHA-256", () => {
  it("matches Node for UTF-8, block boundaries and offset byte views", () => {
    const inputs: (string | Uint8Array)[] = [
      "",
      "abc",
      "Slop 積分 🦊\u0000\ud800",
      "a".repeat(1_000_000),
    ];
    for (const length of [55, 56, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const bytes = Uint8Array.from({ length: length + 6 }, (_, i) => i % 256);
      inputs.push("a".repeat(length), bytes.subarray(3, length + 3));
    }
    for (const input of inputs) expect(sha256Hex(input)).toBe(nodeHash(input));
  });

  it("assembles generator-certified shards without changing corrected point totals", () => {
    const { journal, index, parts, correction, review } = pointsFixture();
    const assembled = assemblePoints(index, parts);
    expect(assembled).toEqual(journal);
    expect(pointMembers(assembled, "2026-10")).toEqual([
      {
        actor: correction.award.actor,
        total: 100,
        monthly: 10,
        firstContributionAt: "2026-09-15T00:00:00.000Z",
        projects: 1,
        badges: ["First accepted contribution", "First qualifying review"],
        awards: [review.award, correction.award],
      },
    ]);
  });

  it("still rejects changed shard bytes", () => {
    const { index, parts } = pointsFixture();
    parts[0] += " ";
    expect(() => assemblePoints(index, parts)).toThrow(
      "Points shard checksum mismatch",
    );
  });

  it("still rejects a changed revision when the outer shard checksum is valid", () => {
    const { index, parts } = pointsFixture();
    const shard = parts.findIndex((part) => JSON.parse(part).length > 0);
    const rows = JSON.parse(parts[shard]);
    rows[0].revision.award.amount += 10;
    parts[shard] = `${JSON.stringify(rows)}\n`;
    index.shards[shard].sha256 = nodeHash(parts[shard]);
    expect(() => assemblePoints(index, parts)).toThrow(
      "Broken points revision chain",
    );
  });
});
