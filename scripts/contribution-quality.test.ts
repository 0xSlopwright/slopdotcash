/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { assertQualityEvidence } from "../src/lib/contribution-quality";
import type { FundingPreparation } from "../src/lib/funding-review-data";

// The census observation time is part of a frozen, digest-bound evidence
// record. Every other stored-timestamp validator in this repository
// (funding-review-data, funding-readiness, identity-flow, cycle-index)
// requires the canonical UTC form that the census generator emits with
// Date#toISOString: exact milliseconds and a Z suffix.
const preparation = {
  projectId: "slopdotcash",
  cycleId: "2026-10",
  sourceSnapshotSha256: "a".repeat(64),
  contributors: [
    {
      actor: { id: "123", login: "octocat" },
      scoreThirds: "3",
      weight: "10",
      eventCount: 1,
      eventIdsSha256: "b".repeat(64),
      wallet: null,
      lookupUnavailable: false,
    },
  ],
} as unknown as FundingPreparation;

function evidenceWithObservedAt(observedAt: string) {
  return {
    schemaVersion: "1",
    projectId: "slopdotcash",
    cycleId: "2026-10",
    sourceSnapshotSha256: "a".repeat(64),
    closureCensus: {
      method: "repository-created-order-v1",
      sourceSha256: "c".repeat(64),
      observedAt,
      discussionSourceSha256: null,
    },
    events: [
      {
        id: "ev1",
        actorId: "123",
        url: "https://github.com/SlopDotCash/slopdotcash/pull/1",
        title: "Example",
        kind: "implementation",
        scoreThirds: 3,
        weight: "10",
        flags: [],
      },
    ],
    closures: [],
  };
}

describe("assertQualityEvidence census observedAt", () => {
  it("accepts the canonical UTC form the generator emits", () => {
    expect(() =>
      assertQualityEvidence(
        evidenceWithObservedAt("2026-10-14T00:00:00.000Z"),
        preparation,
      ),
    ).not.toThrow();
  });

  it("rejects noncanonical spellings of a census observation time", () => {
    for (const observedAt of [
      "2026-10-14",
      "Oct 14, 2026",
      "2026-10-14T09:00:00+09:00",
      "2026-10-14T00:00:00Z",
      "2026-10-14T00:00:00.000+00:00",
    ]) {
      expect(() =>
        assertQualityEvidence(evidenceWithObservedAt(observedAt), preparation),
      ).toThrow("A complete repository census with source digest is required");
    }
  });

  it("rejects an invalid census observation time", () => {
    expect(() =>
      assertQualityEvidence(evidenceWithObservedAt("not-a-date"), preparation),
    ).toThrow("A complete repository census with source digest is required");
  });
});
