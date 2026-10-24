// The bounded scan service end to end (PRD section 8; issue #909): one
// pass refreshes the queue, acquires the exact Git and template bytes,
// inspects them, runs the Surplus primary review and, only for an ambiguous
// result, the Surplus specialist, retains the evidence and publishes once.
// Every route is a real handler on the real migrations with local workerd
// R2. The Git API, GitHub identity and Surplus provider are local fixtures
// that answer exactly as those services do; no real provider or key is used.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudflareProjectPersistence } from "../backend/projects/cloudflare-persistence";
import { handleProjectApi } from "../backend/projects/handler";
import {
  handleVettingApi,
  signedVettingRequest,
} from "../backend/vetting/handler";
import { CloudflareVettingPersistence } from "../backend/vetting/persistence";
import { applicationManifest } from "../tests/project-application-manifest";
import { sqliteD1 } from "../tests/sqlite-d1";
import { localVettingEvidence } from "../tests/vetting-evidence-fixture";
import { runScanPass, type ScanServiceConfig } from "../workers/vetting/run";
import {
  SCAN_REVIEW_AREAS,
  type ScannerProfile,
} from "../workers/vetting/scanners";

const ORIGIN = "https://slop.cash";
const NOW = new Date("2026-10-18T12:00:00.000Z");
const APPLICANT = { githubId: "900000002", githubLogin: "e2e-applicant" };
const ADMIN = { githubId: "900000001", githubLogin: "e2e-admin" };
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const templateText = "Follow the project rules and run the tests.\n";
const rendererText = "export const render = (value) => value;\n";
const templateInputs = {
  contributor: {
    sourcePath: "skills/contributor",
    files: [{ path: "SKILL.md", sha256: digest(templateText) }],
  },
  reviewer: {
    sourcePath: "skills/reviewer",
    files: [{ path: "SKILL.md", sha256: digest(templateText) }],
  },
  rendererSources: [{ path: "src/render.mjs", sha256: digest(rendererText) }],
  acceptedRevisions: ["1"],
};
const TEMPLATE = digest(JSON.stringify(templateInputs));
const REPOSITORY_FILES: Record<string, string> = {
  "README.md": "# Fixture\nRun `bun test`.\n",
  "AGENTS.md": "Keep changes small and run the tests.\n",
  "package.json": JSON.stringify({
    name: "fixture",
    scripts: { test: "bun test" },
  }),
  "bun.lock": '{"lockfileVersion":1}',
  "src/index.ts": "export const parse = (value: string) => value.trim();\n",
};

let root: string;
let commitSha: string;
let gitObjects: Map<string, { type: string; body: Buffer }>;
let treeEntries: { path: string; mode: string; type: string; sha: string }[];
let treeSha: string;
let retained: Awaited<ReturnType<typeof localVettingEvidence>>;
let projects: CloudflareProjectPersistence;
let vetting: CloudflareVettingPersistence;
let server: ReturnType<typeof Bun.serve>;
let config: ScanServiceConfig;
let resultPublicKeys: string;
let ids = 0;
/** What the synthetic Surplus provider answers on each transport. */
let provider: {
  up: boolean;
  specialistUp: boolean;
  primary: "no-findings" | "findings";
  calls: { path: string; model: string; authorization: string | null }[];
};

const git = (cwd: string, ...args: string[]) => {
  const output = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
  });
  if (output.status !== 0) throw new Error(output.stderr.toString());
  return output.stdout;
};

async function gitFixture() {
  const repository = join(root, "git");
  for (const [path, text] of Object.entries(REPOSITORY_FILES)) {
    await mkdir(join(repository, path, ".."), { recursive: true });
    await writeFile(join(repository, path), text);
  }
  git(repository, "init", "-q");
  git(repository, "add", ".");
  git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-qm",
    "Harmless fixture",
  );
  commitSha = git(repository, "rev-parse", "HEAD").toString().trim();
  treeSha = git(repository, "rev-parse", "HEAD^{tree}").toString().trim();
  treeEntries = git(repository, "ls-tree", "-r", "-t", "HEAD")
    .toString()
    .trim()
    .split("\n")
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, type, sha] = meta.split(" ");
      return { path, mode, type, sha };
    });
  gitObjects = new Map(
    treeEntries
      .filter((entry) => entry.type === "blob")
      .map((entry) => [
        entry.sha,
        {
          type: "blob",
          body: git(repository, "cat-file", "blob", entry.sha),
        },
      ]),
  );
}

function review(items: { id: string }[], verdict: string) {
  return JSON.stringify({
    verdict,
    confidence: 0.9,
    coverage: Object.fromEntries(
      SCAN_REVIEW_AREAS.map((area) => [area, "complete"]),
    ),
    findings:
      verdict === "findings"
        ? [
            {
              severity: "medium",
              summary: "Synthetic finding that needs a second opinion",
              evidenceIds: [items[0].id],
            },
          ]
        : [],
  });
}

