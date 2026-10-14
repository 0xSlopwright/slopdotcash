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
});
