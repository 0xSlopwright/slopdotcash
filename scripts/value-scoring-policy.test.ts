/**
 * PRD section 7 (SCR-05, SCR-06; MVP-09): one versioned producer for new work.
 * Work accepted before the value policy keeps the historical rules; work from
 * its effective instant is scored from source-bound value assessments, and
 * each pull request's review credit is one explicit allocation among its first
 * five distinct qualifying reviewers.
 */
import { afterAll, expect, setSystemTime, test } from "bun:test";
import type {
  GitHubActor,
  LeaderboardInput,
  MergedPullRequestOutcome,
  MergedPullRequestReviewRecord,
  PullRequestReview,
} from "../src/lib/leaderboard";
import { createLeaderboardSnapshot } from "../src/lib/leaderboard";
import { TARGET_REPOSITORIES } from "../src/lib/repositories.mjs";
import {
  allocatePullRequestReviewCredit,
  allocateReviewCredit,
  ScoringPolicyDecisionPendingError,
  type ValueScoringPolicy,
  valueScoringPolicy,
} from "../src/lib/scoring-policy";
import { VALUE_RUBRIC_VERSION } from "../src/lib/value-assessment";
import { parseGenerationArguments } from "./generate-leaderboard";

const REPO = "SlopDotCash/slopdotcash";
const REPO_URL = `https://github.com/${REPO}`;
const AT = "2026-10-23T12:00:00.000Z";
const FROM = "2026-09-18T12:00:00.000Z";
const HEAD = "a".repeat(40);
// Test-only policy values; the production decision is still pending.
const POLICY: ValueScoringPolicy = {
  id: "slop-value-v1",
  rubricVersion: VALUE_RUBRIC_VERSION,
  effectiveAt: "2026-10-15T00:00:00.000Z",
  reviewCredit: { maxReviewers: 5, poolThirds: 24 },
};

setSystemTime(new Date(AT));
afterAll(() => setSystemTime());

function actor(login: string): GitHubActor {
  return {
    id: `U_${login}`,
    login,
    avatarUrl: `https://avatars.githubusercontent.com/u/${login.length}?v=4`,
    url: `https://github.com/${login}`,
    kind: "User",
  };
}
const [alice, bob, carol, dave, erin, frank, grace] = [
  "alice",
  "bob",
  "carol",
  "dave",
  "erin",
  "frank",
  "grace",
].map(actor) as GitHubActor[];

function outcome(number: number, mergedAt: string): MergedPullRequestOutcome {
  return {
    id: `PR_${number}`,
    headRefOid: HEAD,
    number,
    title: `PR ${number}`,
    url: `${REPO_URL}/pull/${number}`,
    body: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: mergedAt,
    mergedAt,
    author: alice as GitHubActor,
    additions: 1,
    deletions: 1,
    baseRefName: "development",
    commits: [{ oid: String(number).repeat(40), author: alice as GitHubActor }],
  };
}

function review(
  pull: number,
  index: number,
  author: GitHubActor,
  state: string,
  submittedAt: string,
  commitId = HEAD,
): PullRequestReview {
  return {
    id: `PRR_${pull}_${index}`,
    body: "Reproduced the failure locally and confirmed the fix resolves it.",
    state,
    submittedAt,
    url: `${REPO_URL}/pull/${pull}#pullrequestreview-${pull}${index}`,
    author,
    inlineCommentCount: 0,
    commitId,
  };
}

function reviewed(
  merged: MergedPullRequestOutcome,
  reviews: PullRequestReview[],
): MergedPullRequestReviewRecord {
  return {
    id: merged.id,
    number: merged.number,
    title: merged.title,
    url: merged.url,
    body: merged.body,
    createdAt: merged.createdAt,
    updatedAt: merged.updatedAt,
    lastEditedAt: null,
    editor: null,
    mergedAt: merged.mergedAt,
    headRefOid: HEAD,
    author: merged.author,
    comments: [],
    reviews,
  };
}

function assessed(
  merged: MergedPullRequestOutcome,
  digest: string,
  tier: string,
  reviews: { sourceId: string; tier: string }[],
) {
  return {
    status: "assessed",
    history: [{ recorded_at: "2026-10-22T00:00:00.000Z" }],
    latestDigest: digest.repeat(64),
    implementationActorNodeIds: [alice?.id],
    record: {
      pullRequestNodeId: merged.id,
      repository: REPO,
      headSha: HEAD,
      occurredAt: merged.mergedAt,
      assessment: { tier, rationale: "Repairs the reported workflow." },
    },
    assessment: {
      tier,
      rationale: "Repairs the reported workflow.",
      reviews: reviews.map((item) => ({
        ...item,
        duplicateOf: null,
        finding: "Identified the failing path.",
        outcome: "The accepted head retains the fix.",
        evidenceUrls: [],
      })),
    },
  };
}

