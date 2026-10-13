import { expect, test } from "bun:test";
import { assessModelAttribution } from "../src/lib/leaderboard";
import type { GitHubTextSource } from "../src/lib/leaderboard-types";
import {
  type ProjectRunReceipt,
  runReceiptMarker,
} from "../src/lib/run-receipts";

const ordinaryMarker = {
  provider: "OpenAI",
  model: "gpt-5",
  client: "codex",
  skill_revision:
    "N/A - ordinary GitHub contribution without optional run evidence",
};

const receipt = {
  schemaVersion: "2",
  runId: "run_0123456789ABCDEFGHJKMNPQRS",
  projectId: "slopdotcash",
  repositoryId: "SlopDotCash/slopdotcash",
  startedAt: "2026-10-12T00:00:00.000Z",
  completedAt: "2026-10-12T00:01:00.000Z",
  provider: "OpenAI",
  model: "gpt-5",
  client: "codex",
  skillRevision:
    "SlopDotCash/slopdotcash@36ff30c07fb70efef753015cfd92cee8d07043a8:skills/contribute-to-slopdotcash",
  skillSha256: "a".repeat(64),
  policyAcknowledgement: {
    policyRevision: "2026-10-11.1",
    licenseSha256:
      "3c50e19c2a6022364f5cef932e4e5cdbddc91087e52ae8d8614b48a04fee40a5",
    inboundTermsSha256:
      "69302e234b8c5dececde858d7ba5736a2471b18875ca8fdb0adb099a3cebb962",
    prizeRulesSha256: null,
    acknowledgedAt: "2026-10-12T00:00:30.000Z",
  },
  usage: {
    source: "none",
    confidence: "unavailable",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costMicroUsd: "0",
    sessionCount: 0,
  },
  trajectorySha256: null,
  traceUpload: null,
  signatureAlgorithm: "ed25519",
  devicePublicKey: "a".repeat(43),
  deviceKeyId: "b".repeat(64),
  deviceSignature: "c".repeat(86),
} satisfies ProjectRunReceipt;

function body(
  marker: unknown,
  tag = "slop-contribution-attribution:v1",
  skillRevision = ordinaryMarker.skill_revision,
) {
  return `Made via @slopdotcash
AI provider/model: OpenAI / gpt-5
Client / agent tooling: codex
Contribution skill revision: ${skillRevision}
Attribution status: self-reported
— [contributor]
<!-- ${tag} ${JSON.stringify(marker)} -->`;
}

function attribution(sourceBody: string) {
  return assessModelAttribution(
    [
      {
        id: "PR_test",
        artifactId: "PR_test",
        kind: "body",
        body: sourceBody,
        url: "https://example.test/pull/1",
        createdAt: "2026-10-13T00:00:00Z",
        updatedAt: "2026-10-13T00:00:00Z",
        author: {
          id: "U_test",
          login: "contributor",
          avatarUrl: "",
          url: "https://example.test/contributor",
          kind: "User",
        },
      } satisfies GitHubTextSource,
    ],
    { requireEverySource: true },
  );
}

test("accepts an ordinary Slop disclose marker as a v1 declaration", () => {
  const result = attribution(body(ordinaryMarker));
  expect(result.coverage.status).toBe("complete");
  expect(result.invalidMarkers).toEqual([]);
});

test("accepts a signed Slop run marker", () => {
  const result = attribution(
    body(runReceiptMarker(receipt), undefined, receipt.skillRevision),
  );
  expect(result.coverage.status).toBe("complete");
  expect(result.invalidMarkers).toEqual([]);
});

test("rejects an ordinary Slop marker with an extra field", () => {
  const result = attribution(body({ ...ordinaryMarker, extra: "invalid" }));
  expect(result.coverage.status).toBe("partial");
  expect(result.invalidMarkers).toHaveLength(1);
});

test("rejects a signed Slop run marker with an invalid run id", () => {
  const marker = runReceiptMarker(receipt);
  marker.run.run_id = "not-a-run-id";
  const result = attribution(body(marker));
  expect(result.coverage.status).toBe("partial");
  expect(result.invalidMarkers).toHaveLength(1);
});

test("keeps legacy Eliza v2 markers on the signed receipt path", () => {
  const result = attribution(
    body(
      runReceiptMarker(receipt),
      "elizaos-contribution-attribution:v2",
      receipt.skillRevision,
    ),
  );
  expect(result.coverage.status).toBe("complete");
  expect(result.invalidMarkers).toEqual([]);
});
