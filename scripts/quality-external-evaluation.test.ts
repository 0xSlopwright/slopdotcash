/// <reference types="bun-types" />
import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertQualityEvidence,
  calculateQualityReview,
  type QualityEvidence,
} from "../src/lib/contribution-quality";
import { loadEvaluatorAwardEvents } from "../src/lib/evaluator-awards";
import { externalSourceId } from "../src/lib/external-sources";
import type { FundingPreparation } from "../src/lib/funding-review-data";
import {
  assertPublishableLeaderboardSnapshot,
  createLeaderboardSnapshot,
  paymentReviewSnapshot,
} from "../src/lib/leaderboard";
import { createPaymentProjectView } from "../src/lib/project-view";
import { findProject } from "../src/lib/projects.mjs";
import { TARGET_REPOSITORIES } from "../src/lib/repositories.mjs";

// The Slop project opted in to external evaluated contributions
// (projects/slopdotcash/project.json reward.externalEvaluations). An award for
// an X post is scored and stays in the October payment review ledger, so the
// payment quality evidence for that cycle must accept it.
const repository = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "quality-external-evaluation-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sourceUrl = "https://x.com/slopcontributor/status/1846000000000000001";
const award = {
  schemaVersion: "1",
  kind: "evaluated-contribution",
  id: "award_external_x_thread",
  projectId: "slopdotcash",
  repository: "SlopDotCash/slopdotcash",
  actor: {
    id: "U_kgDOExternal1",
    login: "slopcontributor",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    url: "https://github.com/slopcontributor",
    kind: "User",
  },
  occurredAt: "2026-10-15T10:00:00.000Z",
  points: 2,
  source: {
    id: externalSourceId(sourceUrl),
    kind: "external",
    platform: "x",
    title: "How the Slop run receipt works",
    url: sourceUrl,
    evidence: {
      archiveUrl: `https://web.archive.org/web/20261016000000/${sourceUrl}`,
      contentSha256: "a".repeat(64),
      capturedAt: "2026-10-16T00:00:00.000Z",
    },
  },
  reason:
    "The public explainer thread answered the recurring run receipt question with correct, reviewed steps.",
  review: {
    reviewer: "lalalune",
    reviewedAt: "2026-10-17T00:00:00.000Z",
    decisionUrl: "https://github.com/SlopDotCash/slopdotcash/pull/900",
  },
};

/** The award file loaded by the production loader, as the generator does. */
function awardEvents() {
  mkdirSync(join(dir, "evaluations", "slopdotcash"), { recursive: true });
  writeFileSync(
    join(dir, "evaluations", "slopdotcash", "award-external-x-thread.json"),
    JSON.stringify(award, null, 2),
  );
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return loadEvaluatorAwardEvents(join(dir, "evaluations"));
  } finally {
    process.chdir(cwd);
  }
}

/** A published snapshot taken after October closes, with only the award. */
function octoberSnapshot() {
  const at = "2026-11-02T00:00:00.000Z";
  const from = "2026-09-28T00:00:00.000Z";
  setSystemTime(new Date(at));
  try {
    const snapshot = createLeaderboardSnapshot({
      generatedAt: at,
      windowFrom: from,
      windowTo: at,
      sourceUpdatedAt: at,
      source: {
        provider: "github-graphql",
        fetchedAt: at,
        cutoffAt: at,
        repositoryId: "R_fixture",
        repositories: TARGET_REPOSITORIES.map((target) => ({
          id: target.id,
          repositoryId:
            target.role === "primary"
              ? "R_fixture"
              : `R_fixture_${target.name.replaceAll("-", "_")}`,
        })),
        requestCount: 1,
        searchSliceCount: 1,
        rateLimit: {
          cost: 1,
          limit: 5000,
          remaining: 4999,
          resetAt: "2026-11-02T01:00:00.000Z",
        },
        counts: {
          mergedPullRequests: 0,
          detailedMergedPullRequests: 0,
          closedIssues: 0,
          detailedClosedIssues: 0,
          resolvedIssues: 0,
          openIssues: 0,
          openPullRequests: 0,
        },
        verificationWindow: { days: 35, from, to: at },
        evidenceVerification: {
          status: "complete",
          sourceCount: 0,
          artifactCount: 0,
          maxSources: 64,
          maxArtifacts: 64,
        },
      },
      mergedPullRequestOutcomes: [],
      mergedPullRequests: [],
      detailEligibleMergedPullRequestIds: [],
      closedIssueCount: 0,
      resolvedIssues: [],
      openIssues: [],
      openPullRequests: [],
      verificationWindowFrom: from,
      verifiedEvidence: [],
      evaluatedContributions: awardEvents(),
    });
    assertPublishableLeaderboardSnapshot(snapshot);
    return snapshot;
  } finally {
    setSystemTime();
  }
}

