import { expect, test } from "bun:test";
import { TARGET_REPOSITORIES } from "../src/lib/repositories.mjs";
import {
  collectSearchReferences,
  type GraphqlExecutor,
} from "./generate-leaderboard";

const repository = TARGET_REPOSITORIES[0];
const from = new Date("2026-10-01T00:00:00.000Z");
const to = new Date("2026-10-03T00:00:00.000Z");
const info = (hasNextPage: boolean, endCursor: string | null) => ({
  hasNextPage,
  endCursor,
});
const commit = (index: number) => ({
  commit: { oid: index.toString(16).padStart(40, "0"), author: null },
});
function outcome(index: number) {
  return {
    __typename: "PullRequest",
    id: `PR_${index}`,
    state: "MERGED",
    number: index + 1,
    title: "Fixture outcome",
    url: `https://github.com/${repository.owner}/${repository.name}/pull/${index + 1}`,
    body: "x".repeat(1024),
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    mergedAt: "2026-10-02T00:00:00.000Z",
    author: null,
    additions: 1,
    deletions: 0,
    baseRefName: repository.integrationBranch,
    baseRefOid: "a".repeat(40),
    headRefOid: "b".repeat(40),
    commits: {
      totalCount: 1,
      pageInfo: info(false, null),
      nodes: [commit(index + 1)],
    },
  };
}
function executor(execute: GraphqlExecutor["execute"]): GraphqlExecutor {
  return {
    execute,
    getRequestCount: () => 0,
    getRateLimit: () => ({
      cost: 0,
      consumedDuringRun: 0,
      limit: 5000,
      remaining: 5000,
      resetAt: "2026-10-16T00:00:00.000Z",
    }),
  };
}

async function collect(client: GraphqlExecutor) {
  return collectSearchReferences(
    client,
    repository,
    from,
    to,
    "merged",
    "is:pr is:merged",
    "PullRequest",
    { searchSliceCount: 0 },
  );
}

test("recover the observed 925-of-926 cursor gap only with a complete 926-record union", async () => {
  const rows = await collect(
    executor(async (_document, variables = {}) => {
      const root = String(variables.searchQuery).endsWith(
        "2026-10-01T00:00:00.000Z..2026-10-02T23:59:59.000Z",
      );
      const left = String(variables.searchQuery).includes(
        "merged:2026-10-01T00:00:00.000Z",
      );
      const count = root ? 926 : 463;
      const offset = Number(variables.after ?? 0);
      const end = Math.min(count, offset + Number(variables.pageSize));
      return {
        search: {
          issueCount: count,
          pageInfo: info(end < count, end < count ? String(end) : null),
          nodes: Array.from({ length: end - offset }, (_, i) =>
            outcome(
              root && offset + i === 925
                ? 924
                : offset + i + (root || left ? 0 : 463),
            ),
          ),
        },
      };
    }),
  );
  expect(rows).toHaveLength(926);
  expect(new Set(rows.map((row) => row.id)).size).toBe(926);
  expect(rows.every((row) => row.outcome?.commits?.length === 1)).toBe(true);
});

test("narrow ranges cannot hide the missing parent record", async () => {
  const client = executor(async (_document, variables = {}) => {
    const root = String(variables.searchQuery).endsWith(
      "2026-10-01T00:00:00.000Z..2026-10-02T23:59:59.000Z",
    );
    const left = String(variables.searchQuery).includes(
      "merged:2026-10-01T00:00:00.000Z",
    );
    const count = root ? 3 : left ? 1 : 1;
    const nodes = root
      ? [outcome(0), outcome(0), outcome(1)]
      : [outcome(left ? 0 : 1)];
    return {
      search: { issueCount: count, pageInfo: info(false, null), nodes },
    };
  });
  await expect(collect(client)).rejects.toThrow("parent reported 3");
});

test("a changing count still rejects instead of recovering a different snapshot", async () => {
  const client = executor(async (_document, variables = {}) => ({
    search: {
      issueCount: variables.after ? 4 : 3,
      pageInfo: info(!variables.after, variables.after ? null : "next"),
      nodes: [outcome(0)],
    },
  }));
  await expect(collect(client)).rejects.toThrow("changed from 3 to 4");
});

test("persistent missing records cannot recurse below the minimum range", async () => {
  let reads = 0;
  const client = executor(async () => {
    reads++;
    return {
      search: {
        issueCount: 2,
        pageInfo: info(false, null),
        nodes: [outcome(0)],
      },
    };
  });
  await expect(collect(client)).rejects.toThrow("refusing a snapshot");
  expect(reads).toBeLessThan(20);
});