function input(partial: Partial<LeaderboardInput>): LeaderboardInput {
  return {
    generatedAt: AT,
    windowFrom: FROM,
    windowTo: AT,
    sourceUpdatedAt: AT,
    source: {
      provider: "github-graphql",
      fetchedAt: AT,
      cutoffAt: AT,
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
      rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: AT },
      counts: {
        mergedPullRequests: 0,
        detailedMergedPullRequests: 0,
        closedIssues: 0,
        detailedClosedIssues: 0,
        resolvedIssues: 0,
        openIssues: 0,
        openPullRequests: 0,
      },
      verificationWindow: { days: 35, from: FROM, to: AT },
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
    reviewedMergedPullRequests: [],
    detailEligibleMergedPullRequestIds: [],
    closedIssueCount: 0,
    resolvedIssues: [],
    openIssues: [],
    openPullRequests: [],
    verificationWindowFrom: FROM,
    verifiedEvidence: [],
    evaluatedContributions: [],
    ...partial,
  };
}

// PR 1 predates the policy; PR 2 is assessed; PR 3 awaits its assessment.
const legacy = outcome(1, "2026-10-12T10:00:00.000Z");
const valued = outcome(2, "2026-10-20T10:00:00.000Z");
const pending = outcome(3, "2026-10-21T10:00:00.000Z");
const legacyReviews = [
  review(1, 1, bob as GitHubActor, "APPROVED", "2026-10-12T08:00:00.000Z"),
  review(
    1,
    2,
    carol as GitHubActor,
    "CHANGES_REQUESTED",
    "2026-10-12T07:00:00.000Z",
    "b".repeat(40),
  ),
];
const valueReviews = [
  review(2, 1, bob as GitHubActor, "APPROVED", "2026-10-19T01:00:00.000Z"),
  review(
    2,
    2,
    carol as GitHubActor,
    "CHANGES_REQUESTED",
    "2026-10-19T02:00:00.000Z",
  ),
  review(2, 3, dave as GitHubActor, "COMMENTED", "2026-10-19T03:00:00.000Z"),
  review(2, 4, bob as GitHubActor, "COMMENTED", "2026-10-19T04:00:00.000Z"),
  review(2, 5, erin as GitHubActor, "APPROVED", "2026-10-19T05:00:00.000Z"),
  review(2, 6, frank as GitHubActor, "APPROVED", "2026-10-19T05:00:00.000Z"),
  review(2, 7, grace as GitHubActor, "APPROVED", "2026-10-19T06:00:00.000Z"),
  review(2, 8, alice as GitHubActor, "APPROVED", "2026-10-19T07:00:00.000Z"),
];

function snapshot(policy: ValueScoringPolicy | null = POLICY) {
  return createLeaderboardSnapshot(
    input({
      mergedPullRequestOutcomes: [legacy, valued, pending],
      reviewedMergedPullRequests: [
        reviewed(legacy, legacyReviews),
        reviewed(valued, valueReviews),
        reviewed(pending, []),
      ],
      valuePolicy: policy ?? undefined,
      valueDecisions: new Map<string, unknown>([
        [
          valued.id,
          assessed(valued, "d", "medium", [
            { sourceId: "PRR_2_1", tier: "standard" },
            { sourceId: "PRR_2_2", tier: "deep" },
            { sourceId: "PRR_2_3", tier: "triage" },
            { sourceId: "PRR_2_4", tier: "deep" },
            { sourceId: "PRR_2_5", tier: "standard" },
            { sourceId: "PRR_2_6", tier: "triage" },
            { sourceId: "PRR_2_7", tier: "standard" },
            { sourceId: "PRR_2_8", tier: "none" },
          ]),
        ],
        [
          pending.id,
          {
            status: "missing",
            history: [],
            latestDigest: null,
            implementationActorNodeIds: [],
          },
        ],
      ]) as unknown as LeaderboardInput["valueDecisions"],
    }),
  );
}

