// The D1 project registry API on the real migrations: cached public reads,
// purge on admin writes, server-verified reward assets, the GitHub ownership
// check, submission limits, exact revision bytes, the generated-skill
// activation gate, same-origin GitHub lookups, and ADM-06 enforcement.
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CloudflareProjectPersistence } from "../backend/projects/cloudflare-persistence";
import type { RepositoryControl } from "../backend/projects/contracts";
import type { EdgeCache } from "../backend/projects/edge-cache";
import {
  handleProjectApi,
  type ProjectApiDependencies,
} from "../backend/projects/handler";
import type { SkillTemplateIndex } from "../backend/projects/skill-publication";
import { handleProjectArtifactRequest } from "../backend/projects/skill-publication";
import { TokenMetadataError } from "../backend/projects/token-metadata";
import { PROJECT_SKILL_TEMPLATES } from "../src/lib/project-schema.mjs";
import { sha256Hex } from "../src/lib/project-skill-publication.mjs";
import {
  applicationManifest,
  CONTRIBUTION,
} from "../tests/project-application-manifest";
import { sqliteD1 } from "../tests/sqlite-d1";

const ORIGIN = "https://slop.cash";
const ADMIN = { githubId: "900000001", githubLogin: "e2e-admin" };
const APPLICANT = { githubId: "900000002", githubLogin: "e2e-applicant" };
const MODERATOR = { githubId: "900000003", githubLogin: "e2e-moderator" };
const TOKEN = "0x1111111111111111111111111111111111111111";

class MemoryCache implements EdgeCache {
  readonly entries = new Map<string, Response>();
  async match(request: Request) {
    return this.entries.get(request.url)?.clone();
  }
  async put(request: Request, response: Response) {
    this.entries.set(request.url, response.clone());
  }
  async delete(request: Request) {
    return this.entries.delete(request.url);
  }
}

let persistence: CloudflareProjectPersistence;
let sqlite: Database;
let cache: MemoryCache;
let tokenReads: string[];
let githubReads: string[];
let deps: ProjectApiDependencies;
/** GitHub's answer for the ownership check, by repository. */
let control: (repository: string) => RepositoryControl;

beforeEach(() => {
  const database = sqliteD1([
    "0019_project_registry.sql",
    "0020_project_application_github_check.sql",
    "0023_project_enforcements.sql",
    "0024_notifications.sql",
  ]);
  sqlite = database.sqlite;
  persistence = new CloudflareProjectPersistence(database.db);
  cache = new MemoryCache();
  tokenReads = [];
  githubReads = [];
  control = () => ({
    state: "unproven",
    reason: "@e2e-applicant is not a public member of example",
  });
  let id = 0;
  deps = {
    persistence,
    adminGithubIds: new Set([ADMIN.githubId, MODERATOR.githubId]),
    moderatorGithubIds: new Set([ADMIN.githubId, MODERATOR.githubId]),
    now: () => new Date("2026-10-18T12:00:00.000Z"),
    randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    sessionActor: async (request) =>
      request.headers.get("x-test-actor") === "admin"
        ? ADMIN
        : request.headers.get("x-test-actor") === "applicant"
          ? APPLICANT
          : request.headers.get("x-test-actor") === "moderator"
            ? MODERATOR
            : null,
    notifyAdmins: async () => true,
    repositoryControl: async (manifest) => control(manifest.repositories[0].id),
    readTokenMetadata: async (network, address) => {
      tokenReads.push(`${network}:${address}`);
      if (address === TOKEN) return { decimals: 18, symbol: "OPEN" };
      throw new TokenMetadataError("No contract exists at that token address");
    },
    github: {
      fetch: async (url) => {
        githubReads.push(url);
        if (url === "https://api.github.com/repos/example/open-registry")
          return Response.json({
            id: 123456789,
            node_id: "R_example",
            full_name: "example/open-registry",
            description: "Reproducible research tooling for everyone.",
            private: false,
            default_branch: "main",
            owner: {
              login: "example",
              id: 987654321,
              node_id: "O_example",
              type: "Organization",
            },
          });
        return Response.json({ message: "Not Found" }, { status: 404 });
      },
    },
    cache,
  };
});

