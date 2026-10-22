import { findRegisteredRepositoryById } from "../../src/lib/repositories.mjs";
import { GitHubClient } from "./github";
import { registeredRepository } from "./registry";
import type { ReviewEnv } from "./review";
import { readValueDecision } from "./value-consumption";
import { collectValueEvidence } from "./value-evidence";
import {
  claimValueRequest,
  finishValueRequest,
  ownsValueRequest,
  type ValueOutcome,
} from "./value-processing";
import {
  assertValueInstallation,
  assertValueInstallationRepositories,
  loadValuePolicy,
  publishValueAssessment,
} from "./value-publication";
import type { ValueRequest } from "./value-requests";
import { assessValue } from "./value-review";

export type ValueConsumerEnv = ReviewEnv & {
  SLOPBOT_PRODUCER_REVISION?: string;
  SLOPBOT_VALUE_MONTHLY_BUDGET_MICRO_USD?: string;
  SLOPBOT_VALUE_ATTEMPT_RESERVE_MICRO_USD?: string;
  SLOPBOT_VALUE_START_AT?: string;
};
const amount = (value: string | undefined) =>
  value && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;

/** Process one durable delivery. Related-source groups remain pending until
 * their complete joint collection path is available; never score a carrier
 * independently merely because the single-source path is simpler.
 */
export async function consumeValueRequest(
  env: ValueConsumerEnv,
  job: ValueRequest,
) {
  const db = env.SLOPBOT_DB;
  const claim = await claimValueRequest(db, job.deliveryId);
  if (!claim) return "not-claimed";
  const finish = async (outcome: ValueOutcome, terminal = false) => {
    await finishValueRequest(
      db,
      claim,
      outcome,
      terminal ? null : new Date(Date.now() + 60 * 60 * 1000),
    );
    return outcome;
  };
  try {
    if (!(await registeredRepository(db, job)))
      return await finish("authority");
    await assertValueInstallation(db, job.installationId);
    const monthly = amount(env.SLOPBOT_VALUE_MONTHLY_BUDGET_MICRO_USD);
    const maximum = amount(env.SLOPBOT_VALUE_ATTEMPT_RESERVE_MICRO_USD);
    const revision = env.SLOPBOT_PRODUCER_REVISION;
    const start = Date.parse(env.SLOPBOT_VALUE_START_AT ?? "");
    if (
      !monthly ||
      !maximum ||
      maximum > monthly ||
      !revision ||
      !/^[a-f0-9]{40}$/.test(revision) ||
      !Number.isFinite(start) ||
      !env.SURPLUS_API_KEY
    )
      return await finish("budget");
    const repository = findRegisteredRepositoryById(`${job.owner}/${job.repo}`);
    if (!repository) return await finish("authority");
    const github = await GitHubClient.forInstallation(
      env.SLOPBOT_APP_ID,
      env.SLOPBOT_APP_PRIVATE_KEY,
      job.installationId,
    );
    const identity = await github.get<{
      id: number;
      node_id: string;
      private: boolean;
    }>(`/repos/${repository.id}`);
    if (!identity || identity.private || identity.id !== job.repositoryId)
      return await finish("authority");
    const membership = [
      { repositoryDatabaseId: identity.id, repositoryNodeId: identity.node_id },
    ];
    await assertValueInstallationRepositories(github, membership);
    const pull = await github.get<{
      state: string;
      merged_at: string | null;
      closed_at: string | null;
    }>(`/repos/${repository.id}/pulls/${job.number}`);
    if (!pull) return await finish("source-incomplete");
    if (pull.state !== "closed") return await finish("open", true);
    const occurred = Date.parse(pull.merged_at ?? pull.closed_at ?? "");
    // Historical work is handled by the subscription intake, never this API route.
    if (!Number.isFinite(occurred)) return await finish("source-incomplete");
    if (occurred < start) return await finish("authority");
    const evidence = await collectValueEvidence(
      github,
      repository.id,
      job.number,
      repository,
    );
    if (evidence.limitations.length || evidence.relatedPullRequests.length)
      return await finish("source-incomplete");
    const policy = await loadValuePolicy(
      github,
      job.owner,
      job.repo,
      evidence.pull.base.sha,
    );
    const current = await readValueDecision(db, evidence, policy);
    if (current.status === "assessed" || current.status === "unresolved")
      return await finish("current", true);
    const mayCall = async () => {
      if (
        !(await ownsValueRequest(db, claim)) ||
        !(await registeredRepository(db, job))
      )
        return false;
      await assertValueInstallation(db, job.installationId);
      await assertValueInstallationRepositories(github, membership);
      return true;
    };
    const result = await assessValue(env, evidence, policy, mayCall, {
      db,
      installationId: job.installationId,
      attemptId: `value:${crypto.randomUUID()}`,
      maximumMicroUsd: maximum,
      approvedMonthlyMicroUsd: monthly,
    });
    if (result.blocked)
      return await finish(
        result.blockReason === "budget" ? "budget" : "authority",
      );
    if (!result.verdict) return await finish("retry");
    if (!(await mayCall())) return await finish("authority");
    await publishValueAssessment(
      env,
      { ...job, itemKind: "pull_request" },
      result,
      evidence,
      revision,
      current.latestDigest,
      current.latestDigest
        ? "Source changed; automatic provisional reassessment"
        : null,
    );
    return await finish("published", true);
  } catch {
    // Do not persist provider/source exception bodies. A lost lease also refuses
    // this transition, leaving recovery to the new owner or the lease expiry.
    return await finish("retry");
  }
}

/** One bounded job per scheduled invocation. Concurrent schedulers may select
 * the same row; the durable lease allows only one to process it.
 */
export async function consumePendingValueRequest(env: ValueConsumerEnv) {
  const job = await env.SLOPBOT_DB.prepare(
    `SELECT r.delivery_id AS deliveryId,r.installation_id AS installationId,
       r.repository_id AS repositoryId,r.owner,r.repo,r.pull_request_number AS number
     FROM slopbot_value_requests r LEFT JOIN slopbot_value_processing p
       ON p.delivery_id=r.delivery_id
     WHERE p.delivery_id IS NULL
       OR (p.state='waiting' AND p.retry_at<=?1)
       OR (p.state='running' AND p.lease_until<=?1)
     ORDER BY r.received_at,r.delivery_id LIMIT 1`,
  )
    .bind(new Date().toISOString())
    .first<ValueRequest>();
  return job ? consumeValueRequest(env, job) : "empty";
}
