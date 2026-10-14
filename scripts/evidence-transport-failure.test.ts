// An evidence artifact that cannot be fetched is unavailable, not invalid.
// Only the artifact that failed in transport is fetched again. If it stays
// unavailable, snapshot collection fails before a scored snapshot exists
// (protocol/points-v1.md, protocol/scoring-v2.md). HTTP 404 is terminal.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LeaderboardSnapshot,
  PullRequestRecord,
} from "../src/lib/leaderboard-types";
import {
  EvidenceUnavailableError,
  retrySlopSnapshot,
  runGenerator,
  verifyPullRequestEvidence,
  writeLeaderboardAtomically,
} from "./generate-leaderboard";

const head = "a".repeat(40);
const logsUrl =
  "https://github.com/user-attachments/assets/12345678-1234-4123-8123-123456789abc";
const domainUrl =
  "https://github.com/user-attachments/assets/87654321-4321-4321-8321-cba987654321";
const evidenceBody = (rows: string) =>
  `## Evidence\n<!-- evidence-head:${head} -->\n${rows}`;
const logsRow = `<!-- evidence-row:backend-logs -->\nBackend logs: [backend log](${logsUrl})\n`;
const domainRow = `<!-- evidence-row:domain-artifacts -->\nDomain artifacts: [domain log](${domainUrl})\n`;
const pullRequestWith = (body: string) =>
  ({
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
  }) as unknown as PullRequestRecord;
const pullRequest = pullRequestWith(evidenceBody(logsRow));
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
const urlOf = (input: unknown) =>
  input instanceof Request ? input.url : String(input);

describe("evidence artifact transport failures", () => {
  test("verified artifact keeps a complete status", async () => {
    const result = await verifyPullRequestEvidence([pullRequest], {
      ...options,
      evidenceFetch: async () => ok(),
    });
    expect(result.status).toBe("complete");
    expect(result.artifacts.map(({ category }) => category)).toEqual(["logs"]);
  });

  for (const [name, fail] of Object.entries(failures)) {
    test(`persistent ${name} fails evidence collection`, async () => {
      let calls = 0;
      const verification = verifyPullRequestEvidence([pullRequest], {
        ...options,
        evidenceFetch: (async (_url: unknown, init?: RequestInit) => {
          calls += 1;
          return await fail(init);
        }) as never,
      });
      await expect(verification).rejects.toBeInstanceOf(
        EvidenceUnavailableError,
      );
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
    expect(calls).toBe(2);
    expect(result.status).toBe("complete");
    expect(result.artifacts.map(({ category }) => category)).toEqual(["logs"]);
  });

  test("invalid evidence (HTTP 404) removes the bonus without retry", async () => {
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

  test("a transient sibling never refetches or accepts a 404 artifact", async () => {
    // Attempt 1: logs artifact 404, domain artifact 503. Later fetches of
    // either artifact would return 200.
    const calls = new Map<string, number>();
    const result = await verifyPullRequestEvidence(
      [pullRequestWith(evidenceBody(`${logsRow}${domainRow}`))],
      {
        ...options,
        evidenceFetch: async (input) => {
          const url = urlOf(input);
          const count = (calls.get(url) ?? 0) + 1;
          calls.set(url, count);
          if (count > 1) return ok();
          return url === logsUrl
            ? new Response("missing", { status: 404 })
            : new Response("busy", { status: 503 });
        },
      },
    );
    expect(calls.get(logsUrl)).toBe(1);
    expect(calls.get(domainUrl)).toBe(2);
    expect(result.status).toBe("complete");
    expect(result.artifacts.map(({ category }) => category)).toEqual([
      "domain-artifact",
    ]);
  });

  test("a 404 next to a persistent 503 still fails collection", async () => {
    const calls = new Map<string, number>();
    const verification = verifyPullRequestEvidence(
      [pullRequestWith(evidenceBody(`${logsRow}${domainRow}`))],
      {
        ...options,
        evidenceFetch: async (input) => {
          const url = urlOf(input);
          calls.set(url, (calls.get(url) ?? 0) + 1);
          return url === logsUrl
            ? new Response("missing", { status: 404 })
            : new Response("busy", { status: 503 });
        },
      },
    );
    await expect(verification).rejects.toThrow(domainUrl);
    expect(calls.get(logsUrl)).toBe(1);
    expect(calls.get(domainUrl)).toBe(3);
  });
});

describe("unavailable evidence stops collection and publication", () => {
  test("the open-set retry boundary does not swallow the failure", async () => {
    let attempts = 0;
    const collection = retrySlopSnapshot(async () => {
      attempts += 1;
      return await verifyPullRequestEvidence([pullRequest], {
        ...options,
        evidenceFetch: async () => new Response("busy", { status: 503 }),
      });
    });
    await expect(collection).rejects.toBeInstanceOf(EvidenceUnavailableError);
    expect(attempts).toBe(1);
  });

  test("the generator writes nothing and keeps the last snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slop-evidence-"));
    const outputPath = join(directory, "leaderboard.json");
    const lastCompleteSnapshot = '{"last":"complete"}\n';
    await writeFile(outputPath, lastCompleteSnapshot);
    let generated = 0;
    let writes = 0;
    try {
      const run = runGenerator(
        outputPath,
        {
          getToken: async () => "token",
          createClient: () => ({}) as never,
          // The same evidence step that generateLeaderboardFromGitHub runs
          // before it builds a scored snapshot.
          generate: async (_client, generationOptions) => {
            await verifyPullRequestEvidence([pullRequest], generationOptions);
            generated += 1;
            return {} as LeaderboardSnapshot;
          },
          write: async (snapshot, path) => {
            writes += 1;
            await writeLeaderboardAtomically(snapshot, path);
          },
        },
        {
          ...options,
          evidenceFetch: async () => new Response("busy", { status: 503 }),
        },
      );
      await expect(run).rejects.toBeInstanceOf(EvidenceUnavailableError);
      expect(generated).toBe(0);
      expect(writes).toBe(0);
      expect(await readFile(outputPath, "utf8")).toBe(lastCompleteSnapshot);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
