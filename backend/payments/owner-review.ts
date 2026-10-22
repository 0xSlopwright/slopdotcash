import { readBoundedJson, readBoundedText } from "../../src/lib/browser-json";
import { validateEscrowCycle } from "../../src/lib/payments/escrow-cycle";
import { resolveEscrowIdentities } from "../../src/lib/payments/escrow-identities";
import {
  assertEscrowDecisions,
  assertEscrowFinancialPolicy,
  ESCROW_PUBLICATION_BRANCH,
  EscrowReviewPendingError,
  verifyEscrowReview,
} from "../../src/lib/payments/escrow-review";
import type {
  GithubActor,
  ProjectRecord,
} from "../../src/lib/project-contracts";
import { assertProjectDefinition } from "../../src/lib/project-schema.mjs";
import { SOURCE_REPOSITORY } from "../../src/lib/source-repository";

const repository = new URL(SOURCE_REPOSITORY).pathname.slice(1);
const text = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
export class OwnerAwardReviewError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Public frozen evidence only; this does not approve, reserve, sign or send. */
export async function reviewOwnerAwards(input: {
  project: ProjectRecord;
  cycleId: string;
  actor: GithubActor;
  token?: string;
  now: Date;
}) {
  const { project: record, actor, cycleId } = input;
  const project = assertProjectDefinition(record.manifest);
  if (
    project.steward.github.type === "User" &&
    actor.githubId !== project.steward.github.actorId
  )
    throw new OwnerAwardReviewError(
      403,
      "Only the current project steward can review owner awards.",
    );
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(cycleId) || !project.escrow)
    throw new OwnerAwardReviewError(404, "No vault award cycle is available.");
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Slop-owner-review",
    ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
  };
  async function github(path: string, raw = false) {
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: {
        ...headers,
        ...(raw ? { accept: "application/vnd.github.raw+json" } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404)
      throw new OwnerAwardReviewError(
        404,
        "The published cycle record is not available.",
      );
    if (!response.ok)
      throw new OwnerAwardReviewError(
        503,
        "GitHub review evidence is unavailable. Retry.",
      );
    return response;
  }
  // A stored steward ID is not current GitHub approval authority.
  const target = project.repositories[0].id;
  const repositoryIdentity = (await readBoundedJson(
    await github(`repos/${target}`),
    1048576,
    "Project repository identity",
  )) as {
    id?: number;
    node_id?: string;
    owner?: { id?: number; node_id?: string; login?: string; type?: string };
  };
  const steward = project.steward.github;
  if (
    String(repositoryIdentity.id) !== project.authority.repositoryId ||
    repositoryIdentity.node_id !== project.authority.repositoryNodeId ||
    String(repositoryIdentity.owner?.id) !== steward.actorId ||
    repositoryIdentity.owner?.node_id !== steward.nodeId ||
    repositoryIdentity.owner?.type !== steward.type ||
    repositoryIdentity.owner?.login?.toLowerCase() !==
      steward.login.toLowerCase()
  )
    throw new OwnerAwardReviewError(
      409,
      "The GitHub repository identity differs from the project policy.",
    );
  const permission = (await readBoundedJson(
    await github(
      `repos/${target}/collaborators/${encodeURIComponent(actor.githubLogin)}/permission`,
    ),
    65536,
    "GitHub owner authority",
  )) as { permission?: string; user?: { id?: number } };
  if (
    !permission.permission ||
    !["admin", "maintain", "write"].includes(permission.permission) ||
    String(permission.user?.id) !== actor.githubId
  )
    throw new OwnerAwardReviewError(
      403,
      "Current GitHub maintainer authority could not be verified.",
    );
  const head = (await readBoundedJson(
    await github(`repos/${repository}/commits/${ESCROW_PUBLICATION_BRANCH}`),
    1048576,
    "Canonical review revision",
  )) as { sha?: string };
  if (!head.sha || !/^[a-f0-9]{40}$/.test(head.sha))
    throw new OwnerAwardReviewError(
      503,
      "The canonical review revision is unavailable.",
    );
  const prefix = `cycles/${project.id}/${cycleId}/escrow-v2`;
  const archive = new Map<string, Promise<Uint8Array>>();
  const readArchive = (name: string) => {
    if (
      ![
        "source-snapshot.json",
        "github-identities.json",
        "project.json",
        "proposal.json",
        "decisions.json",
        "platform-approvals.json",
      ].includes(name)
    )
      throw new Error("Unknown cycle artifact");
    let bytes = archive.get(name);
    if (!bytes) {
      bytes = (async () =>
        new TextEncoder().encode(
          await readBoundedText(
            await github(
              `repos/${repository}/contents/${prefix}/${name}?ref=${head.sha}`,
              true,
            ),
            32 * 1024 * 1024,
            "Published cycle artifact",
          ),
        ))();
      archive.set(name, bytes);
    }
    return bytes;
  };
  const verified = await validateEscrowCycle(readArchive, project.id, cycleId);
  const archived = assertProjectDefinition(
    JSON.parse(text(await readArchive("project.json"))),
  );
  assertEscrowFinancialPolicy(project, archived);
  let decisions: ReturnType<typeof assertEscrowDecisions> | null = null;
  try {
    decisions = assertEscrowDecisions(
      JSON.parse(text(await readArchive("decisions.json"))),
      verified.proposal,
      verified.digest,
      [project.steward.github.actorId, archived.steward.github.actorId],
    );
  } catch (error) {
    if (!(error instanceof OwnerAwardReviewError && error.status === 404))
      throw error;
  }
  let review: Awaited<ReturnType<typeof verifyEscrowReview>> | null = null;
  let reviewEndsAt: string | null = null;
  let blockedReason: string | null = decisions
    ? null
    : "Publish the award decisions on GitHub to begin their review.";
  if (decisions) {
    try {
      review = await verifyEscrowReview({
        repository,
        readArchive,
        proposal: verified.proposal,
        proposalSha256: verified.digest,
        stewardActorId: project.steward.github.actorId,
        now: input.now,
        token: input.token,
      });
      reviewEndsAt = review.reviewEndsAt;
    } catch (error) {
      if (error instanceof EscrowReviewPendingError) {
        reviewEndsAt = error.reviewEndsAt;
        blockedReason =
          "The published decisions are still in their 14-day review period.";
      } else {
        blockedReason =
          "Published approval could not be verified. Check the cycle review on GitHub, then retry.";
      }
    }
  }
  return {
    projectId: project.id,
    cycleId,
    projectRevision: record.revision,
    manifestSha256: record.manifestSha256,
    sourceCommit: head.sha,
    sourceUrl: `${SOURCE_REPOSITORY}/tree/${head.sha}/${prefix}`,
    proposalSha256: verified.digest,
    proposal: verified.proposal,
    asset: archived.rewardAsset ?? null,
    deployments: project.escrow.deployments,
    decisions,
    review,
    reviewEndsAt,
    blockedReason,
    // A successful public review is not current funding or wallet authorization.
    reviewVerified: review !== null,
  };
}

