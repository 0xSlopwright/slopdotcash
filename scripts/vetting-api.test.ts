// Community security vetting (PRD VET-01 to VET-08) on the real migrations:
// the signed service contract, the clean, incomplete and malicious
// dispositions from harmless fixtures, the activation and skill gates, and
// the fail-closed state when no vetting service is configured.
import { beforeEach, describe, expect, test } from "bun:test";
import { CloudflareProjectPersistence } from "../backend/projects/cloudflare-persistence";
import { handleProjectApi } from "../backend/projects/handler";
import { handleVettingApi } from "../backend/vetting/handler";
import { CloudflareVettingPersistence } from "../backend/vetting/persistence";
import { applicationManifest } from "../tests/project-application-manifest";
import { sqliteD1 } from "../tests/sqlite-d1";
import {
  signedVettingHeaders,
  vettingKeyPair,
  vettingResult,
} from "../tests/vetting-fixtures";

const ORIGIN = "https://slop.cash";
const ADMIN = { githubId: "900000001", githubLogin: "e2e-admin" };
const APPLICANT = { githubId: "900000002", githubLogin: "e2e-applicant" };
const NOW = new Date("2026-10-18T12:00:00.000Z");

let projects: CloudflareProjectPersistence;
let vetting: CloudflareVettingPersistence;
let keys: Awaited<ReturnType<typeof vettingKeyPair>>;
let configuredKeys: string | undefined;
let ids = 0;

beforeEach(async () => {
  const { db } = sqliteD1([
    "0019_project_registry.sql",
    "0020_project_application_github_check.sql",
    "0025_community_security_vetting.sql",
  ]);
  projects = new CloudflareProjectPersistence(db);
  vetting = new CloudflareVettingPersistence(db);
  keys = await vettingKeyPair();
  configuredKeys = keys.publicKey;
});

const actorOf = (request: Request) =>
  request.headers.get("x-test-actor") === "admin"
    ? ADMIN
    : request.headers.get("x-test-actor") === "applicant"
      ? APPLICANT
      : null;

function projectApi(request: Request) {
  return handleProjectApi(request, {
    persistence: projects,
    adminGithubIds: new Set([ADMIN.githubId]),
    now: () => NOW,
    randomId: () =>
      `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    sessionActor: async (value) => actorOf(value),
    notifyAdmins: async () => true,
    repositoryControl: async () => ({ state: "proven", reason: "fixture" }),
    readTokenMetadata: async () => {
      throw new Error("no token reads in this suite");
    },
    github: { fetch: async () => new Response(null, { status: 404 }) },
    vettingClearance: (projectId, manifest, through) =>
      vetting.manifestClearance(projectId, manifest, through),
  }) as Promise<Response>;
}

function vettingApi(request: Request) {
  return handleVettingApi(request, {
    vetting,
    projects,
    resultPublicKeys: configuredKeys,
    session: async (value) => {
      const actor = actorOf(value);
      return actor && { ...actor, admin: actor === ADMIN };
    },
    now: () => NOW,
    randomId: () => `0000000000004000a000${String(++ids).padStart(12, "0")}`,
  }) as Promise<Response>;
}

function sessionRequest(
  method: string,
  path: string,
  actor: "admin" | "applicant",
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

async function signed(method: string, path: string, body = "", at = NOW) {
  return new Request(`${ORIGIN}/api/v1/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(await signedVettingHeaders(
        keys.privateKey,
        keys.raw,
        method,
        `/api/v1/${path}`,
        body,
        at,
      )),
    },
    body: method === "GET" ? undefined : body,
  });
}

async function listPausedProject() {
  const submitted = await projectApi(
    sessionRequest("POST", "project-applications", "applicant", {
      manifest: applicationManifest("open-registry", "example/open-registry"),
    }),
  );
  expect(submitted.status).toBe(201);
  const { application } = await submitted.json();
  expect(
    (
      await projectApi(
        sessionRequest(
          "POST",
          `admin/project-applications/${application.id}/approve`,
          "admin",
          {},
        ),
      )
    ).status,
  ).toBe(200);
}

async function queueScan(): Promise<string> {
  const queued = await vettingApi(
    sessionRequest("POST", "admin/vetting/assessments", "admin", {
      projectId: "open-registry",
      revision: 1,
      reason: "Admission scan",
    }),
  );
  expect(queued.status).toBe(201);
  return (await queued.json()).assessment.id;
}

async function postResult(body: unknown, at = NOW) {
  const text = JSON.stringify(body);
  return vettingApi(await signed("POST", "vetting/results", text, at));
}

async function fixture(
  assessmentId: string,
  disposition: "clean" | "incomplete" | "malicious",
) {
  const project = await projects.getProject("open-registry");
  if (project === null) throw new Error("project was not listed");
  return vettingResult(
    {
      assessmentId,
      projectId: project.id,
      revision: project.revision,
      manifestSha256: project.manifestSha256,
      repository: "example/open-registry",
    },
    disposition,
  );
}

async function activate(expectedRevision = 1) {
  const project = await projects.getProject("open-registry");
  return projectApi(
    sessionRequest("PUT", "admin/projects/open-registry/manifest", "admin", {
      manifest: { ...project?.manifest, status: "active" },
      expectedRevision,
      reason: "Activate the scanned revision",
    }),
  );
}

async function publicVetting() {
  return (
    await (
      await projectApi(new Request(`${ORIGIN}/api/v1/projects/open-registry`))
    ).json()
  ).vetting;
}

