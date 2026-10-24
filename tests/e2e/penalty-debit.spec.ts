/**
 * PRD section 7: a recorded penalty-table debit appears on the published
 * Slop Score. The snapshot comes from the real producer with one debit
 * input, so the browser reads exactly what a release would publish.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createLeaderboardSnapshot } from "../../src/lib/leaderboard";
import type {
  GitHubActor,
  LeaderboardInput,
} from "../../src/lib/leaderboard-types";
import { TARGET_REPOSITORIES } from "../../src/lib/repositories.mjs";
import { cycleIndexFixture } from "../fixtures";

const author: GitHubActor = {
  // GitHub's node ID of user 42.
  id: "MDQ6VXNlcjQy",
  login: "debited-contributor",
  avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
  url: "https://github.com/debited-contributor",
  kind: "User",
};

function snapshotWithDebit() {
  const primary = TARGET_REPOSITORIES[0];
  const now = Date.now();
  // Every event stays in the current UTC month, whatever the run date.
  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const at = (minutesAgo: number) =>
    new Date(
      Math.max(monthStart.getTime() + 60_000, now - minutesAgo * 60_000),
    ).toISOString();
  const generatedAt = new Date(now).toISOString();
  const windowFrom = new Date(now - 35 * 86_400_000).toISOString();
  const pulls = [1, 2].map((number) => {
    const mergedAt = at(120 - number);
    const core = {
      id: `PR_debit_fixture_${number}`,
      number: 9100 + number,
      title: `fix: accepted change ${number}`,
      url: `${primary.githubUrl}/pull/${9100 + number}`,
      body: "Fixes a defect.",
      createdAt: windowFrom,
      updatedAt: mergedAt,
      mergedAt,
      author,
      additions: 4,
      deletions: 1,
    };
    return {
      outcome: {
        ...core,
        baseRefName: primary.integrationBranch,
        commits: [{ oid: String(number).repeat(40), author }],
      },
      record: {
        ...core,
        lastEditedAt: null,
        editor: null,
        headRefOid: "d".repeat(40),
        isDraft: false,
        reviewDecision: "APPROVED",
        activeReviewRequestCount: 0,
        assignees: [],
        labels: [],
        files: [{ path: "src/fix.ts", additions: 4, deletions: 1 }],
        comments: [],
        reviews: [],
        closingIssueIds: [],
        changedFiles: 1,
        commitCount: 1,
      },
    };
  });
  const recordedAt = at(30);
  const input: LeaderboardInput = {
    generatedAt,
    windowFrom,
    windowTo: generatedAt,
    sourceUpdatedAt: pulls[1].outcome.mergedAt,
    source: {
      provider: "github-graphql",
      fetchedAt: generatedAt,
      cutoffAt: generatedAt,
      repositoryId: "R_fixture",
      repositories: TARGET_REPOSITORIES.map((repository, index) => ({
        id: repository.id,
        repositoryId: index === 0 ? "R_fixture" : `R_fixture_${index}`,
      })),
      requestCount: 1,
      searchSliceCount: 1,
      rateLimit: {
        cost: 1,
        limit: 5000,
        remaining: 4999,
        resetAt: new Date(now + 3_600_000).toISOString(),
      },
      counts: {
        mergedPullRequests: 2,
        detailedMergedPullRequests: 2,
        closedIssues: 0,
        detailedClosedIssues: 0,
        resolvedIssues: 0,
        openIssues: 0,
        openPullRequests: 0,
      },
      verificationWindow: { days: 35, from: windowFrom, to: generatedAt },
      evidenceVerification: {
        status: "complete",
        sourceCount: 0,
        artifactCount: 0,
        maxSources: 64,
        maxArtifacts: 64,
      },
    },
    mergedPullRequestOutcomes: pulls.map((pull) => pull.outcome),
    mergedPullRequests: pulls.map((pull) => pull.record),
    detailEligibleMergedPullRequestIds: pulls.map((pull) => pull.outcome.id),
    closedIssueCount: 0,
    resolvedIssues: [],
    openIssues: [],
    openPullRequests: [],
    verificationWindowFrom: windowFrom,
    verifiedEvidence: [],
    penaltyDebits: [
      {
        itemNodeId: "PR_debit_fixture_spam",
        actor: author,
        repository: primary.id,
        item: {
          kind: "pull-request",
          number: 9199,
          title: "Buy cheap followers",
          url: `${primary.githubUrl}/pull/9199`,
        },
        category: "spam",
        tableVersion: "slopbot-penalties-v1",
        debitThirds: 3,
        period: recordedAt.slice(0, 7),
        recordedAt,
      },
    ],
  };
  return createLeaderboardSnapshot(input);
}

test("a spam debit lowers the contributor's Slop Score and is listed on the profile", async ({
  page,
}, info) => {
  const snapshot = snapshotWithDebit();
  // Two small merges (6 thirds) less the 3-third spam debit.
  expect(
    snapshot.leaders.find((leader) => leader.actor.id === author.id),
  ).toMatchObject({ score: 1, scoreThirds: 3 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const failures: string[] = [];
  page.on("response", (response) => {
    if (
      new URL(response.url()).origin === new URL(page.url()).origin &&
      response.status() >= 400
    )
      failures.push(response.url());
  });
  const now = new Date().toISOString();
  await page.route("**/data/leaderboard.json?**", (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.route("**/data/cycles/index.json*", (route) =>
    route.fulfill({ json: cycleIndexFixture() }),
  );
  await page.route("**/data/profiles.json", (route) =>
    route.fulfill({
      json: {
        schemaVersion: "1",
        startedAt: now,
        generatedAt: now,
        repositories: TARGET_REPOSITORIES.map((repository) => ({
          repository: repository.id,
          count: 0,
          excluded: 0,
        })),
        people: [
          {
            id: author.id,
            login: author.login,
            avatarUrl: author.avatarUrl,
            repositories: [],
          },
        ],
      },
    }),
  );
  await page.route("https://avatars.githubusercontent.com/**", async (route) =>
    route.fulfill({ response: await page.request.get("/slop-mark.svg") }),
  );
  await page.route("**/api/v1/wallet-claims/actors/*/current", (route) =>
    route.fulfill({ json: null }),
  );
  await page.goto(`/contributors/${author.login}`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator("main.profile-page")).toBeVisible();
  await expect(
    page.getByTitle("Closed cycles and ledger events outside those cycles"),
  ).toHaveText("1");
  const activity = page.getByRole("region", { name: "Contribution activity" });
  const debit = activity.getByRole("listitem").filter({
    hasText: "Buy cheap followers",
  });
  await expect(debit).toContainText("penalty debit");
  await expect(debit).toContainText("−1 Slop Score");
  await expect(
    activity.getByRole("link", { name: /Buy cheap followers/u }),
  ).toHaveAttribute("href", `${TARGET_REPOSITORIES[0].githubUrl}/pull/9199`);
  await expect(
    activity
      .getByRole("listitem")
      .filter({ hasText: "fix: accepted change 1" }),
  ).toContainText("+1 Slop Score");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: info.outputPath("penalty-debit-profile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
});
