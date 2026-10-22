/**
 * The escrow review clock starts from the merged PR that published the cycle
 * on the canonical branch. Cycles publish through reviewed PRs into `main`;
 * the temporary `develop` compatibility branch has no authority.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProject } from "../src/lib/projects.mjs";
import { verifyEscrowReview } from "./escrow-review";

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const project = findProject("eliza");
if (!project) throw new Error("fixture project eliza is missing");
const proposal = {
  projectId: "eliza",
  cycleId: "2026-09",
  grossCapMicro: "0",
  awards: [] as {
    githubUserId: string;
    grossMicro: string;
    sourceDigest: string;
  }[],
};
const proposalBytes = Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`);
const files: Record<string, Buffer> = {
  "source-snapshot.json": Buffer.from('{"snapshot":true}\n'),
  "github-identities.json": Buffer.from("[]\n"),
  "project.json": Buffer.from(`${JSON.stringify(project, null, 2)}\n`),
  "proposal.json": proposalBytes,
  "decisions.json": Buffer.from(
    `${JSON.stringify(
      { schemaVersion: "1", proposalSha256: sha256(proposalBytes), rows: [] },
      null,
      2,
    )}\n`,
  ),
};
const prefix = "cycles/eliza/2026-09/escrow-v2";
const commit = "a".repeat(40);
const mergedAt = "2026-10-01T00:00:00Z";
const originalFetch = globalThis.fetch;
const queriedBranches: string[] = [];
let directory: string;

/** GitHub as it looks after PR 900 published the cycle by merging into `base`. */
function githubPublishedInto(base: string): typeof fetch {
  const published = (ref: string | null) => ref === base || ref === commit;
  return (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname.replace("/repos/SlopDotCash/slopdotcash/", "");
    if (path === "commits") {
      const branch = url.searchParams.get("sha") ?? "";
      queriedBranches.push(branch);
      return Response.json(branch === base ? [{ sha: commit }] : []);
    }
    const contents = /^contents\/(.+)$/.exec(path);
    if (contents) {
      const name = decodeURIComponent(contents[1]).replace(`${prefix}/`, "");
      const bytes = files[name];
      if (!bytes || !published(url.searchParams.get("ref")))
        return new Response("Not Found", { status: 404 });
      return new Response(new Uint8Array(bytes));
    }
    if (path === `commits/${commit}/pulls`)
      return Response.json([
        {
          number: 900,
          merged_at: mergedAt,
          merge_commit_sha: commit,
          head: { sha: commit },
          state: "closed",
          base: { ref: base, repo: { full_name: "SlopDotCash/slopdotcash" } },
        },
      ]);
    if (path.startsWith("compare/"))
      return Response.json({ status: "identical" });
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "escrow-review-publication-"));
  for (const [name, bytes] of Object.entries(files))
    writeFileSync(join(directory, name), bytes);
  queriedBranches.length = 0;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(directory, { recursive: true, force: true });
});

const review = () =>
  verifyEscrowReview({
    directory,
    proposal,
    proposalSha256: sha256(proposalBytes),
    stewardActorId: project.steward.github.actorId,
    now: new Date("2026-10-20T00:00:00Z"),
    token: "fixture-token",
  });

test("a cycle published by a PR merged into main starts the review clock", async () => {
  globalThis.fetch = githubPublishedInto("main");
  const result = await review();
  expect(result.reviewEndsAt).toBe("2026-10-15T00:00:00.000Z");
  expect(new Set(queriedBranches)).toEqual(new Set(["main"]));
});

test.each(["develop", "development"])(
  "a cycle merged only into %s has no production review clock",
  async (branch) => {
    globalThis.fetch = githubPublishedInto(branch);
    await expect(review()).rejects.toThrow("Publication commit unavailable");
  },
);
