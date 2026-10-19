/// <reference types="bun-types" />
// A possession challenge is single-use for the 15-minute window the server
// issued and stored. The signed message repeats issuedAt and expiresAt, so the
// endpoint must hold a submission to the stored window, not to whichever
// window the client chose to sign. Runs the real handler and the real D1
// persistence over every repository migration.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { signApiToken } from "../backend/trace/auth";
import {
  CloudflareTracePersistence,
  type D1Database,
  type R2Bucket,
} from "../backend/trace/cloudflare-persistence";
import {
  handleTraceApi,
  type TraceApiDependencies,
} from "../backend/trace/handler";
import { sha256Hex } from "../backend/trace/validation";
import {
  WALLET_POSSESSION_LIFETIME_MS,
  type WalletPossessionChallenge,
  walletPossessionMessage,
} from "../src/lib/wallet-possession";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SECRET = "wallet-possession-window-test-secret-0123456789";
const ACTOR = "424242";
const CLAIM = "claim_window";
const ISSUED_AT = Date.parse("2026-10-14T00:00:00.000Z");
const MINUTE = 60_000;

function base58(bytes: Uint8Array): string {
  let value = BigInt(
    `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
  let text = "";
  while (value > 0n) {
    text = BASE58_ALPHABET[Number(value % 58n)] + text;
    value /= 58n;
  }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading += 1;
  return "1".repeat(leading) + text;
}

function database(sql: Database): D1Database {
  const statement = (
    query: string,
    args: unknown[] = [],
  ): ReturnType<D1Database["prepare"]> => ({
    bind: (...values: unknown[]) => statement(query, values),
    async first<T>() {
      return (sql.query(query).get(...(args as string[])) ?? null) as T | null;
    },
    async run() {
      const result = sql.query(query).run(...(args as string[]));
      return { success: true, meta: { changes: result.changes } };
    },
  });
  return {
    prepare: statement,
    async batch(statements) {
      sql.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function setup() {
  const sql = new Database(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sql.exec(readFileSync(`migrations/${file}`, "utf8"));
  const secretKey = new Uint8Array(32).fill(9);
  const address = base58(ed25519.getPublicKey(secretKey));
  sql
    .query(
      `INSERT INTO wallet_claims (id, github_user_id, github_login, wallet_address,
        chain, source, issue_repository, issue_number, source_body_sha256,
        observed_at, record_sha256, supersedes_claim_id, created_at)
       VALUES (?, ?, 'window-tester', ?, 'solana', 'd1_registry', NULL, NULL,
        ?, ?, ?, NULL, ?)`,
    )
    .run(
      CLAIM,
      ACTOR,
      address,
      "a".repeat(64),
      "2026-10-13T00:00:00.000Z",
      "b".repeat(64),
      "2026-10-13T00:00:00.000Z",
    );
  let now = ISSUED_AT;
  let counter = 0;
  const deps: TraceApiDependencies = {
    persistence: new CloudflareTracePersistence(database(sql), {} as R2Bucket),
    authSecret: SECRET,
    operatorGithubIds: new Set<string>(),
    now: () => new Date(now),
    randomId: () => `window-test-${++counter}`,
    verifyIdentityAssertion: async () => null,
    privateIntakeStatus: async () => ({ status: "unavailable" }),
  };
  const request = async (path: string, body?: unknown) => {
    const iat = Math.floor(now / 1000);
    const token = await signApiToken(
      {
        iss: "slop.cash",
        aud: "private-trace-api",
        sub: `github:${ACTOR}`,
        githubId: ACTOR,
        githubLogin: "window-tester",
        roles: ["contributor"],
        iat,
        exp: iat + 300,
        jti: `window-test-jti-${++counter}`,
      },
      SECRET,
    );
    return handleTraceApi(
      new Request(`http://localhost/api/v1/wallet-claims/${CLAIM}/${path}`, {
        method: body === null ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body:
          body === undefined || body === null
            ? undefined
            : JSON.stringify(body),
      }),
      deps,
    );
  };
  return {
    sql,
    advance(ms: number) {
      now += ms;
    },
    async issue(): Promise<WalletPossessionChallenge> {
      const response = await request("possession-challenge");
      expect(response.status).toBe(201);
      return (
        (await response.json()) as { challenge: WalletPossessionChallenge }
      ).challenge;
    },
    submit(challenge: WalletPossessionChallenge) {
      const signature = Buffer.from(
        ed25519.sign(
          new TextEncoder().encode(walletPossessionMessage(challenge)),
          secretKey,
        ),
      ).toString("base64");
      return request("possession", { challenge, signature });
    },
    async state(): Promise<string> {
      const response = await request("possession", null);
      return ((await response.json()) as { state: string }).state;
    },
  };
}

function window(
  challenge: WalletPossessionChallenge,
  issuedAt: number,
): WalletPossessionChallenge {
  return {
    ...challenge,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + WALLET_POSSESSION_LIFETIME_MS).toISOString(),
  };
}

describe("wallet possession challenge window", () => {
  test("refuses an expired challenge re-signed over a later window", async () => {
    const api = setup();
    const issued = await api.issue();
    api.advance(2 * 24 * 60 * MINUTE);
    const response = await api.submit(
      window(issued, ISSUED_AT + 2 * 24 * 60 * MINUTE - MINUTE),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      "possession_challenge_unavailable",
    );
    expect(await api.state()).toBe("unproven");
    expect(
      api.sql
        .query("SELECT consumed_at FROM wallet_possession_challenges")
        .get(),
    ).toEqual({ consumed_at: null });
  });

  test("refuses a live challenge signed over a shifted window", async () => {
    const api = setup();
    const issued = await api.issue();
    api.advance(10 * MINUTE);
    const response = await api.submit(window(issued, ISSUED_AT + 5 * MINUTE));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "invalid_possession_proof",
    );
    expect(await api.state()).toBe("unproven");
  });

  test("records a proof over the window the server issued", async () => {
    const api = setup();
    const issued = await api.issue();
    expect(issued.issuedAt).toBe(new Date(ISSUED_AT).toISOString());
    api.advance(10 * MINUTE);
    const response = await api.submit(issued);
    expect(response.status).toBe(201);
    const proof = (await response.json()) as {
      state: string;
      messageDigest: string;
    };
    expect(proof.state).toBe("proven");
    expect(proof.messageDigest).toBe(
      await sha256Hex(
        new TextEncoder().encode(walletPossessionMessage(issued)),
      ),
    );
  });
});
