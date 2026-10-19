// The D1 project registry API on the real migration: cached public reads,
// purge on admin writes, server-verified reward assets, the generated-skill
// activation gate, and same-origin GitHub lookups.
import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CloudflareProjectPersistence } from "../backend/projects/cloudflare-persistence";
import type { EdgeCache } from "../backend/projects/edge-cache";
import {
  handleProjectApi,
  type ProjectApiDependencies,
} from "../backend/projects/handler";
import { handleProjectArtifactRequest } from "../backend/projects/skill-publication";
import { TokenMetadataError } from "../backend/projects/token-metadata";
import {
  CONTRIBUTOR_TEMPLATE_PATH,
  REVIEWER_TEMPLATE_PATH,
  SKILL_KIT_FILES,
  SKILL_KIT_PATH,
  type SkillTemplateIndex,
  sha256Hex,
} from "../src/lib/project-skill-render.mjs";
import {
  applicationManifest,
  SKILL_CONTENT,
} from "../tests/project-application-manifest";
import { sqliteD1 } from "../tests/sqlite-d1";

const ORIGIN = "https://slop.cash";
const ADMIN = { githubId: "900000001", githubLogin: "e2e-admin" };
const APPLICANT = { githubId: "900000002", githubLogin: "e2e-applicant" };
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
let cache: MemoryCache;
let tokenReads: string[];
let githubReads: string[];
let deps: ProjectApiDependencies;

beforeEach(() => {
  persistence = new CloudflareProjectPersistence(
    sqliteD1(["0019_project_registry.sql"]).db,
  );
  cache = new MemoryCache();
  tokenReads = [];
  githubReads = [];
  let id = 0;
  deps = {
    persistence,
    adminGithubIds: new Set([ADMIN.githubId]),
    now: () => new Date("2026-10-18T12:00:00.000Z"),
    randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    sessionActor: async (request) =>
      request.headers.get("x-test-actor") === "admin"
        ? ADMIN
        : request.headers.get("x-test-actor") === "applicant"
          ? APPLICANT
          : null,
    notifyAdmins: async () => true,
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
  actor?: "admin" | "applicant",
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
    acceptanceCriteria: "Merged pull requests with tests.",
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
    expect(Object.keys(body).sort()).toEqual(["projects", "schemaVersion"]);
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
        acceptanceCriteria: "Merged pull requests with tests.",
      });
      expect(response.status).toBe(422);
      expect((await response.json()).error).toBe(error);
    }
    expect(await persistence.listApplications("pending")).toEqual([]);
  });

  test("activates only a project with complete skill content", async () => {
    const { skillContent: _content, ...withoutSkill } = applicationManifest(
      "open-registry",
      "example/open-registry",
    );
    await listProject(withoutSkill);
    const current = await persistence.getProject("open-registry");
    const activate = (manifest: unknown, expectedRevision: number) =>
      call("PUT", "admin/projects/open-registry/manifest", "admin", {
        manifest,
        expectedRevision,
        reason: "Activate",
      });
    const refused = await activate(
      { ...current?.manifest, status: "active" },
      1,
    );
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toBe("skill_content_incomplete");
    const accepted = await activate(
      { ...current?.manifest, status: "active", skillContent: SKILL_CONTENT },
      1,
    );
    expect(accepted.status).toBe(200);
    expect((await persistence.getProject("open-registry"))?.status).toBe(
      "active",
    );
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

describe("generated skill publication", () => {
  test("serves skills from the current revision and refuses unpublished ones", async () => {
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
        CONTRIBUTOR_TEMPLATE_PATH,
        files(CONTRIBUTOR_TEMPLATE_PATH),
      ),
      reviewer: await group(
        REVIEWER_TEMPLATE_PATH,
        files(REVIEWER_TEMPLATE_PATH),
      ),
      scripts: await group(SKILL_KIT_PATH, [...SKILL_KIT_FILES]),
    };
    const publication = {
      getProject: (id: string) => persistence.getProject(id),
      listProjects: () => persistence.listProjects(),
      loadTemplate: async () => ({
        index,
        readFile: async (path: string) =>
          new Uint8Array(readFileSync(join(root, path))),
      }),
      publicOrigin: ORIGIN,
      cache,
    };
    const get = (path: string) =>
      handleProjectArtifactRequest(
        new Request(`${ORIGIN}${path}`),
        publication,
      ) as Promise<Response>;
    expect(
      await handleProjectArtifactRequest(
        new Request(`${ORIGIN}/projects/open-registry`),
        publication,
      ),
    ).toBeNull();
    expect((await get("/projects/open-registry/SKILL.md")).status).toBe(404);

    await listProject();
    const skill = await get("/projects/open-registry/SKILL.md");
    expect(skill.status).toBe(200);
    expect(skill.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    const text = await skill.text();
    expect(text).toContain("name: contribute-to-open-registry");
    expect(text).toContain('project-revision: "1"');
    const manifest = await (
      await get("/projects/open-registry/skill-manifest.json")
    ).json();
    const archive = await get(new URL(manifest.archive.url).pathname);
    expect(archive.headers.get("content-disposition")).toBe(
      'attachment; filename="contribute-to-open-registry.skill"',
    );
    expect(await sha256Hex(new Uint8Array(await archive.arrayBuffer()))).toBe(
      manifest.archive.sha256,
    );
    const discovery = await (
      await get("/.well-known/slop/projects.json")
    ).json();
    expect(discovery.projects).toMatchObject([
      {
        project_id: "open-registry",
        repository: "example/open-registry",
        skill_url: `${ORIGIN}/projects/open-registry/SKILL.md`,
        project_revision: 1,
      },
    ]);

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
      await (await get("/projects/open-registry/SKILL.md")).text(),
    ).toContain('project-revision: "2"');
    const review = await get("/projects/open-registry/review/SKILL.md");
    expect(await review.text()).toContain(
      "name: review-open-registry-contributions",
    );
  });
});