test("the normal command takes no opt-in flag and the policy decision gates publication", () => {
  expect(parseGenerationArguments([])).toEqual({});
  expect(() => parseGenerationArguments(["--value-assessments"])).toThrow(
    "Usage: generate-leaderboard.ts [--cutoff YYYY-MM-DDTHH:mm:ss.sssZ]",
  );
  let pendingError: unknown;
  try {
    valueScoringPolicy();
  } catch (error) {
    pendingError = error;
  }
  expect(pendingError).toBeInstanceOf(ScoringPolicyDecisionPendingError);
  expect((pendingError as ScoringPolicyDecisionPendingError).missing).toEqual([
    "effectiveAt",
    "reviewCreditPoolThirds",
  ]);
  expect(
    valueScoringPolicy({
      effectiveAt: POLICY.effectiveAt,
      reviewCreditPoolThirds: 24,
    }),
  ).toEqual(POLICY);
  expect(() =>
    valueScoringPolicy({
      effectiveAt: "2026-10-15",
      reviewCreditPoolThirds: 24,
    }),
  ).toThrow("exact UTC timestamp");
});

test("largest remainder conserves the pool and breaks equal remainders by order", () => {
  expect(allocateReviewCredit(10, [3, 3, 3])).toEqual([4, 3, 3]);
  expect(allocateReviewCredit(5, [1, 9])).toEqual([1, 4]);
  expect(allocateReviewCredit(24, [9, 9, 1, 3, 1])).toEqual([10, 9, 1, 3, 1]);
  expect(allocateReviewCredit(2, [1, 1, 1])).toEqual([1, 1, 0]);
  expect(() => allocateReviewCredit(3, [1, 1, 1, 1, 1, 1])).toThrow();
  expect(() => allocateReviewCredit(0, [1])).toThrow();
});

test("review credit dedupes reviewers, orders by verified time, and credits five", () => {
  const allocation = allocatePullRequestReviewCredit(
    [
      {
        reviewId: "R7",
        actor: { id: "g" },
        submittedAt: "2026-10-19T06:00:00.000Z",
        thirds: 3,
      },
      {
        reviewId: "R4",
        actor: { id: "b" },
        submittedAt: "2026-10-19T04:00:00.000Z",
        thirds: 9,
      },
      {
        reviewId: "R1",
        actor: { id: "b" },
        submittedAt: "2026-10-19T01:00:00.000Z",
        thirds: 3,
      },
      {
        reviewId: "R2",
        actor: { id: "c" },
        submittedAt: "2026-10-19T02:00:00.000Z",
        thirds: 9,
      },
      {
        reviewId: "R6",
        actor: { id: "f" },
        submittedAt: "2026-10-19T05:00:00.000Z",
        thirds: 1,
      },
      {
        reviewId: "R5",
        actor: { id: "e" },
        submittedAt: "2026-10-19T05:00:00.000Z",
        thirds: 3,
      },
      {
        reviewId: "R3",
        actor: { id: "d" },
        submittedAt: "2026-10-19T03:00:00.000Z",
        thirds: 1,
      },
    ],
    24,
  );
  expect(
    allocation.credited.map((item) => [
      item.actor.id,
      item.source.reviewId,
      item.shareThirds,
      item.repeatedReviewIds,
    ]),
  ).toEqual([
    ["b", "R4", 10, ["R1"]],
    ["c", "R2", 9, []],
    ["d", "R3", 1, []],
    ["e", "R5", 3, []],
    ["f", "R6", 1, []],
  ]);
  expect(allocation.beyondLimitReviewIds).toEqual(["R7"]);
});

