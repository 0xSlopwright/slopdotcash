// An evidence artifact that cannot be fetched is unavailable, not invalid.
// A transient transport failure is retried. If it persists, the snapshot
// evidence status is not "complete", so funding refuses the snapshot instead
// of accepting a silent zero bonus (protocol/points-v1.md, scoring-v2.md).
import { describe, expect, test } from "bun:test";
import type { PullRequestRecord } from "../src/lib/leaderboard-types";
import { verifyPullRequestEvidence } from "./generate-leaderboard";

const head = "a".repeat(40);
const artifactUrl =
  "https://github.com/user-attachments/assets/12345678-1234-4123-8123-123456789abc";
const body = `## Evidence\n<!-- evidence-head:${head} -->\n<!-- evidence-row:backend-logs -->\nBackend logs: [backend log](${artifactUrl})\n`;
const pullRequest = {
  id: "PR_kwDOtest",
  number: 1,
  url: "https://github.com/o/r/pull/1",
  title: "t",
  body,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  lastEditedAt: null,
  mergedAt: "2026-10-02T00:00:00Z",
  headRefOid: head,
  author: {
    id: "U_kgDOAAAAAQ",
    login: "alice",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    url: "https://github.com/alice",
    kind: "User",
  },
  editor: null,
  comments: [],
  reviews: [],
  labels: [],
  assignees: [],
} as unknown as PullRequestRecord;
const log = Array.from(
  { length: 400 },
  (_, i) =>
    `2026-10-01T00:00:00Z INFO request ${i} status=200 latency=${i % 37}ms`,
).join("\n");
const ok = () =>
  new Response(log, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
const failures: Record<string, (init?: RequestInit) => Promise<Response>> = {
  "network error": async () => {
    throw new TypeError("fetch failed");
  },
  "HTTP 503": async () => new Response("busy", { status: 503 }),
  "HTTP 429": async () => new Response("slow down", { status: 429 }),
  timeout: (init) =>
    new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      ),
    ),
};
const options = { evidenceTimeoutMs: 50, evidenceRetryDelayMs: 0 };

describe("evidence artifact transport failures", () => {
  test("verified artifact keeps a complete status", async () => {
    const result = await verifyPullRequestEvidence([pullRequest], {
      ...options,
      evidenceFetch: async () => ok(),
    });
    expect(result.status).toBe("complete");
    expect(result.artifacts).toHaveLength(1);
  });

  for (const [name, fail] of Object.entries(failures)) {
    test(`persistent ${name} is incomplete, never complete with zero`, async () => {
      let calls = 0;
      const result = await verifyPullRequestEvidence([pullRequest], {
        ...options,
        evidenceFetch: (async (_url: unknown, init?: RequestInit) => {
          calls += 1;
          return await fail(init);
        }) as never,
      });
      expect(result.artifacts).toHaveLength(0);
      expect(result.status).toBe("incomplete");
      expect(calls).toBe(3);
    });
  }

  test("one transient failure is retried and then verified", async () => {
    let calls = 0;
    const result = await verifyPullRequestEvidence([pullRequest], {
      ...options,
      evidenceFetch: async () => {
        calls += 1;
        return calls === 1 ? new Response("busy", { status: 503 }) : ok();
      },
    });
    expect(result.status).toBe("complete");
    expect(result.artifacts).toHaveLength(1);
  });

  test("invalid evidence (HTTP 404) still removes the bonus without retry", async () => {
    let calls = 0;
    const result = await verifyPullRequestEvidence([pullRequest], {
      ...options,
      evidenceFetch: async () => {
        calls += 1;
        return new Response("missing", { status: 404 });
      },
    });
    expect(result.status).toBe("complete");
    expect(result.artifacts).toHaveLength(0);
    expect(calls).toBe(1);
  });
});
