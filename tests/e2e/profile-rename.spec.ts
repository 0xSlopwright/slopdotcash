/** Public-record fixtures exercise profile identity, not OAuth or settlement. */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { assertCycleIndex } from "../../src/lib/cycle-index";
import {
  assertFundingReviewIndex,
  createFundingReview,
} from "../../src/lib/funding-review-data";
import { assertLeaderboardSnapshot } from "../../src/lib/leaderboard";
import { archivedPaidCycleIndex, snapshotFixture } from "../fixtures";

async function profileRecords(page: Page, reusedHandle = false) {
  const snapshot = snapshotFixture();
  const current = snapshot.leaders[0].actor;
  if (reusedHandle) {
    current.login = "archive-only";
    current.url = "https://github.com/archive-only";
  }
  const cycles = archivedPaidCycleIndex();
  const archived = cycles.cycles[0].contributors[0].actor;
  if (!reusedHandle) archived.id = current.id;
  const reviews = assertFundingReviewIndex({
    schemaVersion: "1",
    generatedAt: "2026-09-02T00:00:00.000Z",
    reviews: [
      createFundingReview({
        projectId: "eliza",
        cycleId: "2026-08",
        sourceSnapshotSha256: "a".repeat(64),
        sourceAuditSha256: "b".repeat(64),
        observedAt: "2026-09-02T00:00:00.000Z",
        provenance: {
          ruleVersion: "slop-score-v2",
          walletObservationsSha256: "c".repeat(64),
          snapshotFrom: "2026-07-28T00:00:00.000Z",
          snapshotTo: "2026-09-01T00:00:00.000Z",
          periodFrom: "2026-08-01T00:00:00.000Z",
          periodTo: "2026-09-01T00:00:00.000Z",
          snapshotLedgerCount: 1,
          sourceMergedPullRequests: 1,
          mergedCensus: 1,
          scoredMerges: 1,
        },
        counts: {
          contributors: 1,
          events: 1,
          scoreThirds: "3",
          weight: "30000",
        },
        contributors: [
          {
            actor: { ...archived },
            scoreThirds: "3",
            weight: "30000",
            eventCount: 1,
            eventIdsSha256: "d".repeat(64),
            wallet: null,
            lookupUnavailable: false,
          },
        ],
      }),
    ],
  });
  assertLeaderboardSnapshot(snapshot);
  assertCycleIndex(cycles);
  await page.route("**/data/leaderboard.json?**", (r) =>
    r.fulfill({ json: snapshot }),
  );
  await page.route("**/data/cycles/index.json*", (r) =>
    r.fulfill({ json: cycles }),
  );
  await page.route("**/data/funding-reviews.json*", (r) =>
    r.fulfill({ json: reviews }),
  );
  // Decorative images are local fixtures, so these identity regressions do
  // not depend on GitHub's image service or a machine-specific CA store.
  await page.route("https://avatars.githubusercontent.com/**", async (r) =>
    r.fulfill({ response: await page.request.get("/slop-mark.svg") }),
  );
  await page.route("**/api/v1/wallet-claims/actors/*/current", (r) =>
    r.fulfill({ json: null }),
  );
  return { snapshot, cycles, reviews, current };
}

test("a renamed contributor keeps archived cycles and frozen-month links", async ({
  page,
}, info) => {
  const { current } = await profileRecords(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`/contributors/${current.login}`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator("main.profile-page")).toBeVisible();
  const history = page.locator(".profile-section", {
    has: page.getByRole("heading", { name: "Past cycles", exact: true }),
  });
  const pastCycle = history.getByRole("link");
  await expect(pastCycle).toHaveAttribute("href", "/cycles/eliza/2026-07");
  await expect(pastCycle).toContainText("7 score");
  await expect(pastCycle).toContainText("$1");
  const frozen = page.locator(".profile-section", {
    has: page.getByRole("heading", { name: "Frozen months", exact: true }),
  });
  await expect(frozen.getByRole("link")).toHaveAttribute(
    "href",
    "/projects/eliza/funding",
  );
  await expect(frozen).toContainText("2026-08");
  await expect(frozen).toContainText("1 score");
  // July Eliza events are replaced by the archived 7, plus 10 from Delta
  // Star. Resolving identity must not recalculate or double-count the score.
  await expect(
    page.getByTitle("Closed cycles and ledger events outside those cycles"),
  ).toHaveText("17");
  await pastCycle.focus();
  await expect(pastCycle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/cycles\/eliza\/2026-07$/u);
  await page.goBack();
  await expect(pastCycle).toBeVisible();
  await page.reload();
  await expect(pastCycle).toBeVisible();
  await expect(frozen.getByRole("link")).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("renamed-profile.png") });
  expect(errors).toEqual([]);
});

test("a different actor reusing an old login does not inherit its history", async ({
  page,
}) => {
  const { current } = await profileRecords(page, true);
  await page.goto(`/contributors/${current.login}`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator("main.profile-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Past cycles" })).toHaveCount(
    0,
  );
  // networkidle above includes the independent frozen-month loader.
  await expect(
    page.getByRole("heading", { name: "Frozen months" }),
  ).toHaveCount(0);
  await expect(
    page.getByTitle("Closed cycles and ledger events outside those cycles"),
  ).toHaveText("10");
  await expect(
    page.getByRole("heading", { name: current.login, exact: true }),
  ).toBeVisible();
});