/** A funding preparation derived the way `prepare-funding-review --import` does. */
function preparationFor(snapshot: ReturnType<typeof octoberSnapshot>) {
  const cycleId = "2026-10";
  const view = createPaymentProjectView(snapshot, "slopdotcash", cycleId);
  const contributors = view.leaders.map((leader) => {
    const events = view.ledger
      .filter((event) => event.actor.id === leader.actor.id)
      .map((event) => event.id)
      .sort();
    return {
      actor: { id: leader.actor.id, login: leader.actor.login },
      scoreThirds: String(leader.scoreThirds),
      weight: String(leader.adjustedWeight),
      eventCount: events.length,
      eventIdsSha256: sha256(JSON.stringify(events)),
      wallet: null,
      lookupUnavailable: false,
    };
  });
  const snapshotBytes = JSON.stringify(snapshot);
  return {
    view,
    snapshotBytes,
    preparation: {
      projectId: "slopdotcash",
      cycleId,
      sourceSnapshotSha256: sha256(snapshotBytes),
      sourceAuditSha256: sha256("audit-bytes"),
      observedAt: view.cycle.to,
      provenance: {
        ruleVersion: snapshot.ruleVersion,
        walletObservationsSha256: sha256("wallets"),
        snapshotFrom: snapshot.window.from,
        snapshotTo: snapshot.window.to,
        periodFrom: view.cycle.from,
        periodTo: view.cycle.to,
        snapshotLedgerCount: paymentReviewSnapshot(snapshot).ledger.length,
        sourceMergedPullRequests: snapshot.source.counts.mergedPullRequests,
        mergedCensus: 0,
        scoredMerges: 0,
      },
      counts: {
        contributors: contributors.length,
        events: contributors.reduce((sum, row) => sum + row.eventCount, 0),
        scoreThirds: contributors
          .reduce((sum, row) => sum + BigInt(row.scoreThirds), 0n)
          .toString(),
        weight: contributors
          .reduce((sum, row) => sum + BigInt(row.weight), 0n)
          .toString(),
      },
      contributors,
    },
  };
}

