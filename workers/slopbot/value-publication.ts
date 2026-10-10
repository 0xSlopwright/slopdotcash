// Internal publication boundary. The hosted consumer supplies the installation
// identity and deployed producer revision; neither comes from model output.
import type { Job } from "./contracts";
import { GitHubClient } from "./github";
import { type D1Database, installation } from "./persistence";
import { loadPolicy, type ReviewEnv } from "./review";
import { readValueDecision } from "./value-consumption";
import {
  collectValueEvidence,
  type EvidenceClient,
  type ValueEvidence,
} from "./value-evidence";
import { appendValueRecord, prepareValueRecord } from "./value-journal";
import { type assessValue, valueSourceDigest } from "./value-review";

export type ValueClient = EvidenceClient & Pick<GitHubClient, "fileText">;
type ValueResult = Awaited<ReturnType<typeof assessValue>>;

export async function loadValuePolicy(
  github: Pick<GitHubClient, "fileText">,
  owner: string,
  repo: string,
  sha: string,
) {
  const files = await loadPolicy(github, owner, repo, sha);
  if (files.length === 0 || files.some((file) => file.truncated))
    throw new Error("Complete pinned policy is required for value publication");
  return {
    sha,
    text: files.map((file) => `${file.path}\n${file.text}`).join("\n\n"),
  };
}

/** Re-read full source after inference. Head equality alone misses edited
 * discussions, added reviews and changed accepted-range evidence.
 */
export async function verifyCurrentValueSource(
  github: ValueClient,
  evidence: ValueEvidence,
  result: Pick<ValueResult, "policySha" | "sourceDigest">,
) {
  const [owner, repo] = evidence.repository.split("/");
  const identity = await github.get<{
    id: number;
    node_id: string;
    private: boolean;
  }>(`/repos/${owner}/${repo}`);
  if (
    identity?.private !== false ||
    identity.id !== evidence.repositoryDatabaseId ||
    identity.node_id !== evidence.repositoryNodeId
  )
    throw new Error(
      "Value publication requires the same public repository identity",
    );
  const current = await collectValueEvidence(
    github,
    evidence.repository,
    evidence.pull.number,
  );
  if (current.pull.state !== "closed" || current.limitations.length)
    throw new Error(
      "Value publication requires complete closed-pull-request evidence",
    );
  if (result.policySha !== current.pull.base.sha)
    throw new Error(
      "Value publication policy is not bound to the current base revision",
    );
  const policy = await loadValuePolicy(
    github,
    owner,
    repo,
    current.pull.base.sha,
  );
  if ((await valueSourceDigest(current, policy)) !== result.sourceDigest)
    throw new Error(
      "Value source changed after assessment; a new assessment is required",
    );
  return { evidence: current, policy };
}

export async function publishValueAssessment(
  env: ReviewEnv,
  job: Pick<
    Job,
    "installationId" | "repositoryId" | "owner" | "repo" | "number" | "itemKind"
  >,
  result: ValueResult,
  evidence: ValueEvidence,
  producerRevision: string,
  supersedes: string | null,
  revisionReason: string | null = null,
) {
  if (
    job.itemKind !== "pull_request" ||
    job.repositoryId !== evidence.repositoryDatabaseId ||
    `${job.owner}/${job.repo}`.toLowerCase() !==
      evidence.repository.toLowerCase() ||
    job.number !== evidence.pull.number
  )
    throw new Error("Value publication job does not match its source");
  await assertValueInstallation(env.SLOPBOT_DB, job.installationId);
  // A public repository read alone does not prove installation membership.
  // Verify the token-scoped repository list before reading public source.
  const github = await GitHubClient.forInstallation(
    env.SLOPBOT_APP_ID,
    env.SLOPBOT_APP_PRIVATE_KEY,
    job.installationId,
  );
  await assertValueInstallationRepositories(github, [evidence]);
  const current = await verifyCurrentValueSource(github, evidence, result);
  const prepared = await prepareValueRecord(
    result,
    current.evidence,
    current.policy,
    producerRevision,
    supersedes,
    revisionReason,
  );
  const decision = await readValueDecision(
    env.SLOPBOT_DB,
    current.evidence,
    current.policy,
  );
  const replay = await env.SLOPBOT_DB.prepare(
    "SELECT assessment_key FROM slopbot_value_journal WHERE assessment_key = ?",
  )
    .bind(prepared.assessmentKey)
    .first<{ assessment_key: string }>();
  if (!replay && supersedes !== decision.latestDigest)
    throw new Error(
      "Value publication must supersede the current journal record",
    );
  // A removal or suspension received while inference/source reads ran wins.
  await assertValueInstallation(env.SLOPBOT_DB, job.installationId);
  return appendValueRecord(env.SLOPBOT_DB, prepared, job.installationId);
}

export async function assertValueInstallation(
  db: D1Database,
  installationId: number,
) {
  const state = await installation(db, installationId);
  if (!state || state.removed_at !== null || state.suspended_at !== null)
    throw new Error("Value publication installation is inactive");
}

/** Installation-token visibility is authority; public repository access is not. */
export async function assertValueInstallationRepositories(
  github: Pick<GitHubClient, "get">,
  sources: readonly Pick<
    ValueEvidence,
    "repositoryDatabaseId" | "repositoryNodeId"
  >[],
) {
  const pending = new Map<number, string>();
  for (const source of sources) {
    const previous = pending.get(source.repositoryDatabaseId);
    if (previous !== undefined && previous !== source.repositoryNodeId)
      throw new Error("Value sources disagree about repository identity");
    pending.set(source.repositoryDatabaseId, source.repositoryNodeId);
  }
  if (!pending.size)
    throw new Error("Value publication requires repository sources");
  const seen = new Set<number>();
  for (let page = 1; pending.size; page += 1) {
    const listing = await github.get<{
      repositories: { id: number; node_id: string; private: boolean }[];
    }>(`/installation/repositories?per_page=100&page=${page}`);
    if (!listing || !Array.isArray(listing.repositories))
      throw new Error("Installation repository membership is unavailable");
    for (const repository of listing.repositories) {
      if (seen.has(repository.id))
        throw new Error("Installation repository pagination repeated a source");
      seen.add(repository.id);
      if (
        pending.get(repository.id) === repository.node_id &&
        repository.private === false
      )
        pending.delete(repository.id);
    }
    if (pending.size && listing.repositories.length < 100)
      throw new Error("Repository is not selected for this installation");
  }
}
