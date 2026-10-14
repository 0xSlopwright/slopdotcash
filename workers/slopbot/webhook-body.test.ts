import { describe, expect, test } from "bun:test";
import { readWebhookBody } from "./webhook-body";

const MAX = 64;

function request(body: BodyInit | null, headers?: Record<string, string>) {
  return new Request("https://slopbot.example/github/webhook", {
    method: "POST",
    headers,
    body,
  });
}

describe("readWebhookBody", () => {
  test("rejects a Content-Length above the limit before reading", async () => {
    const result = await readWebhookBody(
      request("tiny", { "content-length": String(MAX + 1) }),
      MAX,
    );
    expect(result).toEqual({
      ok: false,
      status: 413,
      message: "payload too large",
    });
  });

  test("rejects a missing Content-Length once the streamed body exceeds the limit", async () => {
    const result = await readWebhookBody(request("x".repeat(MAX + 1)), MAX);
    expect(result).toEqual({
      ok: false,
      status: 413,
      message: "payload too large",
    });
  });

  test("rejects when Content-Length is under the limit but the body is larger", async () => {
    // Fetch implementations may ignore a lied Content-Length; the stream bound
    // must still stop the read before signature verification.
    const result = await readWebhookBody(
      request("x".repeat(MAX + 8), { "content-length": "8" }),
      MAX,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(413);
  });

  test("accepts a body at the limit and returns the exact UTF-8 text", async () => {
    const body = "a".repeat(MAX);
    const result = await readWebhookBody(
      request(body, { "content-length": String(MAX) }),
      MAX,
    );
    expect(result).toEqual({ ok: true, body });
  });

  test("rejects invalid UTF-8 without treating it as a size breach", async () => {
    const result = await readWebhookBody(
      request(Uint8Array.of(0xff, 0xfe), { "content-length": "2" }),
      MAX,
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: "invalid payload encoding",
    });
  });
});
