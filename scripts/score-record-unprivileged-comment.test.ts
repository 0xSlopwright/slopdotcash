/**
 * A maintainer ratifies a merge with a fenced `slop-score` record. A fenced
 * block in anyone else's comment is data, not a record: it must not abort
 * snapshot generation for every collected repository, and it must not be
 * read as a decision. A maintainer's malformed record still fails closed.
 */
import { expect, setSystemTime, test } from "bun:test";
import type {
  GitHubActor,
  LeaderboardInput,
  MergedPullRequestOutcome,
  MergedPullRequestReviewRecord,
} from "../src/lib/leaderboard";
import { createLeaderboardSnapshot } from "../src/lib/leaderboard";
import { TARGET_REPOSITORIES } from "../src/lib/repositories.mjs";

const REPO_URL = "https://github.com/SlopDotCash/slopdotcash";
const AT = "2026-10-19T12:00:00.000Z";
const FROM = "2026-09-14T12:00:00.000Z";
const HEAD = "a".repeat(40);

// The scorer refuses a snapshot generated in the future of the wall clock.
setSystemTime(new Date(AT));

function actor(login: string, id: string): GitHubActor {
  return {
    id,
    login,
    avatarUrl: `https://avatars.githubusercontent.com/u/${id.length}?v=4`,
    url: `https://github.com/${login}`,
    kind: "User",
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

function outcome(
  number: number,
  author: GitHubActor,
  mergedAt: string,
  baseRefName: string,
  commits: MergedPullRequestOutcome["commits"],
): MergedPullRequestOutcome {
  return {
    id: `PR_${number}`,
    number,
    title: `PR ${number}`,
    url: `${REPO_URL}/pull/${number}`,
    body: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: mergedAt,
    mergedAt,
    author,
    additions: 1,
    deletions: 1,
    baseRefName,
    commits,
  };
}

function reviewed(
  merged: MergedPullRequestOutcome,
  comments: MergedPullRequestReviewRecord["comments"],
  reviews: MergedPullRequestReviewRecord["reviews"] = [],
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
    comments,
    reviews,
  };
}

const alice = actor("alice", "U_alice");
const bob = actor("bob", "U_bob");
const mallory = actor("mallory", "U_mallory");

function comment(
  id: string,
  author: GitHubActor,
  authorAssociation: string,
  body: string,
  artifactId: string,
) {
  const createdAt = "2026-10-09T10:00:00.000Z";
  return {
    id,
    artifactId,
    kind: "comment" as const,
    body,
    url: `${REPO_URL}/pull/${artifactId.replace("PR_", "")}#issuecomment-${id}`,
    createdAt,
    updatedAt: createdAt,
    author,
    authorAssociation,
  };
}

const approval = {
  id: "PRR_bob",
  body: "Looks good to me, verified locally with the test suite.",
  state: "APPROVED",
  submittedAt: "2026-10-09T09:00:00.000Z",
  url: `${REPO_URL}/pull/1#pullrequestreview-1`,
  author: bob,
  inlineCommentCount: 0,
  commitId: HEAD,
};

function snapshotWith(commentBody: string, association: string) {
  const merged = outcome(1, alice, "2026-10-10T10:00:00.000Z", "development", [
    { oid: "1".repeat(40), author: alice },
  ]);
  return createLeaderboardSnapshot(
    input({
      mergedPullRequestOutcomes: [merged],
      reviewedMergedPullRequests: [
        reviewed(
          merged,
          [
            comment(
              "IC_fence",
              association === "OWNER" ? bob : mallory,
              association,
              commentBody,
              merged.id,
            ),
          ],
          [approval],
        ),
      ],
    }),
  );
}

test("a fenced slop-score block in a non-maintainer comment does not abort the snapshot", () => {
  for (const body of [
    "lol\n\n```slop-score\n{}\n```\n",
    "```slop-score\nnot json\n```\n",
  ]) {
    const snapshot = snapshotWith(body, "NONE");
    const merge = snapshot.ledger.find((entry) => entry.id === "PR_1:merged");
    expect(merge?.scoreThirds).toBe(3);
    expect(merge?.scoreDecisionSourceId).toBeUndefined();
  }
});

test("a maintainer's malformed slop-score record still fails closed", () => {
  expect(() => snapshotWith("```slop-score\n{}\n```\n", "OWNER")).toThrow(
    "score record has unexpected or missing fields",
  );
});