describe("payment quality evidence for an external evaluated contribution", () => {
  const snapshot = octoberSnapshot();
  const input = preparationFor(snapshot);
  const path = (file: string) => join(dir, file);
  writeFileSync(path("preparation.json"), JSON.stringify(input.preparation));
  writeFileSync(path("snapshot.json"), input.snapshotBytes);
  writeFileSync(
    path("closed.json"),
    JSON.stringify({
      method: "repository-created-order-v1",
      projectId: "slopdotcash",
      cycleId: "2026-10",
      observedAt: input.view.cycle.to,
      coverage: (findProject("slopdotcash")?.repositories ?? []).map(
        (target) => ({
          repository: target.id,
          complete: true,
          pages: 1,
          scanned: 0,
        }),
      ),
      nodes: [],
    }),
  );
  writeFileSync(path("bases.json"), "[]");

  test("the award is scored in the October payment review ledger", () => {
    const external = paymentReviewSnapshot(snapshot).ledger.filter(
      (event) => event.source.kind === "external",
    );
    expect(external.map((event) => event.source.url)).toEqual([sourceUrl]);
    expect(
      input.view.leaders.map(
        (leader) => `${leader.actor.login}:${leader.scoreThirds}`,
      ),
    ).toEqual(["slopcontributor:6"]);
  });

  test("prepare-contribution-quality keeps the award as an evaluation", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/prepare-contribution-quality.ts",
        path("preparation.json"),
        path("snapshot.json"),
        path("closed.json"),
        path("bases.json"),
        path("quality.json"),
      ],
      { cwd: repository, encoding: "utf8" },
    );
    expect(result.stderr).not.toContain("Invalid quality source");
    expect(result.status).toBe(0);
    const evidence = JSON.parse(readFileSync(path("quality.json"), "utf8"));
    expect(
      evidence.events.map(
        (event: { kind: string; url: string }) => `${event.kind} ${event.url}`,
      ),
    ).toEqual([`evaluation ${sourceUrl}`]);
  });

  test("the review page decision on the award reconciles the cap", () => {
    const evidence = assertQualityEvidence(
      JSON.parse(readFileSync(path("quality.json"), "utf8")),
      input.preparation as unknown as FundingPreparation,
    );
    const [event] = evidence.events;
    // ContributionQualityReview links the selected events as evidence.
    const result = calculateQualityReview(
      evidence,
      [
        {
          eventIds: [event.id],
          tier: "small",
          reason: "Accepted explainer outcome.",
          evidenceUrls: [event.url],
        },
      ],
      "1000000000",
    );
    expect(result.after.get(event.actorId)).toBe("1000000000");
  });
});

describe("external quality source bounds", () => {
  const preparation = {
    projectId: "slopdotcash",
    cycleId: "2026-10",
    sourceSnapshotSha256: "a".repeat(64),
    contributors: [
      {
        actor: { id: "123", login: "octocat" },
        scoreThirds: "6",
        weight: "60000",
        eventCount: 1,
        eventIdsSha256: "b".repeat(64),
        wallet: null,
        lookupUnavailable: false,
      },
    ],
  } as unknown as FundingPreparation;
  const evidence = (kind: string, url: string) => ({
    schemaVersion: "1",
    projectId: "slopdotcash",
    cycleId: "2026-10",
    sourceSnapshotSha256: "a".repeat(64),
    closureCensus: {
      method: "repository-created-order-v1",
      sourceSha256: "c".repeat(64),
      observedAt: "2026-11-01T00:00:00.000Z",
      discussionSourceSha256: null,
    },
    events: [
      {
        id: "ev1",
        actorId: "123",
        url,
        title: "Example",
        kind,
        scoreThirds: 6,
        weight: "60000",
        flags: [],
      },
    ],
    closures: [],
  });

  test("only an evaluation keeps a canonical external URL", () => {
    expect(() =>
      assertQualityEvidence(evidence("evaluation", sourceUrl), preparation),
    ).not.toThrow();
    for (const kind of ["implementation", "review"])
      expect(() =>
        assertQualityEvidence(evidence(kind, sourceUrl), preparation),
      ).toThrow("Invalid quality source");
    for (const url of [
      "https://twitter.com/slopcontributor/status/1846000000000000001",
      `${sourceUrl}?s=20`,
      "https://x.com/slopcontributor",
      "http://example.com/post",
      "https://github.com/SlopDotCash/slopdotcash/blob/main/README.md",
    ])
      expect(() =>
        assertQualityEvidence(evidence("evaluation", url), preparation),
      ).toThrow("Invalid quality source");
  });

  test("a decision cites only GitHub or its own external events", () => {
    const external = assertQualityEvidence(
      evidence("evaluation", sourceUrl),
      preparation,
    ) as QualityEvidence;
    const decide = (evidenceUrls: string[]) =>
      calculateQualityReview(
        external,
        [
          {
            eventIds: ["ev1"],
            tier: "small",
            reason: "Accepted explainer outcome.",
            evidenceUrls,
          },
        ],
        "1000",
      );
    expect(() => decide([sourceUrl])).not.toThrow();
    expect(() =>
      decide(["https://github.com/SlopDotCash/slopdotcash/pull/900"]),
    ).not.toThrow();
    expect(() =>
      decide(["https://x.com/someoneelse/status/1846000000000000002"]),
    ).toThrow("Link public acceptance or review evidence");
  });
});