export interface OwnerCommitmentInput {
  network: string;
  githubUserId: string;
  proposalSha256: string;
  decisionsSha256: string;
  manifestSha256: string;
}

/** Rechecks the exact published decision; the owner still signs in their wallet. */
export async function prepareOwnerCommitment(
  input: Parameters<typeof reviewOwnerAwards>[0],
  expected: OwnerCommitmentInput,
) {
  const project = input.project.manifest;
  if (project.status !== "active" || project.reward.paymentMode !== "enabled")
    throw new OwnerAwardReviewError(
      409,
      "This project is not enabled for new award commitments.",
    );
  const current = await reviewOwnerAwards(input);
  if (!current.reviewVerified || !current.review || !current.decisions)
    throw new OwnerAwardReviewError(
      409,
      current.blockedReason ?? "The award review is incomplete.",
    );
  if (
    current.manifestSha256 !== expected.manifestSha256 ||
    current.proposalSha256 !== expected.proposalSha256 ||
    current.review.decisionsSha256 !== expected.decisionsSha256
  )
    throw new OwnerAwardReviewError(
      409,
      "The project or reviewed awards changed. Reload the review before authorizing funds.",
    );
  const deployment = project.escrow?.deployments.find(
    (entry) => entry.network === expected.network,
  );
  if (!deployment)
    throw new OwnerAwardReviewError(
      409,
      "The selected vault is no longer in the project policy.",
    );
  const source = current.proposal.awards.find(
    (entry) => entry.githubUserId === expected.githubUserId,
  );
  const decision = current.decisions.rows.find(
    (entry) => entry.githubUserId === expected.githubUserId,
  );
  if (
    !source ||
    !decision ||
    decision.state !== "approved" ||
    BigInt(decision.approvedGrossMicro) <= 0n
  )
    throw new OwnerAwardReviewError(
      409,
      "This award is not approved for commitment.",
    );
  const identities = await resolveEscrowIdentities(
    [source.githubNodeId],
    input.token ?? "",
  );
  if (identities[0]?.githubUserId !== source.githubUserId)
    throw new OwnerAwardReviewError(
      409,
      "The contributor's GitHub identity no longer matches the reviewed award.",
    );
  const gross = BigInt(decision.approvedGrossMicro);
  return {
    schemaVersion: "1" as const,
    projectId: project.id,
    cycleId: input.cycleId,
    manifestSha256: current.manifestSha256,
    proposalSha256: current.proposalSha256,
    decisionsSha256: current.review.decisionsSha256,
    deployment,
    award: {
      githubUserId: source.githubUserId,
      login: identities[0].login,
      sourceDigest: source.sourceDigest,
      gross: gross.toString(),
      fee: (gross / 50n).toString(),
      net: (gross - gross / 50n).toString(),
    },
  };
}