/** Answers like Surplus: Anthropic Messages and OpenAI Responses. */
async function surplus(request: Request, path: string): Promise<Response> {
  const body = (await request.json()) as {
    model: string;
    messages?: { content: string }[];
    input?: string;
  };
  provider.calls.push({
    path,
    model: body.model,
    authorization: request.headers.get("authorization"),
  });
  if (
    !provider.up ||
    (!provider.specialistUp && path === "/openai/v1/responses")
  )
    return new Response("unavailable", { status: 503 });
  const usage = {
    input_tokens: 8,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 5,
  };
  if (path === "/anthropic/v1/messages") {
    const items = JSON.parse(body.messages?.[0].content ?? "{}").items;
    return Response.json({
      id: "msg_fixture",
      model: body.model,
      stop_reason: "end_turn",
      content: [
        {
          type: "thinking",
          thinking: "Synthetic reasoning block",
          signature: "fixture",
        },
        { type: "text", text: review(items, provider.primary) },
      ],
      usage,
    });
  }
  const items = JSON.parse(body.input ?? "{}").items;
  return Response.json({
    id: "resp_fixture",
    model: body.model,
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: review(items, "no-findings") }],
      },
    ],
    usage: {
      input_tokens: 8,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
    },
  });
}

const readLivePin = async () => ({ commitSha, templateSha256: TEMPLATE });
const randomId = () =>
  `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const actorOf = (request: Request) =>
  ({ applicant: APPLICANT, admin: ADMIN })[
    request.headers.get("x-test-actor") ?? ""
  ] ?? null;

function projectApi(request: Request) {
  return handleProjectApi(request, {
    persistence: projects,
    adminGithubIds: new Set([ADMIN.githubId]),
    moderatorGithubIds: new Set([ADMIN.githubId]),
    now: () => NOW,
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
        readLivePin,
        forReinstatement,
      ),
  }) as Promise<Response>;
}

async function route(incoming: Request): Promise<Response> {
  const url = new URL(incoming.url);
  const host = incoming.headers.get("x-fixture-host");
  const path = url.pathname;
  if (host === "api.surplusintelligence.ai") return surplus(incoming, path);
  if (host === "raw.githubusercontent.com")
    return path.endsWith("/src/render.mjs")
      ? new Response(rendererText)
      : new Response(null, { status: 404 });
  if (host === "api.github.com") {
    if (path === "/repos/example/open-registry")
      return Response.json({
        id: 123456789,
        node_id: "R_example",
        full_name: "example/open-registry",
        private: false,
      });
    const git = /^\/repos\/example\/open-registry\/git\/(.+)$/u.exec(path)?.[1];
    if (git === `commits/${commitSha}`)
      return Response.json({ sha: commitSha, tree: { sha: treeSha } });
    if (git === `trees/${treeSha}`)
      return Response.json({
        sha: treeSha,
        truncated: false,
        tree: treeEntries,
      });
    const blob = git?.startsWith("blobs/")
      ? gitObjects.get(git.slice(6))
      : undefined;
    if (blob && git)
      return Response.json({
        sha: git.slice(6),
        encoding: "base64",
        size: blob.body.length,
        content: blob.body.toString("base64"),
      });
    return new Response(null, { status: 404 });
  }
  const request = new Request(`${ORIGIN}${path}${url.search}`, incoming);
  if (path === "/skill-templates/index.json")
    return Response.json({
      schemaVersion: "1",
      repository: "example/templates",
      commit: commitSha,
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
  if (path.startsWith("/skill-templates/")) return new Response(templateText);
  if (path.startsWith("/api/v1/vetting/evidence/"))
    return (
      (await retained.evidence.handle(request)) ??
      new Response(null, { status: 404 })
    );
  if (path.startsWith("/api/v1/vetting/"))
    return (
      (await handleVettingApi(request, {
        evidence: retained.evidence,
        vetting,
        projects,
        resultPublicKeys,
        livePin: readLivePin,
        session: async () => null,
        now: () => NOW,
        randomId,
      })) ?? new Response(null, { status: 404 })
    );
  return (await projectApi(request)) ?? new Response(null, { status: 404 });
}

const profile = (
  transport: ScannerProfile["transport"],
  reviewer: ScannerProfile["reviewer"],
  model: string,
): ScannerProfile => ({
  reviewer,
  transport,
  endpoint:
    transport === "anthropic-messages"
      ? "https://api.surplusintelligence.ai/anthropic/v1/messages"
      : "https://api.surplusintelligence.ai/openai/v1/responses",
  model,
  apiKey: "fixture-surplus-key",
  maxOutputTokens: 1024,
  rateCard: {
    uncachedInputNanoUsdPerToken: "3",
    cachedInputNanoUsdPerToken: "1",
    cacheCreationNanoUsdPerToken: "4",
    outputNanoUsdPerToken: "9",
  },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slop-scan-service-"));
  await gitFixture();
  const database = sqliteD1(
    readdirSync(new URL("../migrations", import.meta.url))
      .filter((name) => name.endsWith(".sql"))
      .sort(),
  );
  projects = new CloudflareProjectPersistence(database.db);
  retained = await localVettingEvidence(database.db, () => NOW);
  vetting = new CloudflareVettingPersistence(
    database.db,
    async (a) => a.result !== null && retained.evidence.retained(a.result),
  );
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  resultPublicKeys = Buffer.from(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  ).toString("base64");
  // The evidence store verifies this service's own key.
  retained.evidence.deps.signed = (request, maximum) =>
    signedVettingRequest(
      request,
      { resultPublicKeys, now: () => NOW },
      maximum,
    );
  provider = {
    up: true,
    specialistUp: true,
    primary: "no-findings",
    calls: [],
  };
  server = Bun.serve({ port: 0, fetch: route });
  config = {
    connection: {
      origin: ORIGIN,
      ...pair,
      now: () => NOW,
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        return fetch(
          `http://localhost:${server.port}${url.pathname}${url.search}`,
          {
            ...init,
            headers: { ...(init?.headers ?? {}), "x-fixture-host": url.host },
          },
        );
      }) as typeof fetch,
    },
    primary: profile("anthropic-messages", "opus", "claude-opus-5.5"),
    specialist: profile("openai-responses", "astra", "gpt-6.1-sol"),
    policyVersion: "scan-policy-1",
    workDirectory: join(root, "work"),
    journalDirectory: join(root, "journal"),
    randomId,
  };
  const created = await projectApi(
    new Request(`${ORIGIN}/api/v1/projects`, {
      method: "POST",
      headers: {
        "x-test-actor": "applicant",
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({
        manifest: applicationManifest("open-registry", "example/open-registry"),
      }),
    }),
  );
  expect(created.status).toBe(201);
});
afterEach(async () => {
  server.stop(true);
  await retained?.dispose();
  await rm(root, { recursive: true, force: true });
});

