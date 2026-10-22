/**
 * SCR-04: a commit SHA gives credit only in the earliest merged pull request
 * that lists it, whatever that pull request's base branch. A later promotion
 * or consolidation pull request into the integration branch cannot score the
 * same commit again, and only an integration-branch pull request shares its
 * credit with the committers it owns.
 */
import { afterAll, expect, setSystemTime, test } from "bun:test";
import type {
  GitHubActor,
  LeaderboardInput,
  MergedPullRequestOutcome,
} from "../src/lib/leaderboard";
import { createLeaderboardSnapshot } from "../src/lib/leaderboard";
import { TARGET_REPOSITORIES } from "../src/lib/repositories.mjs";

const REPO_URL = "https://github.com/SlopDotCash/slopdotcash";
const AT = "2026-10-19T12:00:00.000Z";
const FROM = "2026-09-14T12:00:00.000Z";
const HEAD = "a".repeat(40);

// The scorer refuses a snapshot generated in the future of the wall clock.
setSystemTime(new Date(AT));
afterAll(() => setSystemTime());

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

const drew = actor("drew-dot-com", "U_kgDODBRb9w");
const lala = actor("lalalune", "MDQ6VXNlcjE4NjMzMjY0");
const sam = actor("sam", "U_sam");

function merges(snapshot: ReturnType<typeof createLeaderboardSnapshot>) {
  return snapshot.ledger
    .filter((entry) => entry.category === "merged-pull-request")
    .map((entry) => `${entry.id} ${entry.actor.login} ${entry.scoreThirds}`)
    .sort();
}

test("a commit first merged into main is not credited again by the main-to-development sync", () => {
  const hotfix = { oid: "c1".repeat(20), author: drew };
  const sync = { oid: "c2".repeat(20), author: lala };
  const snapshot = createLeaderboardSnapshot(
    input({
      mergedPullRequestOutcomes: [
        outcome(809, drew, "2026-10-16T12:05:09.000Z", "main", [hotfix]),
        outcome(878, lala, "2026-10-19T03:47:50.000Z", "development", [
          hotfix,
          sync,
        ]),
      ],
    }),
  );
  expect(merges(snapshot)).toEqual([
    "PR_809:merged drew-dot-com 3",
    "PR_878:merged lalalune 3",
  ]);
});

test("an integration-branch pull request still shares credit with the committers it owns", () => {
  const theirs = { oid: "d1".repeat(20), author: sam };
  const mine = { oid: "d2".repeat(20), author: lala };
  const snapshot = createLeaderboardSnapshot(
    input({
      mergedPullRequestOutcomes: [
        outcome(900, lala, "2026-10-18T10:00:00.000Z", "development", [
          theirs,
          mine,
        ]),
      ],
    }),
  );
  expect(merges(snapshot)).toEqual([
    "PR_900:merged lalalune 2",
    "PR_900:merged:U_sam sam 1",
  ]);
});

test("a pull request into another branch keeps author-only credit", () => {
  const theirs = { oid: "e1".repeat(20), author: sam };
  const snapshot = createLeaderboardSnapshot(
    input({
      mergedPullRequestOutcomes: [
        outcome(901, lala, "2026-10-18T10:00:00.000Z", "main", [theirs]),
      ],
    }),
  );
  expect(merges(snapshot)).toEqual(["PR_901:merged lalalune 3"]);
});
