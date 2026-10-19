// Route-level checks: the /github/webhook handler must bound the body before
// signature verification and must sign the exact received bytes.
import { describe, expect, test } from "bun:test";
import worker from "./index";

const SECRET = "test-secret";
const URL = "https://slopbot.example/github/webhook";
const LIMIT = 25 * 1024 * 1024;

type Fetch = (request: Request, env: never) => Promise<Response>;
const handle = worker.fetch as unknown as Fetch;

async function sign(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function env(): never {
  return {
    SLOPBOT_WEBHOOK_SECRET: SECRET,
    SLOPBOT_DB: {
      prepare: () => {
        throw new Error("persistence must not be reached");
      },
    },
  } as never;
}

/** Env with an in-memory delivery table and a queue that records sends. */
function trackedEnv() {
  const deliveries = new Set<string>();
  const queued: unknown[] = [];
  const db = {
    batch: async () => [],
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.startsWith("INSERT OR IGNORE INTO slopbot_deliveries")) {
            const id = String(args[0]);
            const fresh = !deliveries.has(id);
            deliveries.add(id);
            return { meta: { changes: fresh ? 1 : 0 } };
          }
          if (sql.startsWith("DELETE FROM slopbot_deliveries")) {
            deliveries.delete(String(args[0]));
          }
          return { meta: { changes: 0 } };
        },
      }),
    }),
  };
  const env = {
    SLOPBOT_WEBHOOK_SECRET: SECRET,
    SLOPBOT_APP_USER_ID: "0",
    SLOPBOT_DB: db,
    SLOPBOT_QUEUE: { send: async (job: unknown) => void queued.push(job) },
  } as never;
  return { env, deliveries, queued };
}

async function signedPost(
  env: never,
  raw: Uint8Array<ArrayBuffer>,
  delivery: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  return handle(
    new Request(URL, {
      method: "POST",
      body: raw,
      headers: {
        "x-hub-signature-256": await sign(raw),
        "x-github-event": "ping",
        "x-github-delivery": delivery,
        ...extra,
      },
    }),
    env,
  );
}

describe("POST /github/webhook body bound", () => {
  test("rejects a chunked body with no Content-Length once it passes the limit", async () => {
    let cancelled = false;
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent > LIMIT * 2) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handle(
      new Request(URL, { method: "POST", body, duplex: "half" } as RequestInit),
      env(),
    );
    expect(response.status).toBe(413);
    expect(sent).toBeLessThanOrEqual(LIMIT + 2 * chunk.byteLength);
    expect(cancelled).toBe(true);
  });

  test("rejects a declared oversized Content-Length before reading", async () => {
    const response = await handle(
      new Request(URL, {
        method: "POST",
        body: "{}",
        headers: { "content-length": String(LIMIT + 1) },
      }),
      env(),
    );
    expect(response.status).toBe(413);
  });

  test("verifies the HMAC over the exact received bytes, including a BOM", async () => {
    const raw = Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d);
    const response = await handle(
      new Request(URL, {
        method: "POST",
        body: raw,
        headers: { "x-hub-signature-256": await sign(raw) },
      }),
      env(),
    );
    // Signature accepted; the request then fails on the missing delivery id.
    expect(response.status).toBe(400);
  });

  test("rejects a signed body with invalid UTF-8 and records nothing", async () => {
    // Valid JSON syntax, but 0xff is not UTF-8.
    const raw = Uint8Array.of(
      0x7b,
      0x22,
      0x61,
      0x22,
      0x3a,
      0x22,
      0xff,
      0x22,
      0x7d,
    );
    const { env, deliveries, queued } = trackedEnv();
    const response = await signedPost(env, raw, "bad-utf8");
    expect(response.status).toBe(400);
    expect(deliveries.size).toBe(0);
    expect(queued).toEqual([]);
    // A corrected redelivery with the same id must be processed, not dropped.
    const good = new TextEncoder().encode('{"a":"b"}');
    const retry = await signedPost(env, good, "bad-utf8");
    expect(retry.status).toBe(202);
    expect(await retry.text()).toBe("ignored");
    expect(deliveries.has("bad-utf8")).toBe(true);
  });

  test("rejects invalid UTF-8 on the installation path before claiming the delivery", async () => {
    const raw = Uint8Array.of(
      0x7b,
      0x22,
      0x61,
      0x22,
      0x3a,
      0x22,
      0xff,
      0x22,
      0x7d,
    );
    const { env, deliveries } = trackedEnv();
    const response = await signedPost(env, raw, "bad-utf8-install", {
      "x-github-event": "installation",
    });
    expect(response.status).toBe(400);
    expect(deliveries.size).toBe(0);
  });

  test("accepts a body of exactly the byte limit", async () => {
    const head = new TextEncoder().encode('{"pad":"');
    const tail = new TextEncoder().encode('"}');
    const raw = new Uint8Array(LIMIT);
    raw.fill(0x61);
    raw.set(head, 0);
    raw.set(tail, LIMIT - tail.byteLength);
    const { env, deliveries, queued } = trackedEnv();
    const response = await signedPost(env, raw, "exact-limit");
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("ignored");
    expect(deliveries.has("exact-limit")).toBe(true);
    expect(queued).toEqual([]);
  });

  test("rejects a body over the limit when Content-Length understates it", async () => {
    let cancelled = false;
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent > LIMIT * 2) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handle(
      new Request(URL, {
        method: "POST",
        body,
        duplex: "half",
        headers: { "content-length": "2" },
      } as RequestInit),
      env(),
    );
    expect(response.status).toBe(413);
    expect(sent).toBeLessThanOrEqual(LIMIT + 2 * chunk.byteLength);
    expect(cancelled).toBe(true);
  });
});