test("new work uses value assessments while earlier work keeps its historical rules", () => {
  const result = snapshot();
  const byId = new Map(result.ledger.map((event) => [event.id, event]));

  // Historical: provisional small merge and the SCR-05 single review award.
  expect(byId.get("PR_1:merged")?.scoreThirds).toBe(3);
  expect(byId.get("PR_1:merged")?.scoreDecisionSourceId).toBeUndefined();
  expect(byId.get("PR_1:reviewer:U_carol")?.scoreThirds).toBe(1);
  expect(byId.has("PR_1:reviewer:U_bob")).toBe(false);

  // Value policy: the assessed tier, and one explicit review allocation.
  expect(byId.get("PR_2:merged")?.scoreThirds).toBe(9);
  expect(byId.get("PR_2:merged")?.scoreDecisionSourceId).toBe(
    `value:${"d".repeat(64)}`,
  );
  const reviewCredit = result.ledger
    .filter((event) => event.id.startsWith("PR_2:value-review:"))
    .map((event) => [event.actor.id, event.source.id, event.scoreThirds]);
  expect(reviewCredit.sort()).toEqual(
    [
      ["U_bob", "PRR_2_4", 10],
      ["U_carol", "PRR_2_2", 9],
      ["U_dave", "PRR_2_3", 1],
      ["U_erin", "PRR_2_5", 3],
      ["U_frank", "PRR_2_6", 1],
    ].sort(),
  );
  // A useful approval earns credit without requesting changes.
  expect(byId.get("PR_2:value-review:PRR_2_5")?.scoreThirds).toBe(3);
  const exclusions = new Map(
    (result.reviewExclusions ?? [])
      .filter((exclusion) => exclusion.pullRequestId === "PR_2")
      .map((exclusion) => [exclusion.reviewId, exclusion.reason]),
  );
  expect(exclusions.get("PRR_2_1")).toBe("already-awarded-reviewer");
  expect(exclusions.get("PRR_2_7")).toBe("review-credit-reviewer-limit");

  // An accepted merge awaiting assessment keeps the one-third minimum.
  expect(byId.get("PR_3:merged")?.scoreThirds).toBe(1);

  expect(
    Object.fromEntries(
      (result.valueAssessmentCoverage ?? []).map((row) => [
        row.pullRequestId,
        row.status,
      ]),
    ),
  ).toEqual({ PR_1: "legacy-policy", PR_2: "assessed", PR_3: "missing" });
  expect(result.methodology.summary).toContain(
    "From 2026-10-15T00:00:00.000Z (slop-value-v1)",
  );
});

test("value decisions require a policy that cannot reach earlier policy periods", () => {
  expect(() => snapshot(null)).toThrow(
    "Value decisions require their versioned scoring policy",
  );
  expect(() =>
    snapshot({ ...POLICY, effectiveAt: "2026-10-01T00:00:00.000Z" }),
  ).toThrow("The value policy cannot reinterpret earlier policy periods");
});

test("a maintainer correction overrides only the implementation score", () => {
  const ratified = outcome(4, "2026-10-21T10:00:00.000Z");
  const maintainer = actor("maintainer");
  const projectId = TARGET_REPOSITORIES.find(
    (target) => target.id === REPO,
  )?.projectId;
  const record = {
    schemaVersion: "1",
    ruleVersion: "slop-score-v2",
    projectId,
    pullRequestNodeId: ratified.id,
    headSha: HEAD,
    workUnitId: "wu_slopdotcash_pr_4",
    tier: "micro",
    scoreThirds: 1,
    proposalReviewNodeIds: [],
    coRatifierNodeIds: [],
    reason: "Narrow mechanical correction.",
    supersedes: null,
  };
  const createdAt = "2026-10-22T10:00:00.000Z";
  const source = {
    ...reviewed(ratified, [
      review(4, 1, bob as GitHubActor, "APPROVED", "2026-10-21T09:00:00.000Z"),
    ]),
    comments: [
      {
        id: "IC_ratify",
        artifactId: ratified.id,
        kind: "comment" as const,
        body: `\`\`\`slop-score\n${JSON.stringify(record)}\n\`\`\`\n`,
        url: `${REPO_URL}/pull/4#issuecomment-4`,
        createdAt,
        updatedAt: createdAt,
        author: maintainer,
        authorAssociation: "OWNER",
      },
    ],
  };
  const result = createLeaderboardSnapshot(
    input({
      mergedPullRequestOutcomes: [ratified],
      reviewedMergedPullRequests: [source],
      valuePolicy: POLICY,
      valueDecisions: new Map<string, unknown>([
        [
          ratified.id,
          assessed(ratified, "e", "small", [
            { sourceId: "PRR_4_1", tier: "standard" },
          ]),
        ],
      ]) as unknown as LeaderboardInput["valueDecisions"],
    }),
  );
  const byId = new Map(result.ledger.map((event) => [event.id, event]));
  expect(byId.get("PR_4:merged")?.scoreThirds).toBe(1);
  expect(byId.get("PR_4:merged")?.scoreDecisionSourceId).toBe("IC_ratify");
  // The approval keeps its value allocation instead of the SCR-05 rule.
  expect(byId.get("PR_4:value-review:PRR_4_1")?.scoreThirds).toBe(24);
  expect(byId.get("PR_4:ratifier:IC_ratify")?.scoreThirds).toBe(1);
  expect(result.valueAssessmentCoverage?.[0]?.status).toBe("human-ratified");
});
