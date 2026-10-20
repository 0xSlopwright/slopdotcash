/**
 * Private security bounty programs end to end (PRD SEC-01 to SEC-18, the
 * MVP-13 matrix rows that can run locally). It runs on the shipped build with
 * the real Pages Functions, a fresh local D1 with every migration, seeded
 * sessions for each role, and the loopback GitHub API fixture for the
 * private-reporting readiness check. All findings and advisories are
 * synthetic. Nothing here reaches GitHub, a chain, or an email provider.
 */
import AxeBuilder from "@axe-core/playwright";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  E2E_SECURITY_ACCOUNTS,
  fixtureRepository,
} from "../github-api-fixture.mjs";
import { applicationManifest } from "../project-application-manifest";

type Role = keyof typeof E2E_SECURITY_ACCOUNTS;
const TOKENS = JSON.parse(
  process.env.SLOP_E2E_SECURITY_TOKENS ?? "{}",
) as Record<Role, string>;
const ADMIN_TOKEN = process.env.SLOP_E2E_ADMIN_TOKEN ?? "";
const APPLICANT_TOKEN = process.env.SLOP_E2E_APPLICANT_TOKEN ?? "";
const GITHUB_FIXTURE = process.env.SLOP_E2E_GITHUB_API_ORIGIN ?? "";
const COOKIE = "__Host-slop_points";

test.describe.configure({ mode: "serial" });

function account(role: Role) {
  return { githubId: E2E_SECURITY_ACCOUNTS[role], githubLogin: `e2e-${role}` };
}

type Reply = { status: number; body: Record<string, unknown> };

async function api(
  request: APIRequestContext,
  method: "GET" | "POST" | "PUT",
  path: string,
  token: string | null,
  data?: unknown,
): Promise<Reply> {
  const origin = new URL(test.info().project.use.baseURL ?? "").origin;
  const response = await request.fetch(`/api/v1/${path}`, {
    method,
    headers: {
      ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
      ...(method === "GET" ? {} : { origin }),
    },
    ...(data === undefined ? {} : { data }),
  });
  return { status: response.status(), body: await response.json() };
}

function bountyTerms(
  repository: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "1",
    status: "pending-approval",
    rewardMode: "bounty-only",
    eligibility: "critical-loss-of-funds",
    amount: {
      currency: "USD",
      decimals: 2,
      network: null,
      grossMinor: "1000000",
    },
    split: { researcherBasisPoints: 7500, slopBasisPoints: 2500 },
    sponsor: { name: "Slop", githubId: null },
    funding: { state: "pledged" },
    capacity: {
      awards: 1,
      closesAt: null,
      exhaustionRule:
        "Valid reports beyond capacity wait for owner-approved added funds; they are never relabeled.",
    },
    scope: {
      sourceRevisions: [{ repository, commit: "a".repeat(40) }],
      deployments: [],
      includedAssets: ["Vault deposits held by the protocol contracts"],
      excludedDependencies: [],
      testingPermission:
        "Local forks and isolated test networks only. No production testing.",
      severityRubric:
        "Critical means unauthorized loss or permanent theft of covered assets.",
      lossDefinition:
        "Unauthorized loss of covered assets caused by the defect, not market movement.",
    },
    intake: { kind: "github-private-vulnerability-reporting", repository },
    responseTargets: {
      acknowledgeHours: 24,
      triageBusinessDays: 3,
      updateIntervalDays: 7,
    },
    approvers: {
      technical: [account("security")],
      financial: [account("finance")],
      dispute: [account("dispute")],
    },
    dispute: {
      authority: "advisory",
      process: "An independent reviewer decides appeals privately in 14 days.",
    },
    disclosure:
      "The security maintainer controls disclosure. Nothing is published automatically.",
    safeHarbor:
      "Good-faith research inside this scope on local forks is authorized by the maintainers.",
    ...overrides,
  };
}

/** Applies through the real API, the way /projects/new does, then approves. */
async function listProject(
  request: APIRequestContext,
  applicantToken: string,
  repository: string,
  id: string,
  overrides: Record<string, unknown>,
) {
  const facts = fixtureRepository(repository);
  const manifest = applicationManifest(id, repository, {
    steward: {
      displayName: "Bounty maintainers",
      kind: facts.owner.type === "User" ? "individual" : "organization",
      github: {
        actorId: String(facts.owner.id),
        nodeId: facts.owner.node_id,
        login: facts.owner.login,
        type: facts.owner.type,
        profileUrl: `https://github.com/${facts.owner.login}`,
      },
      website: null,
    },
    authority: {
      state: "unverified",
      reason: "missing-repository-proof",
      role: "project-steward",
      repositoryId: String(facts.id),
      repositoryNodeId: facts.node_id,
      proof: null,
    },
    ...overrides,
  });
  const applied = await api(
    request,
    "POST",
    "project-applications",
    applicantToken,
    { manifest },
  );
  expect(applied.status, JSON.stringify(applied.body)).toBe(201);
  const application = applied.body.application as { id: string };
  const approved = await api(
    request,
    "POST",
    `admin/project-applications/${application.id}/approve`,
    ADMIN_TOKEN,
    {},
  );
  expect(approved.status).toBe(200);
}

