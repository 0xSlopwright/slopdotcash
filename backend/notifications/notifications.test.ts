// Each writer adds its inbox row in the same batch as the source change.
// These tests run the real migrations, project persistence, payment ledger,
// payout dispatch, wallet registration and inbox route, then replay each
// source event to prove that a replay never adds a second notification.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { ProjectDefinition } from "../../src/lib/projects.mjs";
import { sqliteD1 } from "../../tests/sqlite-d1";
import { dispatchPayment } from "../payments/dispatch";
import {
  indexPaymentEvent,
  type PaymentChainAdapter,
} from "../payments/ledger";
import { registerPaymentWallet } from "../payments/wallet-registration";
import { CloudflareProjectPersistence } from "../projects/cloudflare-persistence";
import type { D1Database } from "../trace/cloudflare-persistence";
import { handleNotificationsApi } from "./handler";

const migrations = readdirSync("migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort();
const T = "2026-10-19T10:00:00.000Z";
const R = "2026-10-19T10:30:00.000Z";
const APPLICANT = "900000002";
const STEWARD = "900000003";
const OTHER = "900000004";
const ADDRESS = "0x8f77c37d8650776bfe73c9b12b15209ee15d9b86";
const NEXT_ADDRESS = "0x2222222222222222222222222222222222222222";
const VAULT = "0x1111111111111111111111111111111111111111";
const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function open() {
  const { db, sqlite } = sqliteD1(migrations);
  const rows = (recipient: string) =>
    sqlite
      .query(
        "SELECT event_key,kind,subject,detail,action_path,source_at,read_at FROM notifications WHERE recipient_github_id=? ORDER BY source_at,event_key",
      )
      .all(recipient) as Record<string, string | null>[];
  return { db, sqlite, rows };
}

describe("notification events", () => {
  test("application decisions and later revisions notify once each", async () => {
    const { db, rows } = open();
    const persistence = new CloudflareProjectPersistence(db);
    const admin = { githubId: "1", githubLogin: "admin" };
    for (const id of ["alpha", "beta"]) {
      const manifest = {
        id,
        status: "paused",
        repositories: [{ id: `example/${id}` }],
        steward: { github: { actorId: STEWARD } },
      } as unknown as ProjectDefinition;
      expect(
        await persistence.createApplication({
          id: `application-${id}`,
          projectId: id,
          repositoryKey: `example/${id}`,
          manifest,
          manifestText: JSON.stringify(manifest),
          manifestSha256: id[0].repeat(64),
          acceptanceCriteria: "Merged pull requests",
          applicant: { githubId: APPLICANT, githubLogin: "e2e-applicant" },
          submittedAt: T,
          status: "pending",
          adminNotification: "pending",
          adminNotificationAt: null,
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
          githubCheck: null,
        }),
      ).toBe("created");
    }
    const approve = {
      applicationId: "application-alpha",
      actor: admin,
      reason: null,
      at: T,
    };
    const reject = {
      applicationId: "application-beta",
      actor: admin,
      reason: "Repository is private",
      at: T,
    };
    expect(await persistence.approveApplication(approve)).toBe("approved");
    expect(await persistence.rejectApplication(reject)).toBe("rejected");
    // A replayed decision finds no pending row and writes nothing.
    expect(await persistence.approveApplication(approve)).toBe("conflict");
    expect(await persistence.rejectApplication(reject)).toBe("conflict");
    const project = await persistence.getProject("alpha");
    const next = { ...project?.manifest, revision: 2 } as ProjectDefinition;
    const revision = {
      projectId: "alpha",
      expectedRevision: 1,
      manifest: next,
      manifestText: JSON.stringify(next),
      manifestSha256: "2".repeat(64),
      reason: "Activate with generated skills",
      actor: admin,
      at: R,
    };
    expect(await persistence.appendProjectRevision(revision)).toBe("updated");
    // The same revision cannot be appended twice.
    expect(await persistence.appendProjectRevision(revision)).toBe("conflict");
    expect(rows(APPLICANT)).toEqual([
      {
        event_key: "project-application:application-alpha:approved",
        kind: "application_approved",
        subject: "alpha",
        detail: null,
        action_path: "/projects/alpha",
        source_at: T,
        read_at: null,
      },
      {
        event_key: "project-application:application-beta:rejected",
        kind: "application_rejected",
        subject: "beta",
        detail: "Repository is private",
        action_path: "/projects/new",
        source_at: T,
        read_at: null,
      },
      {
        event_key: "project-revision:alpha:2",
        kind: "project_revision",
        subject: "alpha",
        detail: "Activate with generated skills",
        action_path: "/projects/alpha",
        source_at: R,
        read_at: null,
      },
    ]);
    expect(rows(STEWARD).map((row) => row.event_key)).toEqual([
      "project-revision:alpha:2",
    ]);
  });

  test("wallet changes and finalized payment events notify the contributor once", async () => {
    const { db, sqlite, rows } = open();
    const d1 = db as unknown as D1Database;
    const member = { github_id: APPLICANT, login: "e2e-applicant" };
    const authorize = (claimId: string, n: number) =>
      sqlite.exec(
        `INSERT INTO payment_wallet_challenges VALUES ('challenge-${n}','${claimId}','${APPLICANT}','message','2026-10-20T00:00:00.000Z','${T}');
         INSERT INTO payment_wallet_authorizations VALUES ('${claimId}','${APPLICANT}','${T}','challenge-${n}','signature');`,
      );
    const first = await registerPaymentWallet(d1, member, "base", ADDRESS, T);
    // Registering the same address again is a replay and adds no claim.
    expect(await registerPaymentWallet(d1, member, "base", ADDRESS, T)).toEqual(
      first,
    );
    authorize(first.claimId, 1);
    sqlite.exec(
      `INSERT INTO vault_snapshots (project_id,network,chain,vault,asset_address,asset_decimals,total_deposited,total_paid,total_payout_fees,total_gross_withdrawn,total_withdrawal_fees,total_service_fees,block_number,block_time,observed_at)
         VALUES ('alpha','base-sepolia','base','${VAULT}','${ASSET}',6,'0','0','0','0','0','0','1','${T}','${T}');`,
    );
    const event = (kind: "reserved" | "paid", transactionId: string) => ({
      kind,
      transactionId,
      eventIndex: 0,
      blockId: "1",
      obligationId: "obligation-1",
      projectId: "alpha",
      network: "base-sepolia",
      chain: "base" as const,
      vault: VAULT,
      githubUserId: APPLICANT,
      grossMicro: "1000000",
      netMicro: "980000",
      feeMicro: "20000",
      sourceDigest: "b".repeat(64),
      ...(kind === "paid" ? { destination: NEXT_ADDRESS } : {}),
    });
    const adapter: PaymentChainAdapter = {
      verifyFinalized: async (input) => event(input.kind, input.transactionId),
    };
    const reserved = {
      transactionId: "0xreserve",
      eventIndex: 0,
      kind: "reserved" as const,
      obligationId: "obligation-1",
    };
    const paid = { ...reserved, transactionId: "0xpay", kind: "paid" as const };
    const reservedAt = "2026-10-19T11:00:00.000Z";
    const changedAt = "2026-10-19T11:10:00.000Z";
    const heldAt = new Date("2026-10-19T11:20:00.000Z");
    const paidAt = "2026-10-19T12:00:00.000Z";
    await indexPaymentEvent(d1, adapter, reserved, reservedAt);
    await indexPaymentEvent(d1, adapter, reserved, "2026-10-19T11:30:00.000Z");
    // A new wallet that is not yet confirmed makes the worker hold the payout.
    const next = await registerPaymentWallet(
      d1,
      member,
      "base",
      NEXT_ADDRESS,
      changedAt,
    );
    const executor = {
      submit: async () => {
        throw new Error("A held payout must not be submitted");
      },
    };
    expect(await dispatchPayment(d1, executor, "obligation-1", heldAt)).toBe(
      "unavailable",
    );
    expect(await dispatchPayment(d1, executor, "obligation-1", heldAt)).toBe(
      "unavailable",
    );
    authorize(next.claimId, 2);
    await indexPaymentEvent(d1, adapter, paid, paidAt);
    await indexPaymentEvent(d1, adapter, paid, "2026-10-19T12:30:00.000Z");
    expect(
      rows(APPLICANT).map((row) => [
        row.event_key,
        row.kind,
        row.subject,
        row.action_path,
        row.source_at,
      ]),
    ).toEqual([
      [
        `wallet-claim:${first.claimId}`,
        "wallet_changed",
        "base",
        "/account#wallets",
        T,
      ],
      [
        "payment-reserved:obligation-1",
        "award_reserved",
        "alpha",
        "/earnings",
        reservedAt,
      ],
      [
        `wallet-claim:${next.claimId}`,
        "wallet_changed",
        "base",
        "/account#wallets",
        changedAt,
      ],
      [
        `payout-held:obligation-1:${heldAt.toISOString()}`,
        "payout_held",
        "alpha",
        "/earnings",
        heldAt.toISOString(),
      ],
      [
        "payment-paid:obligation-1",
        "payment_paid",
        "alpha",
        "/earnings",
        paidAt,
      ],
    ]);
    expect(rows(OTHER)).toEqual([]);
  });

  test("a notification changes only from unread to read and is never deleted", () => {
    const { sqlite } = open();
    sqlite.exec(
      `INSERT INTO notifications (event_key,recipient_github_id,kind,subject,action_path,source_at,created_at) VALUES ('wallet-claim:x','${APPLICANT}','wallet_changed','base','/account#wallets','${T}','${T}')`,
    );
    expect(() =>
      sqlite.exec("UPDATE notifications SET subject='solana'"),
    ).toThrow(/unread to read/u);
    sqlite.exec(`UPDATE notifications SET read_at='${T}'`);
    expect(() =>
      sqlite.exec(
        "UPDATE notifications SET read_at='2026-10-19T13:00:00.000Z'",
      ),
    ).toThrow(/unread to read/u);
    expect(() => sqlite.exec("DELETE FROM notifications")).toThrow(
      /permanent/u,
    );
  });
});

describe("notifications API", () => {
  const origin = "https://slop.cash";
  function setup(actor: string | null) {
    const { db, sqlite, rows } = open();
    for (const [recipient, key, at] of [
      [APPLICANT, "wallet-claim:a", "2026-10-19T10:00:00.000Z"],
      [APPLICANT, "wallet-claim:b", "2026-10-19T11:00:00.000Z"],
      [OTHER, "wallet-claim:c", "2026-10-19T12:00:00.000Z"],
    ])
      sqlite
        .prepare(
          "INSERT INTO notifications (event_key,recipient_github_id,kind,subject,action_path,source_at,created_at) VALUES (?,?,'wallet_changed','base','/account#wallets',?,?)",
        )
        .run(key, recipient, at, at);
    const call = (request: Request) =>
      handleNotificationsApi(request, {
        db: db as never,
        sessionActor: async () => (actor ? { githubId: actor } : null),
        now: () => new Date("2026-10-19T13:00:00.000Z"),
      });
    return { call, rows };
  }
  const read = (keys: unknown, headers: Record<string, string> = {}) =>
    new Request(`${origin}/api/v1/notifications/read`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify({ eventKeys: keys }),
    });

  test("lists only the signed-in recipient's rows, newest first", async () => {
    const { call } = setup(APPLICANT);
    const response = (await call(
      new Request(`${origin}/api/v1/notifications`),
    )) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.unread).toBe(2);
    expect(
      body.notifications.map((n: { eventKey: string }) => n.eventKey),
    ).toEqual(["wallet-claim:b", "wallet-claim:a"]);
  });

  test("marks the recipient's own rows read once and refuses other writes", async () => {
    const { call, rows } = setup(APPLICANT);
    const first = (await call(
      read(["wallet-claim:a", "wallet-claim:c"]),
    )) as Response;
    expect(await first.json()).toEqual({ marked: 1 });
    const again = (await call(read(["wallet-claim:a"]))) as Response;
    expect(await again.json()).toEqual({ marked: 0 });
    expect(rows(APPLICANT)[0].read_at).toBe("2026-10-19T13:00:00.000Z");
    expect(rows(OTHER)[0].read_at).toBeNull();
    expect(
      (
        (await call(
          read(["wallet-claim:a"], { origin: "https://attacker.example" }),
        )) as Response
      ).status,
    ).toBe(403);
    expect(((await call(read([]))) as Response).status).toBe(400);
    expect(((await call(read(["x"]))) as Response).status).toBe(400);
  });

  test("a signed-out request gets 401 and other paths are not handled", async () => {
    const { call } = setup(null);
    expect(
      ((await call(new Request(`${origin}/api/v1/notifications`))) as Response)
        .status,
    ).toBe(401);
    expect(await call(new Request(`${origin}/api/v1/projects`))).toBeNull();
  });
});
