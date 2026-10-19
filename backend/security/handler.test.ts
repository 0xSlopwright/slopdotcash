// Runs the security case API against the real migrations. A concurrent
// writer is injected between the case read and the write batch, which a
// browser test cannot schedule deterministically.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { sqliteD1 } from "../../tests/sqlite-d1";
import { handleSecurityApi, type SecurityD1Database } from "./handler";

const migrations = readdirSync("migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort();
const ORIGIN = "https://slop.test";
const PROJECT = "bounty";
const MAINTAINER = { githubId: "900000101", githubLogin: "maintainer" };
const REPORTER = { githubId: "900000102", githubLogin: "reporter" };
const TRIAGER = { githubId: "900000103", githubLogin: "triager" };
const ADVISORY = "GHSA-7c8f-9g2h-3j4m";
const RECEIVED = "2026-10-19T09:00:00.000Z";

type Reply = {
  error?: string;
  replayed?: boolean;
  case: { id: string; submissionState: string; receivedAt: string | null };
};

function open() {
  const { db, sqlite } = sqliteD1(migrations);
  const manifest = JSON.stringify({
    id: PROJECT,
    status: "active",
    securityBounty: {
      status: "pending-approval",
      intake: { repository: "example/bounty" },
      approvers: { technical: [MAINTAINER], financial: [], dispute: [] },
      capacity: { awards: 1, closesAt: null },
    },
  });
  const digest = createHash("sha256").update(manifest).digest("hex");
  sqlite
    .query(
      "INSERT INTO project_revisions (project_id, revision, manifest, manifest_sha256, reason, created_at) VALUES (?, 1, ?, ?, 'test', ?)",
    )
    .run(PROJECT, manifest, digest, RECEIVED);
  sqlite
    .query(
      "INSERT INTO projects (id, status, revision, manifest, manifest_sha256, created_at, updated_at) VALUES (?, 'active', 1, ?, ?, ?, ?)",
    )
    .run(PROJECT, manifest, digest, RECEIVED, RECEIVED);
  let actor = MAINTAINER;
  let ids = 0;
  // Runs before the next write batch, after the handler read the case.
  let beforeBatch: (() => void) | null = null;
  const securityDb = db as unknown as SecurityD1Database;
  const wrapped: SecurityD1Database = {
    prepare: (sql) => securityDb.prepare(sql),
    batch: async (statements) => {
      const hook = beforeBatch;
      beforeBatch = null;
      hook?.();
      return securityDb.batch(statements);
    },
  };
  const call = async (
    as: typeof MAINTAINER,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) => {
    actor = as;
    const response = await handleSecurityApi(
      new Request(`${ORIGIN}/api/v1/${path}`, {
        method,
        headers:
          method === "POST"
            ? { origin: ORIGIN, "content-type": "application/json" }
            : {},
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      {
        db: wrapped,
        now: () => new Date("2026-10-19T10:00:00.000Z"),
        randomId: () => {
          ids += 1;
          return `case${String(ids).padStart(8, "0")}`;
        },
        sessionActor: async () => actor,
        github: { fetch, apiOrigin: "https://api.github.invalid" },
      },
    );
    return {
      status: response?.status ?? 0,
      body: (await response?.json()) as Reply,
    };
  };
  let keys = 0;
  const key = () => {
    keys += 1;
    return `test-key-${String(keys).padStart(8, "0")}`;
  };
  return {
    sqlite,
    call,
    key,
    setBeforeBatch: (hook: () => void) => {
      beforeBatch = hook;
    },
  };
}

describe("security cases", () => {
  test("a rejected link can be corrected by a new claim or a record", async () => {
    const { call, key } = open();
    const claim = () =>
      call(REPORTER, "POST", "security-cases", {
        mode: "claim",
        projectId: PROJECT,
        advisory: ADVISORY,
        idempotencyKey: key(),
      });
    const record = (idempotencyKey = key()) =>
      call(MAINTAINER, "POST", "security-cases", {
        mode: "record",
        projectId: PROJECT,
        advisory: ADVISORY,
        reporterGithubId: REPORTER.githubId,
        reporterGithubLogin: REPORTER.githubLogin,
        receivedAt: RECEIVED,
        confirmation: true,
        idempotencyKey,
      });
    const first = await claim();
    expect(first.status).toBe(201);
    // A record over an open claim wrote nothing, so it is not a success.
    const overClaim = await record();
    expect(overClaim.status).toBe(409);
    expect(overClaim.body.error).toBe("claim_pending");
    const rejected = await call(
      MAINTAINER,
      "POST",
      `security-cases/${first.body.case.id}/actions`,
      {
        action: "reject-link",
        expectedRevision: 1,
        idempotencyKey: key(),
        reason: "The advisory names a different reporter.",
      },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.case.submissionState).toBe("link-rejected");
    // The reporter links again: a new live case, not the rejected one.
    const again = await claim();
    expect(again.status).toBe(201);
    expect(again.body.case.id).not.toBe(first.body.case.id);
    expect(again.body.case.submissionState).toBe("claimed");
    const reject2 = await call(
      MAINTAINER,
      "POST",
      `security-cases/${again.body.case.id}/actions`,
      {
        action: "reject-link",
        expectedRevision: 1,
        idempotencyKey: key(),
        reason: "Rejected again so the maintainer records it directly.",
      },
    );
    expect(reject2.status).toBe(200);
    // The maintainer records the advisory; the verified receipt is written.
    const recordKey = key();
    const recorded = await record(recordKey);
    expect(recorded.status).toBe(201);
    expect(recorded.body.case).toMatchObject({
      submissionState: "verified",
      receivedAt: RECEIVED,
    });
    // Only the exact request replays; another record is refused.
    const replay = await record(recordKey);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.case.id).toBe(recorded.body.case.id);
    const other = await record();
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("advisory_already_recorded");
  });

  test("a stale triager change grants or revokes nothing", async () => {
    const { call, key, sqlite, setBeforeBatch } = open();
    const recorded = await call(MAINTAINER, "POST", "security-cases", {
      mode: "record",
      projectId: PROJECT,
      advisory: ADVISORY,
      reporterGithubId: REPORTER.githubId,
      reporterGithubLogin: REPORTER.githubLogin,
      receivedAt: RECEIVED,
      confirmation: true,
      idempotencyKey: key(),
    });
    expect(recorded.status).toBe(201);
    const id = recorded.body.case.id as string;
    // Another maintainer moves the case two revisions ahead while this
    // request is in flight, so its event guard skips instead of colliding.
    const advanceTwice = () => {
      for (const revision of [2, 3]) {
        sqlite
          .query(
            "UPDATE security_cases SET revision = ?, updated_at = ? WHERE id = ?",
          )
          .run(revision, RECEIVED, id);
        sqlite
          .query(
            "INSERT INTO security_case_events (case_id, case_revision, kind, actor_github_id, actor_role, idempotency_key, detail, at) VALUES (?, ?, 'next-action', ?, 'security-maintainer', ?, '{}', ?)",
          )
          .run(id, revision, MAINTAINER.githubId, key(), RECEIVED);
      }
    };
    const members = () =>
      sqlite
        .query(
          "SELECT github_id, revoked_at FROM security_case_members WHERE case_id = ?",
        )
        .all(id) as { github_id: string; revoked_at: string | null }[];
    setBeforeBatch(advanceTwice);
    const stale = await call(
      MAINTAINER,
      "POST",
      `security-cases/${id}/actions`,
      {
        action: "assign-triager",
        expectedRevision: 1,
        idempotencyKey: key(),
        ...TRIAGER,
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("stale_revision");
    expect(members()).toEqual([]);
    expect((await call(TRIAGER, "GET", `security-cases/${id}`)).status).toBe(
      404,
    );

    const assigned = await call(
      MAINTAINER,
      "POST",
      `security-cases/${id}/actions`,
      {
        action: "assign-triager",
        expectedRevision: 3,
        idempotencyKey: key(),
        ...TRIAGER,
      },
    );
    expect(assigned.status).toBe(200);
    expect(members()).toEqual([
      { github_id: TRIAGER.githubId, revoked_at: null },
    ]);

    setBeforeBatch(() => {
      for (const revision of [5, 6]) {
        sqlite
          .query("UPDATE security_cases SET revision = ? WHERE id = ?")
          .run(revision, id);
        sqlite
          .query(
            "INSERT INTO security_case_events (case_id, case_revision, kind, actor_github_id, actor_role, idempotency_key, detail, at) VALUES (?, ?, 'next-action', ?, 'security-maintainer', ?, '{}', ?)",
          )
          .run(id, revision, MAINTAINER.githubId, key(), RECEIVED);
      }
    });
    const staleRevoke = await call(
      MAINTAINER,
      "POST",
      `security-cases/${id}/actions`,
      {
        action: "revoke-triager",
        expectedRevision: 4,
        idempotencyKey: key(),
        githubId: TRIAGER.githubId,
      },
    );
    expect(staleRevoke.status).toBe(409);
    expect(members()).toEqual([
      { github_id: TRIAGER.githubId, revoked_at: null },
    ]);
    const events = sqlite
      .query(
        "SELECT kind FROM security_case_events WHERE case_id = ? AND kind LIKE '%triager' ORDER BY case_revision",
      )
      .all(id) as { kind: string }[];
    expect(events).toEqual([{ kind: "assign-triager" }]);
  });
});