async function adminProject(request: APIRequestContext, id: string) {
  const listed = await api(request, "GET", "admin/projects", ADMIN_TOKEN);
  return (
    listed.body.projects as {
      id: string;
      revision: number;
      updatedAt: string;
      manifest: Record<string, unknown>;
    }[]
  ).find((project) => project.id === id) as {
    id: string;
    revision: number;
    updatedAt: string;
    manifest: Record<string, unknown>;
  };
}

async function revise(
  request: APIRequestContext,
  id: string,
  change: (manifest: Record<string, unknown>) => Record<string, unknown>,
): Promise<Reply> {
  const project = await adminProject(request, id);
  return api(request, "PUT", `admin/projects/${id}/manifest`, ADMIN_TOKEN, {
    manifest: change(project.manifest),
    expectedRevision: project.revision,
    reason: "Security bounty program terms",
  });
}

function openTerms(terms: Record<string, unknown>): Record<string, unknown> {
  return {
    ...terms,
    status: "open",
    funding: {
      state: "verified-available",
      evidence: "Synthetic staging funding evidence reference E2E-1",
      verifiedAt: "2026-10-19T00:00:00.000Z",
    },
  };
}

let keyCounter = 0;
function key(): string {
  keyCounter += 1;
  return `e2e-key-${Date.now()}-${keyCounter}`.padEnd(16, "0");
}

async function act(
  request: APIRequestContext,
  role: Role,
  caseId: string,
  action: string,
  fields: Record<string, unknown> = {},
  revision?: number,
): Promise<Reply> {
  let expected = revision;
  if (expected === undefined) {
    const read = await api(
      request,
      "GET",
      `security-cases/${caseId}`,
      TOKENS[role],
    );
    expected = (read.body.case as { revision: number }).revision;
  }
  return api(
    request,
    "POST",
    `security-cases/${caseId}/actions`,
    TOKENS[role],
    {
      action,
      expectedRevision: expected,
      idempotencyKey: key(),
      ...fields,
    },
  );
}

async function recordCase(
  request: APIRequestContext,
  projectId: string,
  advisory: string,
  reporter: Role,
  receivedAt: string,
  maintainer: Role = "security",
): Promise<string> {
  const recorded = await api(
    request,
    "POST",
    "security-cases",
    TOKENS[maintainer],
    {
      mode: "record",
      projectId,
      advisory,
      reporterGithubId: account(reporter).githubId,
      reporterGithubLogin: account(reporter).githubLogin,
      receivedAt,
      confirmation: true,
      idempotencyKey: key(),
    },
  );
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
  return (recorded.body.case as { id: string }).id;
}

const DIGEST = "b".repeat(64);
const decision = (overrides: Record<string, unknown> = {}) => ({
  outcome: "confirmed",
  severity: "critical",
  loss: "verified-potential",
  inScope: true,
  relatedParty: false,
  rootCauseKey: "vault-share-rounding",
  evidenceReference: "private-advisory-comment-1",
  evidenceDigest: DIGEST,
  reason: "Reproduced on an isolated local fork at the covered revision.",
  ...overrides,
});

function observe(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/\/api\/v1\/(points|payments)\//u.test(message.location().url)
    )
      errors.push(message.text());
  });
  return errors;
}

