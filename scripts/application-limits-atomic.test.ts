/**
 * The per-applicant limit (3 waiting) must hold under concurrent
 * submissions. A count followed by a separate insert lets one account pass
 * the limit many times in one burst and fill the admin queue.
 */
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { CloudflareProjectPersistence } from "../backend/projects/cloudflare-persistence";
import { MAX_PENDING_APPLICATIONS_PER_APPLICANT } from "../backend/projects/contracts";
import {
  handleProjectApi,
  type ProjectApiDependencies,
} from "../backend/projects/handler";
import { TokenMetadataError } from "../backend/projects/token-metadata";
import { applicationManifest } from "../tests/project-application-manifest";
import { sqliteD1 } from "../tests/sqlite-d1";

const ADMIN = "900000001";
const APPLICANT = "900000002";

function registry() {
  const { db, sqlite } = sqliteD1(
    readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => name.endsWith(".sql"))
      .sort(),
  );
  let sequence = 0;
  const deps: ProjectApiDependencies = {
    persistence: new CloudflareProjectPersistence(db),
    adminGithubIds: new Set([ADMIN]),
    moderatorGithubIds: new Set(),
    vettingClearance: async () => {
      throw new Error("Paused submission must not request activation");
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
  const submit = (index: number) =>
    call("POST", "project-applications", APPLICANT, {
      manifest: applicationManifest(`burst-${index}`, `example/burst-${index}`),
    });
  const pending = () =>
    (
      sqlite
        .query(
          "SELECT COUNT(*) AS count FROM project_applications WHERE applicant_github_id = ? AND status = 'pending'",
        )
        .get(APPLICANT) as { count: number }
    ).count;
  return { call, submit, pending };
}

test("a concurrent burst cannot exceed the waiting-application limit", async () => {
  const { submit, pending } = registry();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => submit(index)),
  );
  const statuses = results.map((result) => result.status).sort();
  expect(statuses).toEqual([201, 201, 201, 429, 429, 429, 429, 429]);
  expect(
    results
      .filter((result) => result.status === 429)
      .every((result) => result.body.error === "too_many_pending"),
  ).toBe(true);
  expect(pending()).toBe(MAX_PENDING_APPLICATIONS_PER_APPLICANT);
});

test("decided applications do not restore the removed daily cap", async () => {
  const { call, submit, pending } = registry();
  // Six decided applications today leave all three pending slots available.
  for (let index = 0; index < 6; index += 1) {
    const submitted = await submit(index);
    expect(submitted.status).toBe(201);
    const application = submitted.body.application as { id: string };
    const rejected = await call(
      "POST",
      `admin/project-applications/${application.id}/reject`,
      ADMIN,
      { reason: "Not this one." },
    );
    expect(rejected.status).toBe(200);
  }
  expect(pending()).toBe(0);
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) => submit(10 + index)),
  );
  expect(results.map((result) => result.status).sort()).toEqual([
    201, 201, 201, 429,
  ]);
  expect(
    results
      .filter((result) => result.status === 429)
      .every((result) => result.body.error === "too_many_pending"),
  ).toBe(true);
  expect(pending()).toBe(MAX_PENDING_APPLICATIONS_PER_APPLICANT);
});
