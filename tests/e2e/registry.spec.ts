/**
 * Runs the D1 project registry end to end on the shipped build: the real
 * Pages Functions, a fresh local D1 with every migration, and four seeded
 * site sessions. scripts/run-e2e.mjs creates the sessions and serves the
 * loopback GitHub API fixture, which both the ownership check and the
 * same-origin setup lookups read, so the run never depends on GitHub's rate
 * limit. Project pages, skills and archives come from D1 with no rebuild.
 */
import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const APPLICANT_TOKEN = process.env.SLOP_E2E_APPLICANT_TOKEN ?? "";
const ADMIN_TOKEN = process.env.SLOP_E2E_ADMIN_TOKEN ?? "";
const OWNER_TOKEN = process.env.SLOP_E2E_OWNER_TOKEN ?? "";
const MODERATOR_TOKEN = process.env.SLOP_E2E_MODERATOR_TOKEN ?? "";

test.describe.configure({ mode: "serial" });

/**
 * Every viewport shares one D1, so each uses its own repositories and project
 * ids instead of assuming the registry it finds is empty. The organization
 * repository cannot prove control; the user repository belongs to e2e-owner.
 */
function fixtureProjects() {
  const suffix = test.info().project.name.replace(/-chromium$/u, "");
  const words = suffix.replaceAll("-", " ");
  return {
    queued: {
      repository: `example/open-registry-${suffix}`,
      id: `open-registry-${suffix}`,
      name: `Open Registry ${words}`,
    },
    owned: {
      repository: `e2e-owner/owned-registry-${suffix}`,
      id: `owned-registry-${suffix}`,
      name: `Owned Registry ${words}`,
    },
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

async function draftApplication(
  page: Page,
  project: { repository: string; name: string },
) {
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

async function listedProject(page: Page, id: string) {
  const body = await (await page.request.get("/api/v1/projects")).json();
  return body.projects.find((entry: { id: string }) => entry.id === id);
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

test("a signed-out visitor must sign in to look up GitHub and submit @registry", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // The lookup API answers a signed-out visitor with an expected 401.
    if (
      message.type() === "error" &&
      !/\/api\/v1\/(points|payments|project-github)\//u.test(
        message.location().url,
      )
    )
      errors.push(message.text());
  });
  const project = fixtureProjects().queued;
  await page.goto("/projects/new", { waitUntil: "networkidle" });
  await page.getByLabel("Public GitHub repository").fill(project.repository);
  await page.getByRole("button", { name: "Look up on GitHub" }).click();
  // Setup lookups run on the site server with the site session, so a
  // signed-out browser never calls GitHub and nothing is filled in.
  await expect(page.locator(".lookup-status.field-error")).toBeVisible();
  await expect(page.getByLabel("Repository numeric ID")).toHaveValue("");
  await expect(
    page.getByRole("link", { name: "Sign in with GitHub", exact: true }),
  ).toHaveAttribute("href", /\/login\?next=%2Fprojects%2Fnew$/u);
  const lookup = await page.request.get(
    `/api/v1/project-github/repositories/${project.repository}`,
  );
  expect(lookup.status()).toBe(401);
  const forged = await page.request.post("/api/v1/project-applications", {
    data: {},
    headers: { origin: "https://attacker.example" },
  });
  expect(forged.status()).toBe(403);
  await expectAccessible(page);
  expect(errors).toEqual([]);
});

