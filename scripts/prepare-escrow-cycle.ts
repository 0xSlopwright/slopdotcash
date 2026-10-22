import type { EscrowIdentity } from "../src/lib/payments/escrow-cycle";
import { resolveEscrowIdentities as resolveLiveEscrowIdentities } from "../src/lib/payments/escrow-identities";

export type { EscrowIdentity } from "../src/lib/payments/escrow-cycle";

import {
  buildEscrowCycle as buildArchivedEscrowCycle,
  validateEscrowCycle as validateArchivedEscrowCycle,
} from "../src/lib/payments/escrow-cycle";

export { escrowAwardOrigin } from "../src/lib/payments/escrow-cycle";

/** Generate source-bound gross proposals. This command neither approves nor signs. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertPublishableLeaderboardSnapshot } from "../src/lib/leaderboard";
import { createPaymentProjectView } from "../src/lib/project-view";
import { findProject } from "../src/lib/projects.mjs";
import { resolveGitHubToken } from "./github-token";
import { currentProjectPolicy } from "./project-revision-policy.mjs";
import { writeNewFile, writeNewJsonFile } from "./write-new-file";

export async function resolveEscrowIdentities(
  nodeIds: string[],
  token?: string,
): Promise<EscrowIdentity[]> {
  return resolveLiveEscrowIdentities(
    nodeIds,
    token ?? (await resolveGitHubToken()),
  );
}

export function buildEscrowCycle(
  ...args: Parameters<typeof buildArchivedEscrowCycle>
) {
  if (!findProject(args[0].projectId))
    throw new Error("Archived project is not canonical");
  return buildArchivedEscrowCycle(...args);
}

export async function prepareEscrowCycle(input: {
  projectId: string;
  cycleId: string;
  snapshotPath: string;
  generatedAt?: string;
  githubToken?: string;
}) {
  const bytes = await readFile(input.snapshotPath);
  const snapshot: unknown = JSON.parse(bytes.toString("utf8"));
  assertPublishableLeaderboardSnapshot(snapshot);
  const view = createPaymentProjectView(
    snapshot,
    input.projectId,
    input.cycleId,
  );
  const identities = await resolveEscrowIdentities(
    view.leaders.map((leader) => leader.actor.id),
    input.githubToken,
  );
  if (!findProject(input.projectId)) throw new Error("Unknown project");
  // The archived policy is the exact current D1 revision, so the proposal's
  // projectPolicySha256 equals that revision's public manifestSha256.
  const { bytes: policyBytes } = await currentProjectPolicy(
    process.cwd(),
    input.projectId,
  );
  const identityBytes = Buffer.from(`${JSON.stringify(identities, null, 2)}\n`);
  const proposal = buildEscrowCycle(
    { ...input, generatedAt: input.generatedAt ?? new Date().toISOString() },
    bytes,
    identityBytes,
    policyBytes,
  );
  // Versioned paths cannot be consumed accidentally by legacy Solana settlement.
  const directory = resolve(
    "cycles",
    input.projectId,
    input.cycleId,
    "escrow-v2",
  );
  await writeNewFile(
    resolve(directory, "source-snapshot.json"),
    bytes,
    "Snapshot already exists; inspect partial or existing cycle",
  );
  await writeNewFile(
    resolve(directory, "github-identities.json"),
    identityBytes,
    "Identity archive already exists",
  );
  await writeNewFile(
    resolve(directory, "project.json"),
    policyBytes,
    "Project policy archive already exists",
  );
  await writeNewJsonFile(
    resolve(directory, "proposal.json"),
    proposal,
    "Proposal already exists; preserve review history",
  );
  return proposal;
}

export async function validateEscrowCycle(
  directory: string,
  projectId: string,
  cycleId: string,
) {
  if (!findProject(projectId))
    throw new Error("Archived project is not canonical");
  return validateArchivedEscrowCycle(
    (name) => readFile(resolve(directory, name)),
    projectId,
    cycleId,
  );
}

if (import.meta.main) {
  const [projectId, cycleId, snapshotPath, ...extra] = process.argv.slice(2);
  if (!projectId || !cycleId || !snapshotPath || extra.length)
    throw new Error(
      "Usage: bun scripts/prepare-escrow-cycle.ts PROJECT YYYY-MM SNAPSHOT",
    );
  await prepareEscrowCycle({ projectId, cycleId, snapshotPath });
}
