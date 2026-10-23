import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertEscrowFinancialPolicy,
  verifyEscrowReview as verifyPublishedEscrowReview,
} from "../src/lib/payments/escrow-review";
import { assertProjectDefinition } from "../src/lib/project-schema.mjs";
import { currentProjectPolicy } from "./project-revision-policy.mjs";

export type {
  EscrowDecision,
  EscrowDecisions,
  EscrowReviewProposal,
  Publication,
} from "../src/lib/payments/escrow-review";
export { assertEscrowDecisions } from "../src/lib/payments/escrow-review";

/** Trust root is the repository of this checked-out application, not a caller-supplied URL. */
function repository(): string {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
  }).trim();
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      remote,
    );
  if (!match) throw new Error("Canonical GitHub origin required");
  return match[1];
}
export async function verifyEscrowReview(
  input: Omit<
    Parameters<typeof verifyPublishedEscrowReview>[0],
    "repository" | "readArchive"
  > & { directory: string },
) {
  return verifyPublishedEscrowReview({
    ...input,
    repository: repository(),
    readArchive: (name) => readFile(resolve(input.directory, name)),
  });
}

export async function verifyCurrentEscrowDeployment(input: {
  projectId: string;
  currentProject: unknown;
  archiveDirectory: string;
  root?: string;
}): Promise<{ url: string; revision: number; sha256: string }> {
  const {
    project: current,
    revision,
    manifestSha256,
    bytes,
  } = await currentProjectPolicy(input.root ?? process.cwd(), input.projectId);
  if (
    current.id !== input.projectId ||
    !isDeepStrictEqual(current, input.currentProject)
  )
    throw new Error(
      "Generated registry differs from the current canonical project manifest",
    );
  const archived = assertProjectDefinition(
    JSON.parse(
      await readFile(resolve(input.archiveDirectory, "project.json"), "utf8"),
    ),
  );
  assertEscrowFinancialPolicy(current, archived);
  // The registry is the policy authority. An immutable revision alone does
  // not prove it is still current, so also compare the live project pointer.
  const projectUrl = `https://slop.cash/api/v1/projects/${encodeURIComponent(input.projectId)}`;
  const url = `https://slop.cash/api/v1/project-revisions/${encodeURIComponent(input.projectId)}/${revision}`;
  const readRegistry = async (endpoint: string) => {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        `Current project evidence unavailable (${response.status})`,
      );
    return response.json();
  };
  const [live, immutable] = await Promise.all([
    readRegistry(projectUrl),
    readRegistry(url),
  ]);
  if (
    live.schemaVersion !== "1" ||
    live.revision !== revision ||
    live.manifestSha256 !== manifestSha256 ||
    !isDeepStrictEqual(live.project, current) ||
    immutable.schemaVersion !== "1" ||
    immutable.projectId !== input.projectId ||
    immutable.revision !== revision ||
    immutable.manifestSha256 !== manifestSha256 ||
    typeof immutable.manifestText !== "string" ||
    !Buffer.from(immutable.manifestText, "utf8").equals(bytes)
  )
    throw new Error(
      "Current D1 project revision differs from the synced policy",
    );
  return { url, revision, sha256: manifestSha256 };
}