test("an unproven application waits for an admin, who lists it paused @registry", async ({
  browser,
}) => {
  const project = fixtureProjects().queued;
  const applicantContext = await browser.newContext();
  const applicant = await applicantContext.newPage();
  const applicantErrors = observe(applicant);
  await signIn(applicant, APPLICANT_TOKEN);
  await draftApplication(applicant, project);
  await applicant.getByRole("button", { name: /Submit for review/u }).click();
  const receipt = applicant.getByRole("status").filter({
    hasText: "Application submitted",
  });
  await expect(receipt).toContainText(
    "GitHub check: Not proven: @e2e-applicant is not a public member of example",
  );
  await expect(receipt).toContainText("submitted by @e2e-applicant");
  await expectAccessible(applicant);
  expect(await listedProject(applicant, project.id)).toBeUndefined();

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
  await expect(listedCard).toContainText("Generated from revision 1");

  expect(await listedProject(admin, project.id)).toMatchObject({
    status: "paused",
    listingTier: "community",
    skill: {
      id: `contribute-to-${project.id}`,
      sourcePath: "skills/project-contributor-template",
    },
    reward: { monthlyCapMinor: "1000000000", paymentMode: "disabled" },
    contribution: {
      approvedScope: expect.stringMatching(/^Merged pull requests/u),
    },
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

test("an owner's proof and generated skills reach the admin, who lists and delists it @registry", async ({
  browser,
}) => {
  const project = fixtureProjects().owned;
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const ownerErrors = observe(owner);
  await signIn(owner, OWNER_TOKEN);
  await draftApplication(owner, project);
  await owner.getByRole("button", { name: /Submit for review/u }).click();
  const receipt = owner.getByRole("status").filter({
    hasText: "Application submitted",
  });
  await expect(receipt).toContainText(
    `GitHub check: Proven: @e2e-owner owns ${project.repository}`,
  );
  await expectAccessible(owner);
  // Every application waits for an admin, even a proven owner's (PRJ-02).
  expect(await listedProject(owner, project.id)).toBeUndefined();
  const mine = await (
    await owner.request.get("/api/v1/project-applications/mine", {
      headers: { cookie: `__Host-slop_points=${OWNER_TOKEN}` },
    })
  ).json();
  const listed = mine.applications.find(
    (entry: { projectId: string }) => entry.projectId === project.id,
  ).manifest;

  // Facts that GitHub does not confirm are refused, never listed.
  // The request API keeps the expected 422 out of the page console.
  const forgedResponse = await owner.request.post(
    "/api/v1/project-applications",
    {
      // The request client sends no Secure cookie over local http.
      headers: {
        origin: new URL(owner.url()).origin,
        cookie: `__Host-slop_points=${OWNER_TOKEN}`,
      },
      data: {
        manifest: {
          ...listed,
          id: `${project.id}-forged`,
          slug: `${project.id}-forged`,
          skill: {
            ...listed.skill,
            publicPath: `/projects/${project.id}-forged/skill.md`,
          },
          repositories: [
            {
              ...listed.repositories[0],
              id: `${project.repository}-forged`,
              displayName: `${project.repository}-forged`,
              githubUrl: `https://github.com/${project.repository}-forged`,
            },
          ],
          links: {
            ...listed.links,
            repository: `https://github.com/${project.repository}-forged`,
          },
        },
      },
    },
  );
  const forged = {
    status: forgedResponse.status(),
    body: await forgedResponse.json(),
  };
  expect(forged).toMatchObject({
    status: 422,
    body: { error: "invalid_manifest" },
  });
  expect(ownerErrors).toEqual([]);
  await ownerContext.close();

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminErrors = observe(admin);
  await signIn(admin, ADMIN_TOKEN);
  await admin.goto("/admin", { waitUntil: "networkidle" });
  const application = admin.locator(".admin-card", {
    hasText: project.repository,
  });
  await expect(application).toContainText(
    `Proven: @e2e-owner owns ${project.repository}`,
  );
  // The admin reviews the exact generated skill before approving it.
  await application
    .getByText("Preview generated contributor skill", { exact: true })
    .click();
  await expect(
    application.getByLabel("Contributor skill SKILL.md"),
  ).toHaveValue(new RegExp(`# Contribute to ${project.repository}`, "u"));
  await expect(
    application.getByLabel("Contributor skill project.json"),
  ).toHaveValue(/"approvedScope": "Merged pull requests/u);
  await expectAccessible(admin);
  await application
    .getByRole("button", { name: "Approve as paused project" })
    .click();
  const card = admin.locator(".admin-card", {
    has: admin.getByText(project.id, { exact: true }),
  });
  await expect(card).toContainText("Generated from revision 1");

  // The installer's trust root: the exact approved bytes and their digest.
  const revision = await (
    await admin.request.get(`/api/v1/project-revisions/${project.id}/1`)
  ).json();
  expect(createHash("sha256").update(revision.manifestText).digest("hex")).toBe(
    revision.manifestSha256,
  );
  expect(JSON.parse(revision.manifestText)).toMatchObject({
    id: project.id,
    skill: { sourcePath: "skills/project-contributor-template" },
  });

  await card.getByRole("button", { name: "Delist", exact: true }).click();
  await card.getByRole("button", { name: "Delist project" }).click();
  await expect(admin.getByRole("status")).toContainText("Saved.");
  await expect(card).toContainText("Delisted.");
  expect(await listedProject(admin, project.id)).toMatchObject({
    status: "paused",
    listingTier: "retired",
  });
  expect(adminErrors).toEqual([]);
  await adminContext.close();
});

test("an admin activates a project and its generated skills serve without a rebuild @registry", async ({
  browser,
  request,
}) => {
  const project = fixtureProjects().queued;
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const errors = observe(admin);
  await signIn(admin, ADMIN_TOKEN);

  // The approved paused project already shows on the public site from D1.
  await admin.goto(`/projects/${project.id}`, { waitUntil: "networkidle" });
  await expect(admin.locator("h1")).toHaveText(project.name);
  // The reward asset is the Base stablecoin the application chose.
  await expect(admin.locator(".project-hero")).toContainText(
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  );
  const skill = await request.get(`/projects/${project.id}/skill.md`);
  expect(skill.status()).toBe(200);
  expect(skill.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  expect(await skill.text()).toContain(`name: contribute-to-${project.id}`);
  expect(
    await (await request.get(`/projects/${project.id}/SKILL.md`)).text(),
  ).toBe(await skill.text());

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
  expect(
    await (await request.get(`/api/v1/projects/${project.id}`)).json(),
  ).toMatchObject({
    revision: 2,
    skillsPublished: true,
    project: { status: "active" },
  });
  const manifest = await (
    await request.get(`/projects/${project.id}/skill-manifest.json`)
  ).json();
  expect(manifest).toMatchObject({
    name: `contribute-to-${project.id}`,
    source: { path: "skills/project-contributor-template/SKILL.md" },
    authority: {
      canonicalPath: "skills/project-contributor-template",
      registry: { projectId: project.id, revision: 2 },
    },
  });
  const revision = await (
    await request.get(`/api/v1/project-revisions/${project.id}/2`)
  ).json();
  expect(manifest.authority.registry.manifestSha256).toBe(
    revision.manifestSha256,
  );
  const archive = await request.get(new URL(manifest.archive.url).pathname);
  expect(archive.status()).toBe(200);
  expect(archive.headers()["content-disposition"]).toBe("attachment");
  expect(
    createHash("sha256")
      .update(await archive.body())
      .digest("hex"),
  ).toBe(manifest.archive.sha256);
  expect(
    await (
      await request.get(new URL(manifest.archive.checksumUrl).pathname)
    ).text(),
  ).toBe(`${manifest.archive.sha256}  contribute-to-${project.id}.skill\n`);
  for (const guide of ["codex.md", "claude.md", "manual.md"]) {
    const response = await request.get(`/projects/${project.id}/${guide}`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(
      `skills/project-contributor-template`,
    );
  }
  expect(
    await (await request.get(`/projects/${project.id}/review/SKILL.md`)).text(),
  ).toContain(`name: review-${project.id}-contributions`);
  const discovery = await (
    await request.get("/.well-known/slop/projects.json")
  ).json();
  expect(
    discovery.projects.find(
      (entry: { project_id: string }) => entry.project_id === project.id,
    ),
  ).toMatchObject({
    repository: project.repository,
    skill_source: "skills/project-contributor-template",
  });
  expect(
    (await request.get(`/projects/${project.id}/terms.json`)).status(),
  ).toBe(200);
  expect((await request.get("/projects/not-a-project/skill.md")).status()).toBe(
    404,
  );

  // An active project leads with its headline instead of the paused name.
  await admin.goto(`/projects/${project.id}`, { waitUntil: "networkidle" });
  await expect(admin.locator("h1")).not.toHaveText(project.name);
  expect(errors).toEqual([]);
  await adminContext.close();
});

test("the applicant's inbox lists each decision and revision once and keeps the read state @registry", async ({
  browser,
}) => {
  const project = fixtureProjects().queued;
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = observe(page);
  await signIn(page, APPLICANT_TOKEN);
  await page.goto("/inbox", { waitUntil: "networkidle" });
  await expect(page.locator("h1")).toHaveText("Inbox");
  const approved = page.locator(".inbox-item", {
    hasText: `Your application for ${project.id} was approved.`,
  });
  const revised = page.locator(".inbox-item", {
    hasText: `The ${project.id} project manifest changed.`,
  });
  await expect(approved).toHaveCount(1);
  await expect(revised).toHaveCount(1);
  await expect(approved.locator(".inbox-state")).toHaveText("Unread");
  await expect(
    approved.getByRole("link", { name: "Open project" }),
  ).toHaveAttribute("href", `/projects/${project.id}`);
  await expect(revised).toContainText("Activate with generated skills");
  await expectAccessible(page);

  await revised.getByRole("button", { name: /^Mark as read/u }).click();
  await expect(page.getByRole("status")).toHaveText("Marked as read.");
  await expect(revised.locator(".inbox-state")).toHaveText("Read");
  await expect(revised.getByRole("button")).toHaveCount(0);
  // The read state is stored, not kept only in the page.
  await page.reload({ waitUntil: "networkidle" });
  await expect(revised.locator(".inbox-state")).toHaveText("Read");
  await expect(approved.locator(".inbox-state")).toHaveText("Unread");

  // The request client sends no Secure cookie over local http.
  const cookie = `__Host-slop_points=${APPLICANT_TOKEN}`;
  const inbox = await (
    await page.request.get("/api/v1/notifications", { headers: { cookie } })
  ).json();
  // One row per event: the decision and the revision, never a duplicate.
  const mine = inbox.notifications.filter(
    (entry: { subject: string }) => entry.subject === project.id,
  );
  expect(mine.map((entry: { kind: string }) => entry.kind).sort()).toEqual([
    "application_approved",
    "project_revision",
  ]);
  const keys = inbox.notifications.map(
    (entry: { eventKey: string }) => entry.eventKey,
  );
  expect(new Set(keys).size).toBe(keys.length);
  const forged = await page.request.post("/api/v1/notifications/read", {
    headers: { cookie, origin: "https://attacker.example" },
    data: { eventKeys: [`project-revision:${project.id}:2`] },
  });
  expect(forged.status()).toBe(403);
  expect(errors).toEqual([]);
  await context.close();
});

test("a moderator quarantines and bans a project, and another moderator reinstates it @registry", async ({
  browser,
  request,
}) => {
  const project = fixtureProjects().queued;
  const evidence = `https://github.com/${project.repository}/security/advisories/GHSA-e2e`;
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminErrors = observe(admin);
  await signIn(admin, ADMIN_TOKEN);
  await admin.goto("/admin", { waitUntil: "networkidle" });
  const card = () =>
    admin.locator(".admin-card", {
      has: admin.getByText(project.id, { exact: true }),
    });
  const panel = () =>
    card().getByRole("region", { name: "Enforcement", exact: true });
  await expect(panel()).toContainText("No restriction");

  // Each action needs a reason, an evidence reference, the server preview
  // and a confirmation.
  async function act(action: string, reason: string) {
    await panel().getByLabel("Action").selectOption({ label: action });
    await panel().getByLabel("Reason (private audit record)").fill(reason);
    await panel()
      .getByLabel("Evidence reference (link or case id)")
      .fill(evidence);
    await panel().getByRole("button", { name: "Preview action" }).click();
    const preview = panel().getByRole("group", {
      name: "Preview: check it, then confirm",
    });
    await expect(preview).toContainText(project.id);
    return preview;
  }

  const quarantine = await act(
    "Quarantine",
    "Confirmed malware in the release script",
  );
  await expect(quarantine).toContainText("2 → 3");
  await expect(quarantine).toContainText("active, community → paused, retired");
  await expect(quarantine).toContainText("Appends the matching revision");
  await expectAccessible(admin);
  await quarantine.getByRole("button", { name: "Confirm: Quarantine" }).click();
  await expect(admin.getByRole("status").first()).toContainText(
    "Quarantine recorded",
  );
  await expect(panel()).toContainText("Quarantined");
  await expect(card()).toContainText("3 · updated");

  // Every public route closes at once: the cached list, the direct project
  // read, the skill, the archive and the discovery index.
  const registry = await (await request.get("/api/v1/projects")).json();
  expect(registry.restrictions).toContainEqual(
    expect.objectContaining({ projectId: project.id, state: "quarantined" }),
  );
  expect(
    registry.projects.find((entry: { id: string }) => entry.id === project.id),
  ).toMatchObject({ status: "paused", listingTier: "retired" });
  expect((await request.get(`/api/v1/projects/${project.id}`)).status()).toBe(
    410,
  );
  expect((await request.get(`/projects/${project.id}/SKILL.md`)).status()).toBe(
    410,
  );
  expect(
    (
      await request.get(
        `/projects/${project.id}/downloads/contribute-to-${project.id}.skill`,
      )
    ).status(),
  ).toBe(410);
  const discovery = await (
    await request.get("/.well-known/slop/projects.json")
  ).json();
  expect(
    discovery.projects.some(
      (entry: { project_id: string }) => entry.project_id === project.id,
    ),
  ).toBe(false);

  const ban = await act("Ban project", "Repeated malware after notice");
  await expect(ban).toContainText("Stays at 3");
  await expect(ban).toContainText("No revision needed");
  await ban.getByRole("button", { name: "Confirm: Ban project" }).click();
  await expect(panel()).toContainText("Banned");
  const appeal = await act(
    "Request reinstatement",
    "Maintainer removed the script and asked for review",
  );
  await appeal
    .getByRole("button", { name: "Confirm: Request reinstatement" })
    .click();
  await expect(panel()).toContainText("Reinstatement requested");

  // The moderator who placed the restriction cannot decide the appeal. The
  // request API keeps the expected 403 out of the page console.
  const current = await (
    await admin.request.get("/api/v1/admin/projects", {
      headers: { cookie: `__Host-slop_points=${ADMIN_TOKEN}` },
    })
  ).json();
  const restricted = current.projects.find(
    (entry: { id: string }) => entry.id === project.id,
  );
  const self = await admin.request.post(
    `/api/v1/admin/projects/${project.id}/enforcement-preview`,
    {
      headers: {
        origin: new URL(admin.url()).origin,
        cookie: `__Host-slop_points=${ADMIN_TOKEN}`,
      },
      data: {
        action: "reinstate",
        reason: "Self review",
        evidenceReference: evidence,
        expectedRevision: restricted.revision,
        expectedSequence: restricted.enforcement.nextSequence,
      },
    },
  );
  expect(self.status()).toBe(403);
  expect((await self.json()).error).toBe("independent_review_required");
  expect(adminErrors).toEqual([]);
  await adminContext.close();

  const moderatorContext = await browser.newContext();
  const moderator = await moderatorContext.newPage();
  const moderatorErrors = observe(moderator);
  await signIn(moderator, MODERATOR_TOKEN);
  await moderator.goto("/admin", { waitUntil: "networkidle" });
  const moderatorPanel = moderator
    .locator(".admin-card", {
      has: moderator.getByText(project.id, { exact: true }),
    })
    .getByRole("region", { name: "Enforcement", exact: true });
  await expect(moderatorPanel).toContainText("@e2e-admin");
  await moderatorPanel
    .getByLabel("Action")
    .selectOption({ label: "Reinstate after review" });
  await moderatorPanel
    .getByLabel("Reason (private audit record)")
    .fill("A fresh complete scan found no malware");
  await moderatorPanel
    .getByLabel("Evidence reference (link or case id)")
    .fill(evidence);
  await moderatorPanel.getByRole("button", { name: "Preview action" }).click();
  const reinstate = moderatorPanel.getByRole("group", {
    name: "Preview: check it, then confirm",
  });
  // Reinstatement lists the project again in the community tier, paused.
  await expect(reinstate).toContainText("3 → 4");
  await expect(reinstate).toContainText("paused, retired → paused, community");
  await expectAccessible(moderator);
  await reinstate
    .getByRole("button", { name: "Confirm: Reinstate after review" })
    .click();
  await expect(moderatorPanel).toContainText("No restriction");
  await moderatorPanel.getByText(/Enforcement history/u).click();
  await expect(moderatorPanel.locator("li")).toHaveCount(4);
  expect(
    await (await request.get(`/api/v1/projects/${project.id}`)).json(),
  ).toMatchObject({
    revision: 4,
    project: { status: "paused", listingTier: "community" },
  });
  expect((await request.get(`/projects/${project.id}/SKILL.md`)).status()).toBe(
    200,
  );
  expect(moderatorErrors).toEqual([]);
  await moderatorContext.close();
});

test("an unavailable registry shows an error, never an empty list @registry", async ({
  page,
}) => {
  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.goto("/", { waitUntil: "networkidle" });
  // The failure is an alert with its status and a retry, never a list.
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("503");
  await expect(alert.getByRole("button")).toBeVisible();
  await expect(page.locator("#projects")).toHaveCount(0);
  await expectAccessible(page);
});
