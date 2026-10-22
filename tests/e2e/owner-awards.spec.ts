/** Browser coverage of owner review states; published approval is tested separately. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { PROJECTS } from "../../src/lib/projects.mjs";

test("owner reviews published decisions, retries failures and keeps sign-in context", async ({
  page,
}, info) => {
  const project = PROJECTS.find((item) => item.id === "eliza");
  if (!project) throw new Error("Missing project fixture");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(
    /\/(?:api\/v1\/projects|data\/fixture-project-registry\.json)$/,
    (route) =>
      route.fulfill({ json: { schemaVersion: "1", projects: [project] } }),
  );
  await page.route("**/api/v1/project-session", (route) =>
    route.fulfill({ json: { session: null } }),
  );
  await page.route("**/api/v1/points/session", (route) =>
    route.fulfill({ json: { session: null } }),
  );
  let status = 401;
  let empty = false;
  await page.route(
    "**/api/v1/payments/projects/eliza/awards/2026-09",
    (route) =>
      route.fulfill({
        status,
        json:
          status !== 200
            ? {
                message:
                  "Current GitHub maintainer authority could not be verified.",
              }
            : {
                projectId: "eliza",
                cycleId: "2026-09",
                projectRevision: 1,
                manifestSha256: "a".repeat(64),
                sourceCommit: "b".repeat(40),
                sourceUrl:
                  "https://github.com/SlopDotCash/slopdotcash/tree/" +
                  "b".repeat(40) +
                  "/cycles/eliza/2026-09/escrow-v2",
                proposalSha256: "c".repeat(64),
                asset: { decimals: 9, symbol: "TEST" },
                proposal: {
                  awards: empty
                    ? []
                    : [
                        {
                          githubUserId: "1",
                          login: "approved-contributor",
                          grossMicro: "1234567890",
                        },
                        {
                          githubUserId: "2",
                          login: "held-contributor",
                          grossMicro: "2000000000",
                        },
                        {
                          githubUserId: "3",
                          login: "excluded-contributor",
                          grossMicro: "3000000000",
                        },
                      ],
                },
                decisions: {
                  rows: [
                    {
                      githubUserId: "1",
                      state: "approved",
                      approvedGrossMicro: "1234567890",
                      adjustmentReason: null,
                      relatedParty: false,
                    },
                    {
                      githubUserId: "2",
                      state: "held",
                      approvedGrossMicro: "0",
                      adjustmentReason: "Evidence is under review.",
                      relatedParty: true,
                    },
                    {
                      githubUserId: "3",
                      state: "excluded",
                      approvedGrossMicro: "0",
                      adjustmentReason: "Duplicate source.",
                      relatedParty: false,
                    },
                  ],
                },
                review: null,
                reviewEndsAt: "2026-10-28T00:00:00Z",
                blockedReason:
                  "The published decisions are still in their 14-day review period.",
                reviewVerified: false,
              },
      }),
  );
  await page.goto("/projects/eliza/awards");
  await expect(
    page.getByRole("heading", { name: "Review awards", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Contribution month").fill("2026-09");
  const load = page.getByRole("button", { name: "Load awards", exact: true });
  await load.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("link", {
      name: "Sign in with GitHub to review this project’s awards",
    }),
  ).toHaveAttribute("href", /next=.*awards/);
  status = 403;
  await load.click();
  await expect(page.getByRole("alert")).toContainText("maintainer authority");
  status = 200;
  await load.click();
  const review = page.getByRole("region", { name: "Published award review" });
  await expect(review).toContainText("1.23456789 TEST");
  await expect(review).toContainText("held-contributor");
  await expect(review).toContainText("excluded-contributor");
  await expect(review).toContainText("14-day review period");
  await page.screenshot({
    path: info.outputPath("owner-award-review.png"),
    fullPage: true,
  });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  empty = true;
  await load.click();
  await expect(review).toContainText("No awards in this cycle.");
  expect(errors).toEqual([]);
});