async function activate() {
  const project = await projects.getProject("open-registry");
  return projectApi(
    new Request(`${ORIGIN}/api/v1/admin/projects/open-registry/manifest`, {
      method: "PUT",
      headers: {
        "x-test-actor": "admin",
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({
        manifest: { ...project?.manifest, status: "active" },
        expectedRevision: project?.revision,
        reason: "Activate the scanned revision",
      }),
    }),
  );
}

test("a provider outage leaves the scan pending; the next pass clears the project with one Surplus review", async () => {
  provider.up = false;
  const failed = await runScanPass(config);
  expect(failed.refreshed).toBe(true);
  expect(failed.assessments).toHaveLength(1);
  const [{ assessmentId }] = failed.assessments;
  expect(failed.assessments[0]).toEqual({
    assessmentId,
    state: "retry",
    step: "primary-review",
  });
  expect((await vetting.getAssessment(assessmentId))?.state).toBe("pending");
  expect(await readdir(config.journalDirectory)).toEqual([]);
  expect(await readdir(config.workDirectory)).toEqual([]);
  const refused = await activate();
  expect(refused.status).toBe(422);
  expect((await refused.json()).error).toBe("vetting_required");

  provider.up = true;
  provider.calls = [];
  const passed = await runScanPass(config);
  expect(passed.assessments).toEqual([
    {
      assessmentId,
      state: "published",
      disposition: "clean",
      outcome: "accepted",
      specialist: false,
    },
  ]);
  // One primary review through Surplus with the account key; no specialist.
  expect(provider.calls).toEqual([
    {
      path: "/anthropic/v1/messages",
      model: "claude-opus-5.5",
      authorization: "Bearer fixture-surplus-key",
    },
  ]);
  const assessment = await vetting.getAssessment(assessmentId);
  expect(assessment?.state).toBe("clean");
  expect(assessment?.commitSha).toBe(commitSha);
  expect((await activate()).status).toBe(200);
  // The queue is empty and the journal keeps the one attempt.
  expect((await runScanPass(config)).assessments).toEqual([]);
  expect(await readdir(config.journalDirectory)).toEqual([assessmentId]);
});

test("an ambiguous primary review runs the Surplus specialist once before publication", async () => {
  provider.primary = "findings";
  const report = await runScanPass(config);
  const [{ assessmentId }] = report.assessments;
  expect(report.assessments).toEqual([
    {
      assessmentId,
      state: "published",
      disposition: "clean",
      outcome: "accepted",
      specialist: true,
    },
  ]);
  expect(provider.calls.map((call) => [call.path, call.model])).toEqual([
    ["/anthropic/v1/messages", "claude-opus-5.5"],
    ["/openai/v1/responses", "gpt-6.1-sol"],
  ]);
  const assessment = await vetting.getAssessment(assessmentId);
  expect(assessment?.state).toBe("clean");
});

test("a failed specialist is a service failure: nothing is published and the scan retries", async () => {
  provider.primary = "findings";
  provider.specialistUp = false;
  const report = await runScanPass(config);
  const [{ assessmentId }] = report.assessments;
  expect(report.assessments[0]).toEqual({
    assessmentId,
    state: "retry",
    step: "specialist-review",
  });
  expect(provider.calls.map((call) => call.path)).toEqual([
    "/anthropic/v1/messages",
    "/openai/v1/responses",
  ]);
  expect((await vetting.getAssessment(assessmentId))?.state).toBe("pending");
  expect(await readdir(config.journalDirectory)).toEqual([]);
});
