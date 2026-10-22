/** Source scope for SCR-06 joint outcomes. No model may supply credit actors.
 * Commit/path claims are shared across PR carriers before they are valued.
 * This is evidence preparation, not journal publication or payout approval.
 */
import { isCreditEligibleCommitAuthor } from "../../src/lib/commit-credit";
import {
  REGISTERED_REPOSITORIES,
  type TargetRepository,
} from "../../src/lib/repositories.mjs";
import { sha256Hex } from "./github";
import {
  type ValueEvidence,
  valueEvidenceMatchesRepository,
} from "./value-evidence";
import { valueSourceDigest } from "./value-review";

export interface WorkUnitSource {
  evidence: ValueEvidence;
  policy: { sha: string; text: string };
}

export interface WorkUnitClaim {
  id: string;
  repositoryNodeId: string;
  commitSha: string;
  path: string;
  carrierPullRequestIds: string[];
  creditPullRequestId: string;
  implementationActorNodeIds: string[];
}

export interface WorkUnitEvidence {
  projectId: string;
  sources: WorkUnitSource[];
  sourceDigests: { pullRequestNodeId: string; digest: string }[];
  claims: WorkUnitClaim[];
  limitations: string[];
  sourceDigest: string;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ordered = (values: Iterable<string>) =>
  [...new Set(values)].sort(compare);

/** Source order and collection timestamps do not create new evidence revisions.
 * The caller must collect every carrier needed to resolve overlap. This function
 * never infers completeness of a project census from the supplied PR subset.
 * Historical callers may supply a validated D1 registry; source policy fields
 * must match it and cannot grant themselves a project or attribution rule.
 */
export async function prepareWorkUnitEvidence(
  input: readonly WorkUnitSource[],
  repositories: readonly TargetRepository[] = REGISTERED_REPOSITORIES,
): Promise<WorkUnitEvidence> {
  if (input.length === 0) throw new Error("Joint value sources are missing");
  const sources = [...input].sort((a, b) =>
    compare(a.evidence.pull.node_id, b.evidence.pull.node_id),
  );
  const ids = new Set<string>();
  const projects = new Set<string>();
  const limitations = new Set<string>();
  const sourceDigests: WorkUnitEvidence["sourceDigests"] = [];
  const commits = new Map<string, string>();
  const importedPaths: { sourceId: string; originId: string; path: string }[] =
    [];
  const claims = new Map<
    string,
    {
      repositoryNodeId: string;
      commitSha: string;
      path: string;
      carriers: {
        source: WorkUnitSource;
        occurredAt: number;
        actorNodeIds: string[];
      }[];
    }
  >();
  for (const source of sources) {
    const { evidence, policy } = source;
    const { pull } = evidence;
    const repository = repositories.find((entry) =>
      [entry.id, ...entry.aliases].some(
        (id) => id.toLowerCase() === evidence.repository.toLowerCase(),
      ),
    );
    if (
      !repository ||
      !valueEvidenceMatchesRepository(evidence, repository) ||
      ids.has(pull.node_id) ||
      pull.state !== "closed" ||
      !Number.isFinite(Date.parse(pull.merged_at ?? pull.closed_at ?? "")) ||
      policy.sha !== pull.base.sha ||
      !/^[a-f0-9]{40}$/u.test(policy.sha) ||
      !policy.text.trim()
    )
      throw new Error(
        "Joint value source identity, policy or occurrence is invalid",
      );
    ids.add(pull.node_id);
    projects.add(repository.projectId);
    for (const limitation of evidence.limitations)
      limitations.add(`${pull.node_id}: ${limitation}`);
    sourceDigests.push({
      pullRequestNodeId: pull.node_id,
      digest: await valueSourceDigest(evidence, policy),
    });
    // A closed PR may have been accepted through an integration branch. Its
    // historical scope is independently proved; never rewrite merged_at.
    const indirect = evidence.indirectAcceptance;
    const acceptedAt = pull.merged_at ?? indirect?.observedOnBranchAt;
    if (acceptedAt === undefined) continue;
    const mergedAt = Date.parse(acceptedAt);
    const acceptedFiles = indirect?.integrationFiles ?? evidence.files;
    const changedPaths = new Set(
      acceptedFiles.flatMap((file) => [
        file.filename,
        ...(file.previous_filename ? [file.previous_filename] : []),
      ]),
    );
    const covered = new Set<string>();
    for (const commit of evidence.commits.filter(
      (entry) =>
        entry.parents.length <= 1 &&
        (!indirect || indirect.acceptedCommitShas.includes(entry.sha)),
    )) {
      const attribution = evidence.commitAttribution.filter(
        (entry) => entry.sha === commit.sha,
      );
      if (
        attribution.length !== 1 ||
        attribution[0].changedPaths === null ||
        attribution[0].limitations.length > 0
      ) {
        limitations.add(
          `${pull.node_id}: complete commit scope is missing for ${commit.sha}`,
        );
        continue;
      }
      const paths = ordered(attribution[0].changedPaths);
      // The same immutable commit cannot have different paths or primary author
      // merely because it appears in a different PR's listing.
      const commitKey = JSON.stringify([evidence.repositoryNodeId, commit.sha]);
      const identity = JSON.stringify([paths, commit.author, commit.parents]);
      if (commits.has(commitKey) && commits.get(commitKey) !== identity)
        throw new Error("Joint sources disagree about an immutable commit");
      commits.set(commitKey, identity);
      // A squash commit can reappear in a later PR after a branch sync. Its
      // original PR already supplies implementation claims; importing it must
      // not create a second identity or add the later PR author to its credit.
      const origins = sources.filter(
        ({ evidence: origin }) =>
          origin.repositoryNodeId === evidence.repositoryNodeId &&
          origin.pull.node_id !== pull.node_id &&
          origin.pull.merge_commit_sha === commit.sha &&
          origin.mergeCommitEvidence?.sha === commit.sha &&
          origin.mergeCommitEvidence.parents.length === 1 &&
          origin.pull.merged_at !== null &&
          Date.parse(origin.pull.merged_at) < mergedAt,
      );
      if (
        origins.length > 0 ||
        evidence.acceptedRange?.parentSha === commit.sha
      ) {
        for (const path of paths.filter((path) => changedPaths.has(path))) {
          covered.add(path);
          if (
            origins.length !== 1 ||
            origins[0].evidence.limitations.length > 0
          ) {
            limitations.add(
              `${pull.node_id}: imported squash ${commit.sha} needs one complete original PR source`,
            );
          } else {
            importedPaths.push({
              sourceId: pull.node_id,
              originId: origins[0].evidence.pull.node_id,
              path,
            });
          }
        }
        continue;
      }
      const actors = new Set<string>();
      if (pull.user.type !== "Bot") actors.add(pull.user.node_id);
      if (
        pull.base.ref === repository.integrationBranch &&
        commit.author &&
        isCreditEligibleCommitAuthor({
          id: commit.author.node_id,
          kind: commit.author.type,
        })
      )
        actors.add(commit.author.node_id);
      for (const path of paths) {
        if (!changedPaths.has(path)) continue;
        covered.add(path);
        const key = JSON.stringify([
          evidence.repositoryNodeId,
          commit.sha,
          path,
        ]);
        const claim = claims.get(key) ?? {
          repositoryNodeId: evidence.repositoryNodeId,
          commitSha: commit.sha,
          path,
          carriers: [],
        };
        claim.carriers.push({
          source,
          occurredAt: mergedAt,
          actorNodeIds: ordered(actors),
        });
        claims.set(key, claim);
      }
    }
    for (const path of changedPaths)
      if (!covered.has(path))
        limitations.add(
          `${pull.node_id}: accepted file has no complete non-merge commit scope: ${path}`,
        );
  }
  if (projects.size !== 1)
    throw new Error("A joint value assessment must belong to one project");
  const prepared: WorkUnitClaim[] = [];
  for (const [key, claim] of claims) {
    const carriers = [...claim.carriers].sort(
      (a, b) =>
        a.occurredAt - b.occurredAt ||
        compare(a.source.evidence.pull.node_id, b.source.evidence.pull.node_id),
    );
    const first = carriers[0];
    prepared.push({
      id: await sha256Hex(key),
      repositoryNodeId: claim.repositoryNodeId,
      commitSha: claim.commitSha,
      path: claim.path,
      carrierPullRequestIds: ordered(
        carriers.map(({ source }) => source.evidence.pull.node_id),
      ),
      creditPullRequestId: first.source.evidence.pull.node_id,
      implementationActorNodeIds: first.actorNodeIds,
    });
  }
  for (const imported of importedPaths) {
    if (
      !prepared.some(
        (claim) =>
          claim.path === imported.path &&
          claim.carrierPullRequestIds.includes(imported.originId),
      )
    ) {
      limitations.add(
        `${imported.sourceId}: original squash source does not cover ${imported.path}`,
      );
    }
  }
  prepared.sort((a, b) => compare(a.id, b.id));
  const projectId = [...projects][0];
  const problems = ordered(limitations);
  return {
    projectId,
    sources,
    sourceDigests,
    claims: prepared,
    limitations: problems,
    sourceDigest: await sha256Hex(
      JSON.stringify({
        version: "slop-work-unit-evidence:v1",
        projectId,
        sourceDigests,
        claims: prepared,
        limitations: problems,
      }),
    ),
  };
}

/** A complete partition assigns each immutable claim once. Multiple claims in
 * one PR may belong to different outcomes; multiple PRs may share one outcome.
 */
export function validateWorkUnitPartition(
  evidence: WorkUnitEvidence,
  units: readonly { claimIds: readonly string[] }[],
): boolean {
  if (evidence.limitations.length > 0) return false;
  const available = new Set(evidence.claims.map((claim) => claim.id));
  const consumed = new Set<string>();
  for (const unit of units) {
    if (unit.claimIds.length === 0) return false;
    for (const id of unit.claimIds) {
      if (!available.has(id) || consumed.has(id)) return false;
      consumed.add(id);
    }
  }
  return consumed.size === available.size;
}
