/**
 * Runs the D1 project registry end to end on the shipped build: the real
 * Pages Functions, a fresh local D1 with every migration, and two seeded
 * site sessions. scripts/run-e2e.mjs creates both sessions; only the GitHub
 * repository lookup is a fixture, so the run does not depend on its rate limit.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const APPLICANT_TOKEN = process.env.SLOP_E2E_APPLICANT_TOKEN ?? "";
const ADMIN_TOKEN = process.env.SLOP_E2E_ADMIN_TOKEN ?? "";

test.describe.configure({ mode: "serial" });

/**
 * Every viewport shares one D1, so each submits its own repository and
 * project id instead of assuming the registry it finds is empty.
 */
function fixtureProject() {
  const suffix = test.info().project.name.replace(/-chromium$/u, "");
  return {
    repository: `example/open-registry-${suffix}`,
    id: `open-registry-${suffix}`,
    name: `Open Registry ${suffix.replaceAll("-", " ")}`,
  };
}

/** Sets the /login session cookie; local http origins are secure contexts. */
async function signIn(page: Page, token: string) {
  if (!token) throw new Error("Missing E2E session");
  await page.goto("/how-it-works", { waitUntil: "networkidle" });
  await page.evaluate((value) => {
    document.cookie = `__Host-slop_points=${value}; Path=/; Secure; SameSite=Strict`;
  }, token);
}

function observe(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // Other APIs reject this local origin, and the GitHub fixture answers 404
    // for the missing license; only application failures count.
    if (
      message.type() === "error" &&
      !message.location().url.startsWith("https://api.github.com/") &&
      !/\/api\/v1\/(points|payments)\//u.test(message.location().url)
    )
      errors.push(message.text());
  });
  return errors;
}

async function expectAccessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
}

async function routeGitHub(page: Page) {
  const { repository } = fixtureProject();
  await page.route("https://api.github.com/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/repos/${repository}`)
      return route.fulfill({
        json: {
          id: 123456700 + repository.length,
          node_id: `R_${repository.replaceAll(/[^A-Za-z0-9]/gu, "_")}`,
          full_name: repository,
          description: "An open registry for reproducible research tools.",
          private: false,
          default_branch: "main",
          owner: {
            login: "example",
            id: 987654320,
            node_id: "O_registry",
            type: "Organization",
          },
        },
      });
    return route.fulfill({ status: 404, json: { message: "Not Found" } });
  });
}

async function draftApplication(page: Page) {
  const project = fixtureProject();
  await routeGitHub(page);
  await page.goto("/projects/new", { waitUntil: "networkidle" });
  await page.getByLabel("Public GitHub repository").fill(project.repository);
  await page.getByRole("button", { name: "Look up on GitHub" }).click();
  await expect(page.locator(".lookup-status")).toContainText(
    `Found ${project.repository}`,
  );
  await page.getByRole("button", { name: "Next: Contribution rules" }).click();
  await page.getByLabel("Project name").fill(project.name);
  await page.getByRole("button", { name: "Next: Rewards" }).click();
  await page.getByLabel("Monthly pool target, USD").fill("1000");
  await page.getByRole("button", { name: "Next: Funding" }).click();
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(
    page.getByRole("article", { name: "Listing preview" }),
  ).toContainText("$1,000 · unfunded pledge");
}

test("the shipped build lists no project @registry", async ({ page }) => {
  const errors = observe(page);
  const projects = await page.request.get("/api/v1/projects");
  expect(projects.status()).toBe(200);
  expect(await projects.json()).toMatchObject({ schemaVersion: "1" });
  await page.goto("/", { waitUntil: "networkidle" });
  const section = page.locator("#projects");
  await expect(section).toContainText("No projects are listed yet.");
  await expect(
    section.getByRole("link", { name: "Add a project" }),
  ).toHaveAttribute("href", "/projects/new");
  await expectAccessible(page);
  expect(errors).toEqual([]);
});

test("a signed-out visitor must sign in before submitting @registry", async ({
  page,
}) => {
  const errors = observe(page);
  await draftApplication(page);
  await expect(
    page.getByRole("link", { name: "Sign in with GitHub to submit" }),
  ).toHaveAttribute("href", /\/login\?next=%2Fprojects%2Fnew$/u);
  await expect(
    page.getByRole("button", { name: /Submit for review/u }),
  ).toHaveCount(0);
  const forged = await page.request.post("/api/v1/project-applications", {
    data: {},
    headers: { origin: "https://attacker.example" },
  });
  expect(forged.status()).toBe(403);
  await expectAccessible(page);
  expect(errors).toEqual([]);
});

test("a maintainer submits and an admin approves it as paused @registry", async ({
  browser,
}) => {
  const project = fixtureProject();
  const applicantContext = await browser.newContext();
  const applicant = await applicantContext.newPage();
  const applicantErrors = observe(applicant);
  await signIn(applicant, APPLICANT_TOKEN);
  await draftApplication(applicant);
  await applicant.getByRole("button", { name: /Submit for review/u }).click();
  const receipt = applicant.getByRole("status").filter({
    hasText: "Application submitted",
  });
  await expect(receipt).toContainText(
    `${project.name} is waiting for admin review`,
  );
  await expect(receipt).toContainText("submitted by @e2e-applicant");
  await expectAccessible(applicant);

  // An applicant is not an admin, so the review queue stays closed.
  await applicant.goto("/admin", { waitUntil: "networkidle" });
  await expect(applicant.getByRole("alert")).toContainText(
    "@e2e-applicant is not a Slop admin",
  );
  expect(applicantErrors).toEqual([]);
  await applicantContext.close();

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminErrors = observe(admin);
  await signIn(admin, ADMIN_TOKEN);
  await admin.goto("/admin", { waitUntil: "networkidle" });
  const card = admin.locator(".admin-card", { hasText: project.repository });
  await expect(card).toContainText(project.name);
  await expect(card).toContainText("$1,000 pledged");
  // No notify Worker runs locally, so the stored application says so.
  await expect(card).toContainText("Failed to send");
  await expectAccessible(admin);
  await card.getByRole("button", { name: "Approve as paused project" }).click();
  const listedCard = admin.locator(".admin-card", {
    has: admin.getByText(project.id, { exact: true }),
  });
  await expect(listedCard).toContainText("paused");
  await expect(listedCard).toContainText("1 · updated");

  const listed = await (await admin.request.get("/api/v1/projects")).json();
  expect(
    listed.projects.find((entry: { id: string }) => entry.id === project.id),
  ).toMatchObject({
    status: "paused",
    reward: { monthlyCapMinor: "1000000000", paymentMode: "disabled" },
  });
  const history = await (
    await admin.request.get("/api/v1/project-revisions")
  ).json();
  expect(
    history.revisions.filter(
      (entry: { projectId: string }) => entry.projectId === project.id,
    ),
  ).toMatchObject([{ revision: 1 }]);
  expect(adminErrors).toEqual([]);
  await adminContext.close();
});