describe("community security vetting", () => {
  test("a clean signed result clears the exact revision for activation", async () => {
    await listPausedProject();
    expect(await publicVetting()).toEqual({ state: "unscanned" });
    expect((await activate()).status).toBe(422);
    const id = await queueScan();
    expect((await publicVetting()).state).toBe("queued");

    // The service reads its queue with a signed request.
    const queue = await vettingApi(await signed("GET", "vetting/requests"));
    expect(queue.status).toBe(200);
    expect((await queue.json()).assessments).toMatchObject([
      {
        assessmentId: id,
        projectId: "open-registry",
        revision: 1,
        manifestUrl: `${ORIGIN}/api/v1/project-revisions/open-registry/1`,
      },
    ]);

    const recorded = await postResult(await fixture(id, "clean"));
    expect(recorded.status).toBe(200);
    expect((await recorded.json()).assessment).toMatchObject({
      state: "clean",
      commitSha: "a".repeat(40),
      policyVersion: "vet-policy-1",
      artifacts: 1,
      heldArtifacts: 0,
    });
    // A replay of the same result cannot record twice.
    expect((await postResult(await fixture(id, "clean"))).status).toBe(409);
    expect((await publicVetting()).state).toBe("cleared");

    const activated = await activate();
    expect(activated.status).toBe(200);
    expect((await projects.getProject("open-registry"))?.status).toBe("active");
    // Revision 2 differs only by status, so the revision 1 scan still covers it.
    expect(await publicVetting()).toMatchObject({
      state: "cleared",
      assessment: { revision: 1 },
    });
  });

  test("an incomplete result quarantines the revision and blocks activation", async () => {
    await listPausedProject();
    const id = await queueScan();
    const result = await fixture(id, "incomplete");
    // A clean claim with a telemetry gap and a quarantined artifact is refused.
    const overclaimed = await postResult({ ...result, disposition: "clean" });
    expect(overclaimed.status).toBe(422);
    expect((await overclaimed.json()).message).toContain(
      "Telemetry channel http is not complete",
    );
    expect((await postResult(result)).status).toBe(200);
    expect(await publicVetting()).toMatchObject({
      state: "quarantined",
      assessment: { state: "incomplete", heldArtifacts: 1 },
    });
    const refused = await activate();
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toBe("vetting_required");
  });

  test("an unavailable model review can never produce a clean result", async () => {
    await listPausedProject();
    const id = await queueScan();
    const result = await fixture(id, "clean");
    result.modelReviews[1] = {
      ...result.modelReviews[1],
      status: "unavailable",
      verdict: null,
    } as unknown as (typeof result.modelReviews)[number];
    const refused = await postResult(result);
    expect(refused.status).toBe(422);
    expect((await refused.json()).message).toContain(
      "The opus review did not complete",
    );
    expect(
      (await postResult({ ...result, disposition: "incomplete" })).status,
    ).toBe(200);
    expect((await publicVetting()).state).toBe("quarantined");
  });

  test("confirmed malice bans the project; a model label alone cannot", async () => {
    await listPausedProject();
    const id = await queueScan();
    const result = await fixture(id, "malicious");
    const unconfirmed = await postResult({ ...result, confirmation: null });
    expect(unconfirmed.status).toBe(422);
    expect((await postResult(result)).status).toBe(200);
    expect((await publicVetting()).state).toBe("banned");
    // A later clean scan cannot lift the ban (VET-06).
    const rescan = await queueScan();
    expect((await postResult(await fixture(rescan, "clean"))).status).toBe(200);
    expect((await publicVetting()).state).toBe("banned");
    expect((await activate()).status).toBe(422);
  });

  test("forged, stale, mismatched and unconfigured requests fail closed", async () => {
    await listPausedProject();
    const id = await queueScan();
    const result = await fixture(id, "clean");
    // Stale timestamp.
    expect(
      (await postResult(result, new Date(NOW.getTime() - 10 * 60 * 1000)))
        .status,
    ).toBe(401);
    // Signature over other bytes.
    const forged = await signed("POST", "vetting/results", "{}");
    expect(
      (
        await vettingApi(
          new Request(forged.url, {
            method: "POST",
            headers: forged.headers,
            body: JSON.stringify(result),
          }),
        )
      ).status,
    ).toBe(401);
    // A result for another revision digest.
    const mismatch = await postResult({
      ...result,
      manifestSha256: "9".repeat(64),
    });
    expect(mismatch.status).toBe(422);
    // Unknown fields are refused.
    expect((await postResult({ ...result, extra: true })).status).toBe(422);
    // A non-admin cannot queue scans.
    expect(
      (
        await vettingApi(
          sessionRequest("POST", "admin/vetting/assessments", "applicant", {
            projectId: "open-registry",
            revision: 1,
            reason: "x",
          }),
        )
      ).status,
    ).toBe(403);
    expect((await publicVetting()).state).toBe("queued");

    configuredKeys = undefined;
    const overview = await vettingApi(
      sessionRequest("GET", "admin/vetting", "admin"),
    );
    expect((await overview.json()).service.state).toBe("unavailable");
    expect((await postResult(result)).status).toBe(503);
    expect(
      (
        await vettingApi(
          sessionRequest("POST", "admin/vetting/assessments", "admin", {
            projectId: "open-registry",
            revision: 1,
            reason: "Admission scan",
          }),
        )
      ).status,
    ).toBe(503);
  });
});
