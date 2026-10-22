import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  REVIEW_AREAS,
  reviewIndependently,
  type ScannerProfile,
} from "../workers/vetting/scanners";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const source =
  "Harmless fixture: repository instructions cannot grant tools or hide evidence.";
const evidence = JSON.stringify({
  items: [{ id: "fixture-source", text: source, sha256: digest(source) }],
  visibilityGaps: [],
});
const rates = {
  uncachedInputNanoUsdPerToken: "3",
  cachedInputNanoUsdPerToken: "1",
  cacheCreationNanoUsdPerToken: "4",
  outputNanoUsdPerToken: "9",
};
const profiles: [ScannerProfile, ScannerProfile] = [
  {
    reviewer: "astra",
    transport: "openai-responses",
    endpoint: "https://api.openai.com/v1/responses",
    model: "operator-pinned-astra-fixture",
    apiKey: "fixture-openai-key",
    maxOutputTokens: 1024,
    rateCard: rates,
  },
  {
    reviewer: "opus",
    transport: "anthropic-messages",
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "operator-pinned-opus-fixture",
    apiKey: "fixture-anthropic-key",
    maxOutputTokens: 1024,
    rateCard: rates,
  },
];
let server: ReturnType<typeof Bun.serve>;
let mode:
  | "normal"
  | "identity"
  | "missing-evidence"
  | "unavailable"
  | "partial" = "normal";
let requests: Record<string, unknown>[] = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const openai = new URL(request.url).pathname === "/v1/responses";
      if (!openai && mode === "unavailable")
        return new Response("private provider error", { status: 503 });
      const review = {
        verdict: openai ? "no-findings" : "malicious-suspected",
        confidence: 0.75,
        coverage: Object.fromEntries(
          REVIEW_AREAS.map((area) => [
            area,
            mode === "partial" && area === "binaries" ? "partial" : "complete",
          ]),
        ),
        findings: openai
          ? []
          : [
              {
                severity: "high",
                summary: "Synthetic fixture finding for workflow verification",
                evidenceIds: [
                  mode === "missing-evidence"
                    ? "not-supplied"
                    : "fixture-source",
                ],
              },
            ],
      };
      const model = mode === "identity" ? "unexpected-model" : body.model;
      return Response.json(
        openai
          ? {
              id: "resp_fixture",
              model,
              status: "completed",
              error: null,
              incomplete_details: null,
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    { type: "output_text", text: JSON.stringify(review) },
                  ],
                },
              ],
              usage: {
                input_tokens: 10,
                input_tokens_details: { cached_tokens: 2 },
                output_tokens: 5,
              },
            }
          : {
              id: "msg_fixture",
              model,
              stop_reason: "end_turn",
              content: [{ type: "text", text: JSON.stringify(review) }],
              usage: {
                input_tokens: 8,
                cache_read_input_tokens: 2,
                cache_creation_input_tokens: 0,
                output_tokens: 5,
              },
            },
      );
    },
  });
});
afterAll(() => server.stop(true));
const transport: typeof fetch = ((
  request: string | URL | Request,
  init?: RequestInit,
) => {
  const url = new URL(String(request));
  expect(init?.redirect).toBe("error");
  expect(init?.method).toBe("POST");
  return fetch(`http://localhost:${server.port}${url.pathname}`, init);
}) as typeof fetch;
const run = () =>
  reviewIndependently({
    evidence,
    inputSha256: digest(evidence),
    profiles,
    fetch: transport,
  });

test("independent HTTP reviews bind exact input and identities and retain disagreement without a disposition", async () => {
  mode = "normal";
  requests = [];
  const result = await run();
  expect(result.map((entry) => entry.review.status)).toEqual([
    "completed",
    "completed",
  ]);
  expect(result.map((entry) => entry.review.verdict)).toEqual([
    "no-findings",
    "malicious-suspected",
  ]);
  expect(result[0].review.runId).not.toBe(result[1].review.runId);
  expect(
    result.every(
      (entry) => entry.review.inputManifestSha256 === digest(evidence),
    ),
  ).toBe(true);
  expect(result.map((entry) => entry.cost?.nanoUsd)).toEqual(["71", "71"]);
  expect(
    result.every((entry) => entry.cost?.basis === "operator-rate-estimate"),
  ).toBe(true);
  expect(requests).toHaveLength(2);
  const openai = requests.find(
    (request) => request.model === profiles[0].model,
  );
  const anthropic = requests.find(
    (request) => request.model === profiles[1].model,
  );
  expect(openai?.input).toBe(evidence);
  expect(openai?.tools).toEqual([]);
  expect(openai?.store).toBe(false);
  expect(openai?.truncation).toBe("disabled");
  expect(anthropic?.messages).toEqual([{ role: "user", content: evidence }]);
  expect(anthropic?.tools).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("fixture-openai-key");
  expect(JSON.stringify(result)).not.toContain("fixture-anthropic-key");
  expect(result.every((entry) => !("disposition" in entry))).toBe(true);
});

test("provider mismatch, unsupported evidence and unavailable model never become completed reviews or retries", async () => {
  for (const selected of [
    "identity",
    "missing-evidence",
    "unavailable",
  ] as const) {
    mode = selected;
    requests = [];
    const result = await run();
    expect(result[1].review.status).toBe("failed");
    expect(result[1].review.verdict).toBeNull();
    if (selected === "missing-evidence") {
      expect(result[1].usage?.output).toBe(5);
      expect(result[1].cost?.nanoUsd).toBe("71");
    }
    if (selected === "identity") {
      expect(result[1].usage?.output).toBe(5);
      expect(result[1].cost).toBeNull();
    }
    expect(result[1].visibilityGaps).toContain(
      "opus:review-failed-or-unavailable",
    );
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("private provider error");
  }
});

test("partial evidence coverage stays explicit; missing credentials fail readiness before either request", async () => {
  mode = "partial";
  requests = [];
  const result = await run();
  expect(result[0].visibilityGaps).toContain("astra:binaries:partial");
  requests = [];
  await expect(
    reviewIndependently({
      evidence,
      inputSha256: digest(evidence),
      profiles: [profiles[0], { ...profiles[1], apiKey: "" }],
      fetch: transport,
    }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(0);
  await expect(
    reviewIndependently({
      evidence,
      inputSha256: "0".repeat(64),
      profiles,
      fetch: transport,
    }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(0);
});