function call(
  method: string,
  path: string,
  actor?: "admin" | "applicant" | "moderator",
  body?: unknown,
) {
  return handleProjectApi(
    new Request(`${ORIGIN}/api/v1/${path}`, {
      method,
      headers: {
        ...(actor ? { "x-test-actor": actor } : {}),
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", origin: ORIGIN }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    deps,
  ) as Promise<Response>;
}

async function listProject(
  manifest = applicationManifest("open-registry", "example/open-registry"),
) {
  const submitted = await call("POST", "project-applications", "applicant", {
    manifest,
  });
  expect(submitted.status).toBe(201);
  const { application } = await submitted.json();
  const approved = await call(
    "POST",
    `admin/project-applications/${application.id}/approve`,
    "admin",
    {},
  );
  expect(approved.status).toBe(200);
  return application;
}

describe("project registry API", () => {
  test("serves a newly approved project at once, purging the cached list", async () => {
    const empty = await call("GET", "projects");
    expect((await empty.json()).projects).toEqual([]);
    expect((await call("GET", "projects")).headers.get("x-slop-cache")).toBe(
      "hit",
    );
    await listProject();
    const listed = await call("GET", "projects");
    expect(listed.headers.get("x-slop-cache")).toBe("miss");
    expect(listed.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=30",
    );
    const body = await listed.json();
    expect(body.projects.map((project: { id: string }) => project.id)).toEqual([
      "open-registry",
    ]);
    expect(Object.keys(body).sort()).toEqual([
      "projects",
      "restrictions",
      "schemaVersion",
    ]);
    expect(body.restrictions).toEqual([]);
    const single = await call("GET", "projects/open-registry");
    expect(single.status).toBe(200);
    expect(await single.json()).toMatchObject({
      revision: 1,
      skillsPublished: true,
      project: { id: "open-registry", status: "paused" },
    });
    expect((await call("GET", "projects/missing")).status).toBe(404);
  });

  test("reads token decimals from chain once and keeps them on later revisions", async () => {
    await listProject(
      applicationManifest("open-registry", "example/open-registry", {
        rewardAsset: {
          network: "base",
          kind: "token",
          address: TOKEN.toUpperCase().replace("0X", "0x"),
          symbol: "OPN",
          decimals: 0,
        },
        reward: {
          ...(applicationManifest("x", "a/b").reward as object),
          chain: "base",
          currency: "OPN",
        },
      }),
    );
    expect(tokenReads).toEqual([`base:${TOKEN}`]);
    const project = await persistence.getProject("open-registry");
    expect(project?.manifest.rewardAsset).toEqual({
      network: "base",
      kind: "token",
      address: TOKEN,
      symbol: "OPEN",
      decimals: 18,
      chainId: "8453",
      cluster: null,
      verifiedAt: "2026-10-18T12:00:00.000Z",
    });
    expect(project?.manifest.reward.currency).toBe("OPEN");
    const revised = await call(
      "PUT",
      "admin/projects/open-registry/manifest",
      "admin",
      {
        manifest: {
          ...project?.manifest,
          rewardAsset: { ...project?.manifest.rewardAsset, decimals: 2 },
          headline: "Reproducible research tooling, revised.",
        },
        expectedRevision: 1,
        reason: "Headline update",
      },
    );
    expect(revised.status).toBe(200);
    expect(tokenReads).toHaveLength(1);
    expect(
      (await persistence.getProject("open-registry"))?.manifest.rewardAsset
        ?.decimals,
    ).toBe(18);
  });

  test("refuses an unverifiable or malformed token and stores nothing", async () => {
    const base = applicationManifest("open-registry", "example/open-registry");
    for (const [address, error] of [
      ["0x2222222222222222222222222222222222222222", "reward_asset_unverified"],
      ["0x1234", "invalid_manifest"],
    ]) {
      const response = await call("POST", "project-applications", "applicant", {
        manifest: {
          ...base,
          rewardAsset: {
            network: "ethereum",
            kind: "token",
            address,
            symbol: "BAD",
          },
        },
      });
      expect(response.status).toBe(422);
      expect((await response.json()).error).toBe(error);
    }
    expect(await persistence.listApplications("pending")).toEqual([]);
  });

  test("activates only a project whose generated skills have their fields", async () => {
    await listProject();
    const current = await persistence.getProject("open-registry");
    const activate = (manifest: unknown) =>
      call("PUT", "admin/projects/open-registry/manifest", "admin", {
        manifest,
        expectedRevision: 1,
        reason: "Activate",
      });
    // Without the contribution fields the project has no generated skill.
    if (current === null) throw new Error("project was not listed");
    const { contribution: _fields, ...withoutFields } =
      current.manifest as unknown as Record<string, unknown>;
    const refused = await activate({ ...withoutFields, status: "active" });
    expect(refused.status).toBe(422);
    expect((await persistence.getProject("open-registry"))?.status).toBe(
      "paused",
    );
    const accepted = await activate({
      ...current?.manifest,
      status: "active",
      contribution: CONTRIBUTION,
    });
    expect(accepted.status).toBe(200);
    expect((await persistence.getProject("open-registry"))?.status).toBe(
      "active",
    );
  });

  test("records the GitHub ownership check and refuses contradicted facts", async () => {
    control = () => ({
      state: "mismatch",
      reason: "Repository or steward facts do not match GitHub",
    });
    const refused = await call("POST", "project-applications", "applicant", {
      manifest: applicationManifest("open-registry", "example/open-registry"),
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: "invalid_manifest",
      message: "Repository or steward facts do not match GitHub",
    });
    expect(await persistence.listApplications("pending")).toEqual([]);

    control = () => ({
      state: "proven",
      reason: "@e2e-applicant owns example/open-registry",
    });
    const accepted = await call("POST", "project-applications", "applicant", {
      manifest: applicationManifest("open-registry", "example/open-registry"),
    });
    expect(accepted.status).toBe(201);
    expect((await accepted.json()).application).toMatchObject({
      githubCheck: "Proven: @e2e-applicant owns example/open-registry",
      status: "pending",
    });
  });

  test("limits one account to five submissions a day", async () => {
    for (let index = 0; index < 5; index += 1) {
      const response = await call("POST", "project-applications", "applicant", {
        manifest: applicationManifest(
          `daily-${index}`,
          `example/daily-${index}`,
        ),
      });
      expect(response.status).toBe(201);
      // Rejections keep the pending queue small; the daily count stays.
      const { application } = await response.json();
      await call(
        "POST",
        `admin/project-applications/${application.id}/reject`,
        "admin",
        { reason: "Test rejection" },
      );
    }
    const sixth = await call("POST", "project-applications", "applicant", {
      manifest: applicationManifest("daily-5", "example/daily-5"),
    });
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).error).toBe("too_many_submissions");
  });

  test("serves the exact approved bytes of a revision", async () => {
    await listProject();
    const response = await call("GET", "project-revisions/open-registry/1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(await sha256Hex(body.manifestText)).toBe(body.manifestSha256);
    expect(JSON.parse(body.manifestText)).toMatchObject({
      id: "open-registry",
      contribution: CONTRIBUTION,
    });
    expect(
      (await call("GET", "project-revisions/open-registry/2")).status,
    ).toBe(404);
  });

  test("looks up GitHub only for a signed-in visitor and caches the facts", async () => {
    expect(
      (await call("GET", "project-github/repositories/example/open-registry"))
        .status,
    ).toBe(401);
    const first = await call(
      "GET",
      "project-github/repositories/example/open-registry",
      "applicant",
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, max-age=300");
    expect((await first.json()).repository).toMatchObject({
      repository: "example/open-registry",
      numericId: "123456789",
      license: { state: "unknown" },
    });
    const reads = githubReads.length;
    const second = await call(
      "GET",
      "project-github/repositories/example/open-registry",
      "applicant",
    );
    expect(second.headers.get("x-slop-cache")).toBe("hit");
    expect(githubReads).toHaveLength(reads);
    const missing = await call(
      "GET",
      "project-github/repositories/example/missing",
      "applicant",
    );
    expect(missing.status).toBe(404);
  });
});

function files(path: string): string[] {
  const absolute = join(resolve(import.meta.dir, ".."), path);
  return readdirSync(absolute, { recursive: true })
    .map(String)
    .filter((entry) => statSync(join(absolute, entry)).isFile())
    .map((entry) => relative(absolute, join(absolute, entry)))
    .sort();
}

/** Serves project artifacts from this test's D1 and the real templates. */
async function publicationRequests() {
  const root = resolve(import.meta.dir, "..");
  const group = async (sourcePath: string, paths: string[]) => ({
    sourcePath,
    files: await Promise.all(
      paths.map(async (path) => ({
        path,
        sha256: await sha256Hex(readFileSync(join(root, sourcePath, path))),
      })),
    ),
  });
  const index: SkillTemplateIndex = {
    schemaVersion: "1",
    repository: "SlopDotCash/slopdotcash",
    commit: "d".repeat(40),
    revisionStatus: "committed",
    contributor: await group(
      PROJECT_SKILL_TEMPLATES.contributor,
      files(PROJECT_SKILL_TEMPLATES.contributor),
    ),
    reviewer: await group(
      PROJECT_SKILL_TEMPLATES.reviewer,
      files(PROJECT_SKILL_TEMPLATES.reviewer),
    ),
    renderer: {
      paths: ["scripts/render-install-guide.mjs"],
      revisionStatus: "committed",
    },
    acceptedRevisions: ["current main head"],
  };
  const publication = {
    getProject: (id: string) => persistence.getProject(id),
    listProjects: () => persistence.listProjects(),
    listEnforcements: () => persistence.listEnforcements(),
    enforcementGeneration: () => persistence.enforcementGeneration(),
    loadTemplate: async () => ({
      index,
      readFile: async (path: string) =>
        new Uint8Array(readFileSync(join(root, path))),
    }),
    cache,
  };
  const get = (path: string) =>
    handleProjectArtifactRequest(
      new Request(`${ORIGIN}${path}`),
      publication,
    ) as Promise<Response>;
  return { publication, get };
}

describe("generated skill publication", () => {
  test("serves skills from the current revision and refuses unpublished ones", async () => {
    const { publication, get } = await publicationRequests();
    expect(
      await handleProjectArtifactRequest(
        new Request(`${ORIGIN}/projects/open-registry`),
        publication,
      ),
    ).toBeNull();
    expect((await get("/projects/open-registry/skill.md")).status).toBe(404);

    await listProject();
    const skill = await get("/projects/open-registry/skill.md");
    expect(skill.status).toBe(200);
    expect(skill.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    const text = await skill.text();
    expect(text).toContain("name: contribute-to-open-registry");
    // Maintainer text stays data in project.json, never in SKILL.md.
    expect(text).not.toContain(CONTRIBUTION.approvedScope);
    expect(await (await get("/projects/open-registry/SKILL.md")).text()).toBe(
      text,
    );
    const manifest = await (
      await get("/projects/open-registry/skill-manifest.json")
    ).json();
    expect(manifest.authority.registry).toMatchObject({
      projectId: "open-registry",
      revision: 1,
      url: "https://slop.cash/api/v1/project-revisions/open-registry/1",
    });
    expect(manifest.guides.codex.renderer.arguments).toContain(
      "skills/project-contributor-template",
    );
    const archive = await get(new URL(manifest.archive.url).pathname);
    expect(archive.headers.get("content-disposition")).toBe("attachment");
    expect(await sha256Hex(new Uint8Array(await archive.arrayBuffer()))).toBe(
      manifest.archive.sha256,
    );
    const discovery = await (
      await get("/.well-known/slop/projects.json")
    ).json();
    expect(discovery).toMatchObject({
      schemaVersion: "1",
      projects: [
        {
          project_id: "open-registry",
          repository: "example/open-registry",
          skill: "contribute-to-open-registry",
          skill_source: "skills/project-contributor-template",
        },
      ],
    });

    // An admin revision purges the cached skill, so the next read names it.
    const current = await persistence.getProject("open-registry");
    const revised = await call(
      "PUT",
      "admin/projects/open-registry/manifest",
      "admin",
      {
        manifest: {
          ...current?.manifest,
          headline: "Reproducible tooling, second revision.",
        },
        expectedRevision: 1,
        reason: "Second revision",
      },
    );
    expect(revised.status).toBe(200);
    expect(
      (await (await get("/projects/open-registry/skill-manifest.json")).json())
        .authority.registry.revision,
    ).toBe(2);
    const review = await get("/projects/open-registry/review/SKILL.md");
    expect(await review.text()).toContain(
      "name: review-open-registry-contributions",
    );
  });
});

describe("project enforcement (ADM-06)", () => {
  const EVIDENCE =
    "https://github.com/example/open-registry/security/advisories/GHSA-test";

  async function enforce(
    actor: "admin" | "moderator",
    action: string,
    mode: "enforcement" | "enforcement-preview" = "enforcement",
  ) {
    const project = await persistence.getProject("open-registry");
    const records = await persistence.listEnforcements();
    return call("POST", `admin/projects/open-registry/${mode}`, actor, {
      action,
      reason: `Moderator note for ${action}`,
      evidenceReference: EVIDENCE,
      expectedRevision: project?.revision,
      expectedSequence: records.length + 1,
    });
  }

  test("quarantines, bans and reinstates through independent review", async () => {
    const { get } = await publicationRequests();
    await listProject();
    const listed = await persistence.getProject("open-registry");
    const activated = await call(
      "PUT",
      "admin/projects/open-registry/manifest",
      "admin",
      {
        manifest: {
          ...listed?.manifest,
          status: "active",
          listingTier: "featured",
        },
        expectedRevision: 1,
        reason: "Activate and feature",
      },
    );
    expect(activated.status).toBe(200);
    // Warm every public cache before the restriction.
    expect((await call("GET", "projects")).status).toBe(200);
    expect((await call("GET", "projects")).headers.get("x-slop-cache")).toBe(
      "hit",
    );
    expect((await get("/projects/open-registry/SKILL.md")).status).toBe(200);
    expect(
      (await (await get("/.well-known/slop/projects.json")).json()).projects,
    ).toHaveLength(1);

    // Without a configured moderator role the actions stay closed.
    deps.moderatorGithubIds = new Set();
    const closed = await enforce("admin", "quarantine");
    expect(closed.status).toBe(403);
    expect((await closed.json()).error).toBe("moderation_unavailable");
    deps.moderatorGithubIds = new Set([ADMIN.githubId, MODERATOR.githubId]);

    // The preview shows the exact revision and writes nothing.
    const preview = await enforce("admin", "quarantine", "enforcement-preview");
    expect(preview.status).toBe(200);
    expect((await preview.json()).preview).toMatchObject({
      stateBefore: "clear",
      stateAfter: "quarantined",
      result: "revision_appended",
      revision: {
        before: 2,
        after: 3,
        statusBefore: "active",
        statusAfter: "paused",
        listingTierBefore: "featured",
        listingTierAfter: "retired",
      },
    });
    expect(await persistence.listEnforcements()).toEqual([]);

    const quarantined = await enforce("admin", "quarantine");
    expect(quarantined.status).toBe(200);
    expect((await quarantined.json()).record).toMatchObject({
      sequence: 1,
      action: "quarantine",
      actor: ADMIN,
      actorRole: "project-moderator",
      decisionSource: "admin-panel",
      evidenceReference: EVIDENCE,
      repositoryGithubId: "123456789",
      repositoryKeys: ["example/open-registry"],
      beforeRevision: 2,
      afterRevision: 3,
      result: "revision_appended",
    });
    const revision = await persistence.getProject("open-registry");
    expect(revision).toMatchObject({ revision: 3, status: "paused" });
    expect(revision?.manifest.listingTier).toBe("retired");
    // The warm caches cannot serve the project after the record lands.
    const list = await call("GET", "projects");
    expect(list.headers.get("x-slop-cache")).toBe("miss");
    expect((await list.json()).restrictions).toMatchObject([
      { projectId: "open-registry", state: "quarantined", appeal: "none" },
    ]);
    const single = await call("GET", "projects/open-registry");
    expect(single.status).toBe(410);
    expect((await single.json()).restriction.state).toBe("quarantined");
    expect((await get("/projects/open-registry/SKILL.md")).status).toBe(410);
    expect(
      (
        await get(
          "/projects/open-registry/downloads/contribute-to-open-registry.skill",
        )
      ).status,
    ).toBe(410);
    expect(
      (await (await get("/.well-known/slop/projects.json")).json()).projects,
    ).toEqual([]);

    // A revision cannot lift the restriction.
    const lifted = await call(
      "PUT",
      "admin/projects/open-registry/manifest",
      "admin",
      {
        manifest: { ...revision?.manifest, listingTier: "community" },
        expectedRevision: 3,
        reason: "Try to relist",
      },
    );
    expect(lifted.status).toBe(409);
    expect((await lifted.json()).error).toBe("project_restricted");
    // Neither can a new application for the renamed repository.
    const renamed = await call("POST", "project-applications", "applicant", {
      manifest: applicationManifest(
        "renamed-registry",
        "example/renamed-registry",
      ),
    });
    expect(renamed.status).toBe(403);
    expect((await renamed.json()).error).toBe("repository_restricted");

    // Escalation to a ban needs no second revision.
    const banned = await enforce("admin", "ban");
    expect(banned.status).toBe(200);
    expect((await banned.json()).record).toMatchObject({
      stateAfter: "banned",
      result: "no_revision_needed",
      afterRevision: null,
    });
    const early = await enforce("moderator", "reinstate");
    expect(early.status).toBe(409);
    expect((await early.json()).error).toBe("no_open_appeal");
    expect((await enforce("admin", "request_reinstatement")).status).toBe(200);
    // The moderator who banned cannot decide the appeal.
    const self = await enforce("admin", "reinstate");
    expect(self.status).toBe(403);
    expect((await self.json()).error).toBe("independent_review_required");
    const reinstated = await enforce("moderator", "reinstate");
    expect(reinstated.status).toBe(200);
    expect((await reinstated.json()).record).toMatchObject({
      actor: MODERATOR,
      stateAfter: "clear",
      appealAfter: "granted",
      afterRevision: 4,
    });
    // Reinstatement restores the community tier only, still paused.
    const restored = await persistence.getProject("open-registry");
    expect(restored).toMatchObject({ revision: 4, status: "paused" });
    expect(restored?.manifest.listingTier).toBe("community");
    expect((await call("GET", "projects/open-registry")).status).toBe(200);
    expect((await (await call("GET", "projects")).json()).restrictions).toEqual(
      [],
    );
    expect((await get("/projects/open-registry/SKILL.md")).status).toBe(200);

    // A stale preview cannot be confirmed, and history is append-only.
    const stale = await call(
      "POST",
      "admin/projects/open-registry/enforcement",
      "moderator",
      {
        action: "quarantine",
        reason: "Stale",
        evidenceReference: EVIDENCE,
        expectedRevision: 4,
        expectedSequence: 1,
      },
    );
    expect(stale.status).toBe(409);
    expect(() =>
      sqlite.exec("UPDATE project_enforcements SET reason = 'edited'"),
    ).toThrow("immutable");
    expect(() => sqlite.exec("DELETE FROM project_enforcements")).toThrow(
      "permanent",
    );
    const history = await call("GET", "admin/projects", "moderator");
    expect(
      (await history.json()).projects[0].enforcement.records.map(
        (record: { action: string }) => record.action,
      ),
    ).toEqual(["quarantine", "ban", "request_reinstatement", "reinstate"]);
  });
});
