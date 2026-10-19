/**
 * Runs the D1 project registry end to end on the shipped build: the real
 * Pages Functions, a fresh local D1 with every migration, and two seeded
 * site sessions. scripts/run-e2e.mjs creates both sessions; only the
 * same-origin GitHub lookup answer is a fixture, so the run does not depend on
 * GitHub's rate limit (scripts/project-registry-api.test.ts covers the server
 * lookup). Project pages, skills and archives come from D1 with no rebuild.
 */
import { createHash } from "node:crypto";
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
    // Other APIs reject this local origin; only application failures count.
    if (
      message.type() === "error" &&
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
  await page.route("**/api/v1/project-github/repositories/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path !== `/api/v1/project-github/repositories/${repository}`)
      return route.fulfill({
        status: 404,
        json: {
          error: "not_found",
          message: "GitHub has no public repository with that name.",
        },
      });
    return route.fulfill({
      json: {
        repository: {
          repository,
          description: "An open registry for reproducible research tools.",
          numericId: String(123456700 + repository.length),
          nodeId: `R_${repository.replaceAll(/[^A-Za-z0-9]/gu, "_")}`,
          defaultBranch: "main",
          owner: {
            login: "example",
            actorId: "987654320",
            nodeId: "O_registry",
            kind: "organization",
          },
          license: {
            state: "unknown",
            reason: "GitHub found no license file.",
          },
        },
      },
    });
  });
}

const SKILL_SECTIONS: [string, string][] = [
  ["Scope", "Fixes and tested features in the open registry toolkit only."],
  [
    "Contribution guide",
    "Branch from main, keep one change per pull request, and follow CONTRIBUTING.md.",
  ],
  ["Supported tasks", "Reproduced bugs with a failing test."],
  ["Required tests", "Run `bun test` and attach the output."],
  [
    "Review expectations",
    "Confirm the new test fails on the base and passes on the head.",
  ],
  ["Security contact", "security@example.org"],
  ["Closure policy", "Maintainers close duplicates and untested changes."],
];

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
  for (const [label, value] of SKILL_SECTIONS)
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Next: Rewards" }).click();
  await page.getByLabel("Monthly pool target, USD").fill("1000");
  await page.getByRole("button", { name: "Next: Funding" }).click();
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(
    page.getByRole("article", { name: "Listing preview" }),
  ).toContainText("$1,000 · unfunded pledge");
}

test("an empty registry shows the empty state, never stale build data @registry", async ({
  page,
}) => {
  const errors = observe(page);
  const projects = await page.request.get("/api/v1/projects");
  expect(projects.status()).toBe(200);
  expect(projects.headers()["cache-control"]).toBe(
    "public, max-age=0, s-maxage=30",
  );
  expect(await projects.json()).toMatchObject({ schemaVersion: "1" });
  // Other viewports share this D1, so the empty registry is the API answer
  // the page receives, not an assumption about the database.
  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({ json: { schemaVersion: "1", projects: [] } }),
  );
  await page.goto("/", { waitUntil: "networkidle" });
  const section = page.locator("#projects");
  await expect(section.locator("a.project-card, a.project-row")).toHaveCount(0);
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

test("an admin activates the project and its generated skills serve without a rebuild @registry", async ({
  browser,
  request,
}) => {
  const project = fixtureProject();
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const errors = observe(admin);
  await signIn(admin, ADMIN_TOKEN);

  // The approved project already shows on the public site from D1.
  await admin.goto(`/projects/${project.id}`, { waitUntil: "networkidle" });
  await expect(admin.locator("h1")).toHaveText(project.name);
  await expect(admin.locator(".project-hero")).toContainText(
    "Reward asset: USDC on Base",
  );

  const skill = await request.get(`/projects/${project.id}/SKILL.md`);
  expect(skill.status()).toBe(200);
  expect(skill.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  const skillText = await skill.text();
  expect(skillText).toContain(`name: contribute-to-${project.id}`);
  expect(skillText).toContain('project-revision: "1"');
  expect(skillText).toContain("security@example.org");

  await admin.goto("/admin", { waitUntil: "networkidle" });
  const card = admin.locator(".admin-card", {
    has: admin.getByText(project.id, { exact: true }),
  });
  await card.getByRole("button", { name: "Edit manifest" }).click();
  await card.getByLabel("Project status").selectOption("active");
  await card
    .getByLabel("Reason for this revision (public history)")
    .fill("Activate with generated skills");
  await card.getByRole("button", { name: "Save revision 2" }).click();
  await expect(card).toContainText("active");
  await expect(card).toContainText("2 · updated");
  await expectAccessible(admin);

  // The edge cache was purged by the write, so revision 2 serves at once.
  const listed = await (
    await request.get(`/api/v1/projects/${project.id}`)
  ).json();
  expect(listed).toMatchObject({
    revision: 2,
    skillsPublished: true,
    project: { status: "active" },
  });
  expect(
    await (await request.get(`/projects/${project.id}/SKILL.md`)).text(),
  ).toContain('project-revision: "2"');
  const manifest = await (
    await request.get(`/projects/${project.id}/skill-manifest.json`)
  ).json();
  expect(manifest).toMatchObject({
    kind: "slop-generated-skill:v1",
    name: `contribute-to-${project.id}`,
    projectRevision: 2,
  });
  expect(manifest.skillRevision).toMatch(
    new RegExp(
      `^SlopDotCash/slopdotcash@[0-9a-f]{40}:skills/contribute-to-project\\+${project.id}@2#sha256:${manifest.digest}$`,
      "u",
    ),
  );
  const archive = await request.get(new URL(manifest.archive.url).pathname);
  expect(archive.status()).toBe(200);
  expect(
    createHash("sha256")
      .update(await archive.body())
      .digest("hex"),
  ).toBe(manifest.archive.sha256);
  const review = await request.get(`/projects/${project.id}/review/SKILL.md`);
  expect(await review.text()).toContain(
    `name: review-${project.id}-contributions`,
  );
  const discovery = await (
    await request.get("/.well-known/slop/projects.json")
  ).json();
  expect(
    discovery.projects.find(
      (entry: { project_id: string }) => entry.project_id === project.id,
    ),
  ).toMatchObject({ repository: project.repository, project_revision: 2 });
  expect((await request.get("/projects/not-a-project/SKILL.md")).status()).toBe(
    404,
  );

  await admin.goto(`/projects/${project.id}`, { waitUntil: "networkidle" });
  // An active project leads with its headline instead of the paused name.
  await expect(admin.locator("h1")).toHaveText(
    "An open registry for reproducible research tools.",
  );
  expect(errors).toEqual([]);
  await adminContext.close();
});

test("an unavailable registry shows an error, never an empty list @registry", async ({
  page,
}) => {
  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.goto("/", { waitUntil: "networkidle" });
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Projects are unavailable");
  await expect(alert).toContainText("HTTP 503");
  await expect(page.getByText("No projects are listed yet.")).toHaveCount(0);
  await expectAccessible(page);
});
