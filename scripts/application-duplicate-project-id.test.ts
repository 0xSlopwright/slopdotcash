/**
 * The registry uniqueness check runs at submission and at approval. A new
 * application must conflict with a listed project that already has its id;
 * only an admin manifest revision replaces the project with that id.
 */
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { CloudflareProjectPersistence } from "../backend/projects/cloudflare-persistence";
import {
  handleProjectApi,
  type ProjectApiDependencies,
} from "../backend/projects/handler";
import { TokenMetadataError } from "../backend/projects/token-metadata";
import { applicationManifest } from "../tests/project-application-manifest";
import { sqliteD1 } from "../tests/sqlite-d1";

const ADMIN = "900000001";

function registry() {
  const persistence = new CloudflareProjectPersistence(
    sqliteD1(
      readdirSync(new URL("../migrations/", import.meta.url))
        .filter((name) => name.endsWith(".sql"))
        .sort(),
    ).db,
  );
  let sequence = 0;
  const deps: ProjectApiDependencies = {
    persistence,
    adminGithubIds: new Set([ADMIN]),
    moderatorGithubIds: new Set(),
    vettingClearance: async () => {
      throw new Error("Paused admission must not activate a project");
    },
    now: () => new Date("2026-10-19T12:00:00.000Z"),
    randomId: () =>
      `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    sessionActor: async (request) => {
      const actor = request.headers.get("x-test-actor");
      return actor
        ? {
            githubId: actor,
            githubLogin: actor === ADMIN ? "admin" : "applicant",
          }
        : null;
    },
    notifyAdmins: async () => true,
    readTokenMetadata: async () => {
      throw new TokenMetadataError("No contract exists at that token address");
    },
    github: {
      fetch: async () =>
        Response.json({ message: "Not Found" }, { status: 404 }),
    },
    repositoryControl: async () => ({
      state: "unproven",
      reason: "GitHub could not be checked",
    }),
  };
  const call = async (
    method: string,
    path: string,
    actor: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await handleProjectApi(
      new Request(`https://slop.cash/api/v1/${path}`, {
        method,
        headers: {
          origin: "https://slop.cash",
          "content-type": "application/json",
          "x-test-actor": actor,
        },
        body: JSON.stringify(body),
      }),
      deps,
    );
    if (!response) throw new Error("project route was not handled");
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  const submit = (id: string, repository: string, actor = "900000002") =>
    call("POST", "project-applications", actor, {
      manifest: applicationManifest(id, repository),
    });
  const list = async (id: string, repository: string) => {
    const submitted = await submit(id, repository);
    expect(submitted.status).toBe(201);
    const application = submitted.body.application as { id: string };
    const approved = await call(
      "POST",
      `admin/project-applications/${application.id}/approve`,
      ADMIN,
      {},
    );
    expect(approved.status).toBe(200);
  };
  return { persistence, call, submit, list };
}

test("an application cannot reuse a listed project id", async () => {
  const { persistence, submit, list } = registry();
  await list("open-registry", "example/open-registry");
  const duplicate = await submit(
    "open-registry",
    "other/their-repo",
    "900000003",
  );
  expect(duplicate.status).toBe(409);
  expect(duplicate.body).toEqual({
    error: "registry_conflict",
    message: "project registry contains duplicate ids",
  });
  expect(await persistence.listApplications("pending")).toEqual([]);
});

test("an admin revision still replaces the listed project with that id", async () => {
  const { persistence, call, list } = registry();
  await list("open-registry", "example/open-registry");
  const current = await persistence.getProject("open-registry");
  if (!current) throw new Error("project was not listed");
  const revised = await call(
    "PUT",
    "admin/projects/open-registry/manifest",
    ADMIN,
    {
      manifest: {
        ...current.manifest,
        description: "Build and maintain reproducible research tooling.",
      },
      expectedRevision: 1,
      reason: "Shorten the description",
    },
  );
  expect(revised.status).toBe(200);
  expect((await persistence.getProject("open-registry"))?.revision).toBe(2);
});

test("an application cannot list a repository another pending application lists", async () => {
  const { persistence, call, submit } = registry();
  const first = await submit("alpha", "example/shared");
  expect(first.status).toBe(201);
  const base = applicationManifest("gamma", "example/gamma");
  const [primary] = base.repositories as Record<string, unknown>[];
  const second = await call("POST", "project-applications", "900000003", {
    manifest: {
      ...base,
      repositories: [
        primary,
        {
          ...primary,
          id: "example/shared",
          displayName: "example/shared",
          githubUrl: "https://github.com/example/shared",
        },
      ],
    },
  });
  expect(second.status).toBe(409);
  expect(second.body.error).toBe("application_exists");
  const pending = await persistence.listApplications("pending");
  expect(pending.map((application) => application.projectId)).toEqual([
    "alpha",
  ]);
});