async function signIn(page: Page, token: string) {
  await page.goto("/how-it-works", { waitUntil: "networkidle" });
  await page.evaluate(
    ([name, value]) => {
      document.cookie = `${name}=${value}; Path=/; Secure; SameSite=Strict`;
    },
    [COOKIE, token],
  );
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

async function setIntake(
  request: APIRequestContext,
  repository: string,
  state: string,
) {
  const response = await request.fetch(
    `${GITHUB_FIXTURE}/__fixture/private-vulnerability-reporting/${repository}/${state}`,
    { method: "PUT" },
  );
  expect(response.status()).toBe(204);
}

test("private security bounty programs keep cases restricted from intake to award @registry", async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const suffix = test.info().project.name.replace(/-chromium$/u, "");
  const a = {
    id: `bounty-a-${suffix}`,
    repository: `e2e-owner/bounty-a-${suffix}`,
  };
  const b = {
    id: `bounty-b-${suffix}`,
    repository: `example/bounty-b-${suffix}`,
  };

  await test.step("program setup: opt in during setup, admins open by revision", async () => {
    // Bounty-only needs no monthly pool: the application pledges $0.
    await listProject(request, TOKENS.security, a.repository, a.id, {
      reward: {
        ...(applicationManifest(a.id, a.repository).reward as object),
        monthlyCapMinor: "0",
        monthlyCapDisplay: "$0",
      },
      securityBounty: bountyTerms(a.repository),
    });
    await listProject(request, TOKENS["security-b"], b.repository, b.id, {});
    const bTerms = bountyTerms(b.repository, {
      rewardMode: "separate",
      sponsor: { name: "Example Foundation", githubId: null },
      amount: {
        currency: "USDC",
        decimals: 6,
        network: "base",
        grossMinor: "100000000000",
      },
      capacity: {
        awards: 3,
        closesAt: null,
        exhaustionRule:
          "New paid research pauses when three awards are reserved.",
      },
      approvers: {
        technical: [account("security-b")],
        financial: [account("finance")],
        dispute: [account("dispute")],
      },
    });
    // Invalid terms never become a revision.
    const refusals = await Promise.all([
      revise(request, b.id, (m) => ({
        ...m,
        securityBounty: openTerms({
          ...bTerms,
          amount: { ...(bTerms.amount as object), grossMinor: "100000000001" },
        }),
      })),
      revise(request, b.id, (m) => ({
        ...m,
        securityBounty: { ...bTerms, status: "open" },
      })),
      revise(request, b.id, (m) => ({
        ...m,
        securityBounty: openTerms({ ...bTerms, rewardMode: "bounty-only" }),
      })),
      revise(request, b.id, (m) => ({
        ...m,
        securityBounty: openTerms({
          ...bTerms,
          approvers: {
            technical: [account("security-b")],
            financial: [account("finance")],
            dispute: [account("security-b")],
          },
        }),
      })),
    ]);
    expect(refusals.map((reply) => reply.status)).toEqual([422, 422, 422, 422]);
    expect(String(refusals[0].body.message)).toContain("divisible by four");
    expect(String(refusals[1].body.message)).toContain(
      "open requires verified available funding",
    );
    expect(
      (
        await revise(request, b.id, (m) => ({
          ...m,
          securityBounty: openTerms(bTerms),
        }))
      ).status,
    ).toBe(200);
    const opened = await revise(request, a.id, (m) => ({
      ...m,
      securityBounty: openTerms(m.securityBounty as Record<string, unknown>),
    }));
    expect(opened.status).toBe(200);
    // A program is closed by revision, never removed.
    const removed = await revise(request, a.id, (m) => {
      const { securityBounty: _removed, ...rest } = m;
      return rest;
    });
    expect(removed.status).toBe(422);
    const terms = await request.get(`/projects/${a.id}/terms.json`);
    expect(await terms.json()).toMatchObject({
      securityBounty: {
        status: "open",
        rewardMode: "bounty-only",
        amount: { grossMinor: "1000000", currency: "USD" },
      },
    });
    const revisions = await api(request, "GET", "project-revisions", null);
    expect(
      (revisions.body.revisions as { projectId: string }[]).filter(
        (entry) => entry.projectId === a.id,
      ),
    ).toHaveLength(2);
  });

  const opened = await adminProject(request, a.id);
  // A receipt before the program opened freezes no paid terms.
  const beforeOpen = new Date(
    Date.parse(opened.updatedAt) - 60_000,
  ).toISOString();
  const afterOpen = new Date(Date.parse(opened.updatedAt) + 1).toISOString();
  await expect.poll(() => Date.now() > Date.parse(afterOpen) + 5).toBe(true);

  await test.step("public terms and amounts", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = observe(page);
    await page.goto(`/projects/${a.id}/security`, { waitUntil: "networkidle" });
    await expect(page.locator("h1")).toHaveText("Security bounty");
    await expect(page.locator(".security-lead")).toHaveText(
      "$7,500 for a confirmed critical vulnerability that can cause loss of funds. Funded by Slop.",
    );
    const facts = page.getByRole("region", { name: "Award terms" });
    await expect(facts).toContainText("Researcher award (75%)$7,500");
    await expect(facts).toContainText(
      "Gross funding per eligible finding$10,000",
    );
    await expect(facts).toContainText("Slop share (25%)$2,500");
    await expect(facts).toContainText("Bounty only.");
    await expectAccessible(page);
    await page.screenshot({
      path: test.info().outputPath("program-terms.png"),
      fullPage: true,
    });
    await page.goto(`/projects/${b.id}/security`, { waitUntil: "networkidle" });
    await expect(page.locator(".security-lead")).toContainText(
      "75,000 USDC for a confirmed critical vulnerability",
    );
    await expect(
      page.getByRole("region", { name: "Award terms" }),
    ).toContainText("Gross funding per eligible finding100,000 USDC");
    // The project page links the program.
    await page.goto(`/projects/${a.id}`, { waitUntil: "networkidle" });
    await expect(
      page.getByRole("link", { name: "Security bounty" }),
    ).toHaveAttribute("href", `/projects/${a.id}/security`);
    expect(errors).toEqual([]);
    await context.close();
  });

  await test.step("intake readiness gates the GitHub handoff", async () => {
    await setIntake(request, b.repository, "disabled");
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = observe(page);
    await page.clock.install();
    await page.goto(`/projects/${a.id}/security`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Check private reporting" }).click();
    const handoff = page.getByRole("link", {
      name: "Report privately on GitHub",
    });
    await expect(handoff).toHaveAttribute(
      "href",
      `https://github.com/${a.repository}/security/advisories/new`,
    );
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath("intake-ready.png") });
    // An old answer stops the handoff until the check runs again.
    await page.clock.fastForward(31_000);
    await expect(page.getByRole("alert")).toContainText("is out of date");
    await expect(handoff).toHaveCount(0);
    await page.goto(`/projects/${b.id}/security`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Check private reporting" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "private vulnerability reporting is turned off",
    );
    await expect(
      page.getByRole("link", { name: "Report privately on GitHub" }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
    for (const state of ["forbidden", "unavailable"]) {
      await setIntake(request, b.repository, state);
      const checked = await api(
        request,
        "GET",
        `security-programs/${b.id}/intake?state=${state}`,
        null,
      );
      expect(checked.body).toMatchObject({ state, handoffUrl: null });
    }
  });

  let caseA = "";
  let caseB = "";
  await test.step("a reporter links a GitHub report; only a maintainer verifies it", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = observe(page);
    await signIn(page, TOKENS["reporter-a"]);
    await page.goto("/security", { waitUntil: "networkidle" });
    await expect(page.locator("h1")).toHaveText("Security cases");
    await page.getByLabel("Project").selectOption(a.id);
    await page.getByLabel("GitHub advisory ID").fill("GHSA-2c3f-4g5h-6j7m");
    await page.getByRole("button", { name: "Link my GitHub report" }).click();
    await expect(page.getByRole("status")).toContainText("saved");
    await expect(page.locator(".security-case")).toContainText(
      "Not submitted yet — waiting for a maintainer to verify the link",
    );
    await expectAccessible(page);
    expect(errors).toEqual([]);
    await context.close();
    const mine = await api(
      request,
      "GET",
      "security-cases",
      TOKENS["reporter-a"],
    );
    caseA = (mine.body.cases as { id: string; projectId: string }[]).find(
      (entry) => entry.projectId === a.id,
    )?.id as string;
    expect(caseA).toMatch(/^sc_/u);
    const claimB = await api(
      request,
      "POST",
      "security-cases",
      TOKENS["reporter-b"],
      {
        mode: "claim",
        projectId: a.id,
        advisory: "GHSA-3c4f-5g6h-7j8m",
        idempotencyKey: key(),
      },
    );
    expect(claimB.status).toBe(201);
    caseB = (claimB.body.case as { id: string }).id;
    // A claim is not a receipt and the reporter cannot verify it.
    expect(
      (
        await act(request, "reporter-a", caseA, "verify-link", {
          receivedAt: afterOpen,
          confirmation: true,
        })
      ).status,
    ).toBe(403);
    // The maintainer verifies with GitHub's original receipt time.
    for (const id of [caseA, caseB]) {
      const verified = await act(request, "security", id, "verify-link", {
        receivedAt: afterOpen,
        confirmation: true,
      });
      expect(verified.status, JSON.stringify(verified.body)).toBe(200);
      expect(verified.body.case).toMatchObject({
        submissionState: "verified",
        receivedAt: afterOpen,
        policyRevision: opened.revision,
        terms: {
          grossMinor: "1000000",
          researcherMinor: "750000",
          slopMinor: "250000",
        },
        awardState: "pending",
      });
    }
  });

  await test.step("a rejected link can be corrected", async () => {
    const advisory = "GHSA-7c8f-9g2h-3j4m";
    const claim = () =>
      api(request, "POST", "security-cases", TOKENS["reporter-b"], {
        mode: "claim",
        projectId: a.id,
        advisory,
        idempotencyKey: key(),
      });
    const first = await claim();
    expect(first.status).toBe(201);
    const firstId = (first.body.case as { id: string }).id;
    // A record over an open claim writes nothing and is refused.
    const overClaim = await api(
      request,
      "POST",
      "security-cases",
      TOKENS.security,
      {
        mode: "record",
        projectId: a.id,
        advisory,
        reporterGithubId: account("reporter-b").githubId,
        reporterGithubLogin: account("reporter-b").githubLogin,
        receivedAt: afterOpen,
        confirmation: true,
        idempotencyKey: key(),
      },
    );
    expect(overClaim.body.error).toBe("claim_pending");
    expect(
      (
        await act(request, "security", firstId, "reject-link", {
          reason: "The advisory ID was mistyped in the link.",
        })
      ).status,
    ).toBe(200);
    const again = await claim();
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const againId = (again.body.case as { id: string }).id;
    expect(againId).not.toBe(firstId);
    const verified = await act(request, "security", againId, "verify-link", {
      receivedAt: afterOpen,
      confirmation: true,
    });
    expect(verified.body.case).toMatchObject({
      submissionState: "verified",
      receivedAt: afterOpen,
    });
  });

  await test.step("identity and access stay isolated", async () => {
    const read = (role: Role | "admin" | "applicant" | null, id: string) =>
      api(
        request,
        "GET",
        `security-cases/${id}`,
        role === null
          ? null
          : role === "admin"
            ? ADMIN_TOKEN
            : role === "applicant"
              ? APPLICANT_TOKEN
              : TOKENS[role],
      );
    expect((await read(null, caseA)).status).toBe(401);
    expect((await api(request, "GET", "security-cases", null)).status).toBe(
      401,
    );
    // Reporter A cannot read reporter B, and neither can outsiders.
    for (const [role, id] of [
      ["reporter-a", caseB],
      ["reporter-b", caseA],
      ["admin", caseA],
      ["applicant", caseA],
      ["security-b", caseA],
      ["finance", caseA],
      ["dispute", caseA],
    ] as const) {
      const reply = await read(role, id);
      expect(reply.status, `${role} reading ${id}`).toBe(404);
    }
    const adminList = await api(request, "GET", "security-cases", ADMIN_TOKEN);
    expect(
      (adminList.body.cases as { projectId: string }[]).filter(
        (entry) => entry.projectId === a.id,
      ),
    ).toEqual([]);
    const own = await read("reporter-a", caseA);
    expect(own.body.case).toMatchObject({
      view: "reporter",
      viewerRoles: ["reporter"],
    });
    expect(own.body.case).not.toHaveProperty("rootCauseKey");
    expect(own.body.case).not.toHaveProperty("triagers");
    // Triagers see only assigned cases, and lose access at once.
    expect(
      (
        await act(
          request,
          "security",
          caseA,
          "assign-triager",
          account("triager"),
        )
      ).status,
    ).toBe(200);
    expect((await read("triager", caseA)).status).toBe(200);
    expect((await read("triager", caseB)).status).toBe(404);
    expect(
      (await act(request, "triager", caseA, "decide", decision())).status,
    ).toBe(403);
    expect(
      (
        await act(request, "triager", caseA, "triage", {
          receiptState: "triaging",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await act(request, "security", caseA, "revoke-triager", {
          githubId: account("triager").githubId,
        })
      ).status,
    ).toBe(200);
    expect((await read("triager", caseA)).status).toBe(404);
  });

  await test.step("human decision reserves one award per root cause", async () => {
    const before = await api(
      request,
      "GET",
      `security-cases/${caseA}`,
      TOKENS.security,
    );
    const revision = (before.body.case as { revision: number }).revision;
    const decide = (idempotencyKey: string) =>
      api(request, "POST", `security-cases/${caseA}/actions`, TOKENS.security, {
        action: "decide",
        expectedRevision: revision,
        idempotencyKey,
        ...decision(),
      });
    const keys = [key(), key()];
    const replies = await Promise.all(keys.map(decide));
    // Two decisions from the same revision cannot both land.
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const landed = keys[replies.findIndex((reply) => reply.status === 200)];
    const replay = await decide(landed);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const decided = await api(
      request,
      "GET",
      `security-cases/${caseA}`,
      TOKENS.security,
    );
    expect(decided.body.case).toMatchObject({
      receiptState: "confirmed",
      awardState: "reserved",
      reservation: {
        rootCauseKey: "vault-share-rounding",
        grossMinor: "1000000",
      },
    });
    // The same root cause cannot reserve again through another report.
    expect(
      (await act(request, "security", caseB, "decide", decision())).body.error,
    ).toBe("root_cause_reserved");
    const duplicate = await act(
      request,
      "security",
      caseB,
      "decide",
      decision({
        outcome: "duplicate",
        duplicateOf: caseA,
        evidenceDigest: undefined,
        reason: "An earlier complete report covers this root cause.",
      }),
    );
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(200);
    expect(duplicate.body.case).toMatchObject({ awardState: "ineligible" });
    // The reporter learns the decision, never the other report.
    const seen = await api(
      request,
      "GET",
      `security-cases/${caseB}`,
      TOKENS["reporter-b"],
    );
    expect(JSON.stringify(seen.body)).not.toContain(caseA);
    expect(seen.body.case).not.toHaveProperty("duplicateOf");
  });

  await test.step("capacity, eligibility truth table and receipt freeze", async () => {
    // Capacity 1 is reserved, so a new valid finding is a financial
    // exception, not a relabeled finding.
    const third = await recordCase(
      request,
      a.id,
      "GHSA-4c5f-6g7h-8j9m",
      "reporter-a",
      afterOpen,
    );
    const exhausted = await act(
      request,
      "security",
      third,
      "decide",
      decision({ rootCauseKey: "oracle-staleness" }),
    );
    expect(exhausted.body.case).toMatchObject({
      receiptState: "confirmed",
      awardState: "capacity-exhausted",
    });
    const early = await recordCase(
      request,
      a.id,
      "GHSA-5c6f-7g8h-9j2m",
      "reporter-b",
      beforeOpen,
    );
    const earlyCase = await api(
      request,
      "GET",
      `security-cases/${early}`,
      TOKENS.security,
    );
    expect(earlyCase.body.case).toMatchObject({
      terms: null,
      awardState: "not-applicable",
    });
    const rows: [Record<string, unknown>, string][] = [
      [{ severity: "critical", loss: "not-verified" }, "ineligible"],
      [{ severity: "high", loss: "verified-potential" }, "ineligible"],
      [{ inScope: false }, "ineligible"],
      [{ loss: "verified-potential" }, "reserved"],
    ];
    let index = 0;
    for (const [overrides, expected] of rows) {
      index += 1;
      const id = await recordCase(
        request,
        b.id,
        `GHSA-6c7f-8g9h-2j${"3456"[index - 1]}m`,
        "reporter-a",
        new Date().toISOString(),
        "security-b",
      );
      const decided = await act(
        request,
        "security-b",
        id,
        "decide",
        decision({ rootCauseKey: `root-cause-${index}`, ...overrides }),
      );
      expect(decided.body.case, JSON.stringify(overrides)).toMatchObject({
        awardState: expected,
      });
    }
  });

  await test.step("raised capacity reserves an exhausted award, earliest receipt first", async () => {
    const cases = (
      (await api(request, "GET", "security-cases", TOKENS.finance)).body
        .cases as { id: string; projectId: string; awardState: string }[]
    ).filter(
      (entry) =>
        entry.projectId === a.id && entry.awardState === "capacity-exhausted",
    );
    expect(cases).toHaveLength(1);
    const third = cases[0].id;
    // A later valid finding also waits for capacity.
    const fourth = await recordCase(
      request,
      a.id,
      "GHSA-7c8f-9g2h-4j5m",
      "reporter-b",
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(
      (
        await act(
          request,
          "security",
          fourth,
          "decide",
          decision({ rootCauseKey: "bridge-replay" }),
        )
      ).body.case,
    ).toMatchObject({ awardState: "capacity-exhausted" });
    const reserve = (id: string) =>
      act(request, "finance", id, "reserve-award", {
        reason: "Capacity raised by revision; published exhaustion rule.",
      });
    // Without new capacity nothing changes and no event is written.
    const refused = await reserve(third);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("capacity_exhausted");
    // The technical maintainer cannot reserve money.
    expect(
      (
        await act(request, "security", third, "reserve-award", {
          reason: "Capacity raised by revision; published exhaustion rule.",
        })
      ).status,
    ).toBe(409);
    const raised = await revise(request, a.id, (m) => ({
      ...m,
      securityBounty: {
        ...(m.securityBounty as Record<string, unknown>),
        capacity: {
          ...((m.securityBounty as Record<string, unknown>).capacity as object),
          awards: 2,
        },
      },
    }));
    expect(raised.status).toBe(200);
    // A later decision cannot take the slot the earlier receipt waits for.
    const fifth = await recordCase(
      request,
      a.id,
      "GHSA-8c9f-2g3h-5j6m",
      "reporter-b",
      new Date(Date.now() - 500).toISOString(),
    );
    expect(
      (
        await act(
          request,
          "security",
          fifth,
          "decide",
          decision({ rootCauseKey: "price-feed-replay" }),
        )
      ).body.case,
    ).toMatchObject({ awardState: "capacity-exhausted", reservation: null });
    // The earlier receipt is funded first, whatever the request order.
    expect((await reserve(fourth)).body.error).toBe("earlier_receipt_waiting");
    expect((await reserve(fifth)).body.error).toBe("earlier_receipt_waiting");
    const reserved = await reserve(third);
    expect(reserved.status, JSON.stringify(reserved.body)).toBe(200);
    expect(reserved.body.case).toMatchObject({
      awardState: "reserved",
      receivedAtSource: "maintainer-attested",
      reservation: { grossMinor: "1000000", policyRevision: 2 },
      allowedActions: ["approve-award"],
    });
    // Capacity 2 is now used; the later findings still wait in receipt order.
    expect((await reserve(fourth)).body.error).toBe("capacity_exhausted");
    expect((await reserve(fifth)).body.error).toBe("earlier_receipt_waiting");
    const history = await api(
      request,
      "GET",
      `security-cases/${third}`,
      TOKENS["reporter-a"],
    );
    expect(
      (history.body.case as { events: { kind: string }[] }).events.map(
        (event) => event.kind,
      ),
    ).toEqual(["record", "decide", "reserve-award"]);
  });

  await test.step("a related-party award needs an independent reviewer", async () => {
    // Declared by the technical decider.
    const declared = await recordCase(
      request,
      b.id,
      "GHSA-8c9f-2g3h-4j5m",
      "reporter-b",
      new Date(Date.now() - 1000).toISOString(),
      "security-b",
    );
    const pending = await act(
      request,
      "security-b",
      declared,
      "decide",
      decision({ rootCauseKey: "related-declared", relatedParty: true }),
    );
    expect(pending.body.case).toMatchObject({
      receiptState: "confirmed",
      awardState: "pending",
      relatedParty: "related",
      relatedPartyReview: "pending",
      reservation: null,
    });
    // Finance sees nothing before an award is reserved.
    expect(
      (await api(request, "GET", `security-cases/${declared}`, TOKENS.finance))
        .status,
    ).toBe(404);
    // The technical decider cannot review its own related-party case.
    expect(
      (
        await act(request, "security-b", declared, "decide-related-party", {
          outcome: "approve",
          reason: "Approved after independent review.",
        })
      ).status,
    ).toBe(409);
    // A program approver as reporter is always a related party.
    const approverReport = await recordCase(
      request,
      b.id,
      "GHSA-9c2f-3g4h-5j6m",
      "finance",
      new Date(Date.now() - 1000).toISOString(),
      "security-b",
    );
    const automatic = await act(
      request,
      "security-b",
      approverReport,
      "decide",
      decision({ rootCauseKey: "related-approver" }),
    );
    expect(automatic.body.case).toMatchObject({
      relatedParty: "related",
      relatedPartyReview: "pending",
      awardState: "pending",
    });

    // The dispute reviewer approves in the real UI.
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = observe(page);
    await signIn(page, TOKENS.dispute);
    await page.goto("/security", { waitUntil: "networkidle" });
    await page
      .getByRole("button", {
        name: new RegExp(`${b.id} · GHSA-8c9f-2g3h-4j5m`, "u"),
      })
      .click();
    const detail = page.locator(".security-case");
    await expect(detail).toContainText("Waiting for an independent reviewer");
    await expect(detail).toContainText(
      "entered by a security maintainer from GitHub, not read from GitHub by Slop",
    );
    const form = detail.getByRole("form", {
      name: "Related-party award review",
    });
    await form.getByLabel("Outcome").selectOption("approve");
    await form
      .getByLabel("Private reason")
      .fill("The reporter has no control over the payer or the decision.");
    await form.getByRole("button", { name: "Record review" }).click();
    await expect(detail.getByRole("status")).toContainText(
      "Related-party award review: saved.",
    );
    await expect(detail).toContainText("Approved by an independent reviewer");
    await expectAccessible(page);
    await page.screenshot({
      path: test.info().outputPath("related-party-review.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await context.close();
    expect(
      (await api(request, "GET", `security-cases/${declared}`, TOKENS.finance))
        .body.case,
    ).toMatchObject({
      awardState: "reserved",
      relatedPartyReview: "approved",
      allowedActions: ["approve-award"],
    });

    // A refusal makes the award ineligible; the refuser cannot hear the appeal.
    const refused = await act(
      request,
      "dispute",
      approverReport,
      "decide-related-party",
      {
        outcome: "refuse",
        reason: "The approver controls payment for this program.",
      },
    );
    expect(refused.body.case).toMatchObject({
      awardState: "ineligible",
      relatedPartyReview: "refused",
    });
    expect(
      (
        await act(request, "finance", approverReport, "appeal", {
          reason: "I had no part in the decision or the payment for this case.",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await act(request, "dispute", approverReport, "decide-appeal", {
          outcome: "uphold",
          reason: "The refusal stands.",
        })
      ).status,
    ).toBe(403);
  });

  await test.step("appeal goes to an independent reviewer", async () => {
    expect(
      (
        await act(request, "reporter-b", caseB, "appeal", {
          reason:
            "My report describes a different withdrawal path with its own fix.",
        })
      ).status,
    ).toBe(200);
    const disputed = await api(
      request,
      "GET",
      `security-cases/${caseB}`,
      TOKENS.dispute,
    );
    expect(disputed.body.case).toMatchObject({
      receiptState: "disputed",
      allowedActions: ["decide-appeal"],
    });
    // The technical decider is not a dispute reviewer.
    expect(
      (
        await act(request, "security", caseB, "decide-appeal", {
          outcome: "uphold",
          reason: "The original decision stands.",
        })
      ).status,
    ).toBe(409);
    const returned = await act(request, "dispute", caseB, "decide-appeal", {
      outcome: "return",
      reason: "The withdrawal path needs a new technical review.",
    });
    expect(returned.body.case).toMatchObject({
      receiptState: "triaging",
      appealState: "returned",
      awardState: "pending",
    });
  });

  await test.step("finance approves a reserved award; nothing becomes paid", async () => {
    const finance = await api(
      request,
      "GET",
      `security-cases/${caseA}`,
      TOKENS.finance,
    );
    expect(finance.body.case).toMatchObject({
      view: "financial",
      awardState: "reserved",
      payee: { githubLogin: "e2e-reporter-a" },
      allowedActions: ["approve-award"],
    });
    expect(finance.body.case).not.toHaveProperty("advisory");
    expect(finance.body.case).not.toHaveProperty("severity");
    // A financial approver never sees cases without an award.
    expect(
      (await api(request, "GET", `security-cases/${caseB}`, TOKENS.finance))
        .status,
    ).toBe(404);
    const deadline = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const approved = await act(request, "finance", caseA, "approve-award", {
      paymentDeadline: deadline,
      confirmation: true,
    });
    expect(approved.body.case).toMatchObject({
      awardState: "approved",
      paymentState: "rail-unavailable",
      paymentRail: "unavailable",
    });
    // Remediation and disclosure stay separate: fixed and paid publish nothing.
    expect(
      (
        await act(request, "security", caseA, "remediation", {
          remediationState: "resolved",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await act(request, "security", caseA, "remediation", {
          remediationState: "resolved",
          evidenceReference: "private exact-head test log 1",
        })
      ).status,
    ).toBe(200);
    const after = await api(
      request,
      "GET",
      `security-cases/${caseA}`,
      TOKENS["reporter-a"],
    );
    expect(after.body.case).toMatchObject({
      remediationState: "resolved",
      awardState: "approved",
      disclosureState: "embargoed",
      recognition: "private",
    });
  });

  await test.step("a security inbox notice requires explicit acknowledgment, separately from read", async () => {
    const context = await browser.newContext({
      viewport: test.info().project.use.viewport,
      recordVideo: { dir: test.info().outputPath("acknowledgment-video") },
    });
    const page = await context.newPage();
    const errors = observe(page);
    await signIn(page, TOKENS["reporter-a"]);
    await page.goto("/inbox", { waitUntil: "networkidle" });
    const notice = page
      .getByRole("listitem")
      .filter({
        has: page.getByRole("button", {
          name: /^Acknowledge: Private security case /u,
        }),
      })
      .first();
    await expect(notice).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("security-notice-before.png"),
      fullPage: true,
    });
    const acknowledge = notice.getByRole("button", {
      name: /^Acknowledge: Private security case /u,
    });
    await acknowledge.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText(
      "Security notice acknowledged.",
    );
    await expect(
      page.getByText("Acknowledged", { exact: true }).first(),
    ).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(
      page.getByText("Acknowledged", { exact: true }).first(),
    ).toBeVisible();
    await expectAccessible(page);
    await page.screenshot({
      path: test.info().outputPath("security-notice-acknowledged.png"),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await expect(
      page.getByText("Acknowledged", { exact: true }).first(),
    ).toBeVisible();
    await expectAccessible(page);
    await page.screenshot({
      path: test.info().outputPath("security-notice-zoom.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await context.close();
  });

  await test.step("the reporter sees the case in the inbox UI", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = observe(page);
    await signIn(page, TOKENS["reporter-a"]);
    await page.goto("/security", { waitUntil: "networkidle" });
    await page
      .getByRole("button", {
        name: new RegExp(`${a.id} · GHSA-2c3f-4g5h-6j7m`, "u"),
      })
      .click();
    const detail = page.locator(".security-case");
    await expect(detail).toContainText(
      "$7,500 researcher · $2,500 Slop · $10,000 gross",
    );
    await expect(detail).toContainText("Approved, not paid.");
    await detail.getByLabel("Show my name publicly").selectOption("opt-in");
    await detail.getByRole("button", { name: "Save my choice" }).click();
    await expect(detail.getByRole("status")).toContainText(
      "Public recognition: saved.",
    );
    await expectAccessible(page);
    await page.screenshot({
      path: test.info().outputPath("reporter-case.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await context.close();
  });

  await test.step("no case data reaches public outputs", async () => {
    const outputs = await Promise.all(
      [
        "/api/v1/projects",
        "/api/v1/project-revisions",
        `/api/v1/projects/${a.id}`,
        `/projects/${a.id}/terms.json`,
        "/.well-known/slop/projects.json",
        `/projects/${a.id}/security`,
        "/",
      ].map(async (path) => (await request.get(path)).text()),
    );
    for (const text of outputs) {
      expect(text).not.toContain("GHSA-");
      expect(text).not.toContain(caseA);
      expect(text).not.toMatch(/sc_[A-Za-z0-9]{8}/u);
    }
  });
});
