// D1 access for Slopbot (migrations/0013_slopbot.sql and
// 0018_slopbot_delivery_processing.sql). Cost and credit rows are append-only;
// the balance is always derived, never stored.
import { PRICE_VERSION, priceUsage } from "./contracts";
import type { CallRecord } from "./models";

type D1Result = { success: boolean; meta?: { changes?: number } };
export type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result>;
};
export type D1Database = {
  prepare(query: string): D1Statement;
};
export type D1TransactionalDatabase = D1Database & {
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

const now = () => new Date().toISOString();

export async function recordDelivery(
  db: D1Database,
  deliveryId: string,
  event: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO slopbot_deliveries (delivery_id, event, received_at) VALUES (?, ?, ?)",
    )
    .bind(deliveryId, event, now())
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function releaseDelivery(db: D1Database, deliveryId: string) {
  await db
    .prepare("DELETE FROM slopbot_deliveries WHERE delivery_id = ?")
    .bind(deliveryId)
    .run();
}

export async function claimInstallationDelivery(
  db: D1Database,
  deliveryId: string,
  event: string,
): Promise<boolean> {
  const inserted = await db
    .prepare(
      "INSERT OR IGNORE INTO slopbot_deliveries (delivery_id, event, received_at) VALUES (?, ?, ?)",
    )
    .bind(deliveryId, event, now())
    .run();
  if ((inserted.meta?.changes ?? 0) === 1) return true;
  const existing = await db
    .prepare(
      "SELECT event, installation_processed_at FROM slopbot_deliveries WHERE delivery_id = ?",
    )
    .bind(deliveryId)
    .first<{ event: string; installation_processed_at: string | null }>();
  return (
    existing?.event === event && existing.installation_processed_at === null
  );
}

type InstallationUpdate =
  | {
      kind: "upsert";
      installation: {
        id: number;
        account: { id: number; login: string; type: string };
      };
      sourceUpdatedAt: number;
    }
  | {
      kind: "state";
      installation: {
        id: number;
        account: { id: number; login: string; type: string };
      };
      state: "removed" | "suspended" | "active";
      sourceUpdatedAt: number;
    };

export async function completeInstallationDelivery(
  db: D1TransactionalDatabase,
  deliveryId: string,
  update: InstallationUpdate | null,
) {
  const statements: D1Statement[] = [];
  if (update?.kind === "upsert") {
    statements.push(
      db
        .prepare(
          `INSERT INTO slopbot_installations (installation_id, account_id, account_login, account_type, created_at, source_updated_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id) DO UPDATE SET
             removed_at = NULL,
             account_login = excluded.account_login,
             source_updated_at = excluded.source_updated_at
           WHERE slopbot_installations.source_updated_at IS NULL
             OR slopbot_installations.source_updated_at < excluded.source_updated_at`,
        )
        .bind(
          update.installation.id,
          update.installation.account.id,
          update.installation.account.login,
          update.installation.account.type,
          now(),
          update.sourceUpdatedAt,
        ),
    );
  } else if (update?.kind === "state") {
    const column = update.state === "removed" ? "removed_at" : "suspended_at";
    const changedAt = update.state === "active" ? null : now();
    const equalTimestampGuard =
      update.state === "removed"
        ? "slopbot_installations.removed_at IS NULL"
        : update.state === "suspended"
          ? "slopbot_installations.removed_at IS NULL AND slopbot_installations.suspended_at IS NULL"
          : "0";
    statements.push(
      db
        .prepare(
          `INSERT INTO slopbot_installations
             (installation_id, account_id, account_login, account_type, created_at, suspended_at, removed_at, source_updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET
             ${column} = excluded.${column},
             source_updated_at = excluded.source_updated_at
           WHERE slopbot_installations.source_updated_at IS NULL
             OR slopbot_installations.source_updated_at < excluded.source_updated_at
             OR (slopbot_installations.source_updated_at = excluded.source_updated_at
                 AND ${equalTimestampGuard})`,
        )
        .bind(
          update.installation.id,
          update.installation.account.id,
          update.installation.account.login,
          update.installation.account.type,
          now(),
          update.state === "suspended" ? changedAt : null,
          update.state === "removed" ? changedAt : null,
          update.sourceUpdatedAt,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        "UPDATE slopbot_deliveries SET installation_processed_at = ? WHERE delivery_id = ? AND installation_processed_at IS NULL",
      )
      .bind(now(), deliveryId),
  );
  await db.batch(statements);
}

export async function installation(db: D1Database, installationId: number) {
  return db
    .prepare(
      "SELECT created_at, suspended_at, removed_at FROM slopbot_installations WHERE installation_id = ?",
    )
    .bind(installationId)
    .first<{
      created_at: string;
      suspended_at: string | null;
      removed_at: string | null;
    }>();
}

export async function balance(
  db: D1Database,
  installationId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (SELECT COALESCE(SUM(amount_micro_usdc), 0) FROM slopbot_credits WHERE installation_id = ?1)
            - (SELECT COALESCE(SUM(billed_micro_usdc), 0) FROM slopbot_costs WHERE installation_id = ?1) AS balance`,
    )
    .bind(installationId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

export async function isParticipant(
  db: D1Database,
  githubId: number,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM points_members WHERE github_id = ?")
    .bind(String(githubId))
    .first();
  return row !== null;
}

export async function count(
  db: D1Database,
  sql: string,
  ...values: unknown[]
): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...values)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function reviewExists(
  db: D1Database,
  reviewKey: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS ok FROM slopbot_reviews WHERE review_key = ? AND status IN ('running', 'completed')",
    )
    .bind(reviewKey)
    .first();
  return row !== null;
}

export type ReviewRow = {
  reviewKey: string;
  installationId: number;
  repositoryId: number;
  itemKind: "issue" | "pull_request";
  itemNumber: number;
  itemNodeId: string;
  authorId: number;
  revision: string;
  contentDigest: string;
  policyDigest: string;
};

// "retry" resumes a review whose earlier attempt failed; its model calls are
// Slop-caused and recorded unbilled.
export async function startReview(
  db: D1Database,
  row: ReviewRow,
): Promise<"new" | "retry" | "exists"> {
  // Eligibility skips are not completed reviews. Claim the same revision
  // again when its draft/installation/budget state permits review. A skip
  // before any model call is still a first billable attempt; prior calls
  // retain the existing Slop-caused retry treatment.
  const resumed = await db
    .prepare(
      `UPDATE slopbot_reviews SET status = 'running', content_digest = ?,
        created_at = CASE WHEN EXISTS (SELECT 1 FROM slopbot_costs WHERE review_key = ?)
          THEN created_at ELSE ? END, skip_reason = NULL, completed_at = NULL
       WHERE review_key = ? AND status = 'skipped'
       RETURNING EXISTS (SELECT 1 FROM slopbot_costs WHERE review_key = ?) AS retry`,
    )
    .bind(row.contentDigest, row.reviewKey, now(), row.reviewKey, row.reviewKey)
    .first<{ retry: number }>();
  if (resumed !== null) return resumed.retry === 1 ? "retry" : "new";
  const retried = await db
    .prepare(
      "UPDATE slopbot_reviews SET status = 'running' WHERE review_key = ? AND status = 'failed'",
    )
    .bind(row.reviewKey)
    .run();
  if ((retried.meta?.changes ?? 0) === 1) return "retry";
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO slopbot_reviews (review_key, installation_id, repository_id, item_kind, item_number,
        item_node_id, author_id, revision, content_digest, policy_digest, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    )
    .bind(
      row.reviewKey,
      row.installationId,
      row.repositoryId,
      row.itemKind,
      row.itemNumber,
      row.itemNodeId,
      row.authorId,
      row.revision,
      row.contentDigest,
      row.policyDigest,
      now(),
    )
    .run();
  return (result.meta?.changes ?? 0) === 1 ? "new" : "exists";
}

export async function finishReview(
  db: D1Database,
  reviewKey: string,
  status: "completed" | "failed" | "skipped",
  detail: { skipReason?: string; verdict?: unknown; action?: string },
) {
  await db
    .prepare(
      "UPDATE slopbot_reviews SET status = ?, skip_reason = ?, verdict = ?, action = ?, completed_at = ? WHERE review_key = ?",
    )
    .bind(
      status,
      detail.skipReason ?? null,
      detail.verdict === undefined ? null : JSON.stringify(detail.verdict),
      detail.action ?? null,
      now(),
      reviewKey,
    )
    .run();
}

// One immutable cost row per model call (BOT-10). Failed calls are recorded
// at cost but billed zero: Slop absorbs provider failures.
export async function recordCalls(
  db: D1Database,
  reviewKey: string,
  installationId: number,
  callKind: "triage" | "confirm",
  calls: CallRecord[],
  billable: boolean,
): Promise<number> {
  let billed = 0;
  for (const call of calls) {
    const price = priceUsage(call.priceKey, call.usage);
    if (price === null) throw new Error(`no price for ${call.priceKey}`);
    const substituted =
      call.servedModel !== null &&
      !call.priceKey.endsWith(`/${call.servedModel}`);
    const billedMicro =
      billable && call.outcome === "ok" ? price.billedMicroUsdc : 0;
    billed += billedMicro;
    await db
      .prepare(
        `INSERT INTO slopbot_costs (review_key, installation_id, call_kind, route_step, provider, requested_model,
          served_model, outcome, failure, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
          price_version, cost_micro_usd, billed_micro_usdc, reconciliation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        reviewKey,
        installationId,
        callKind,
        call.routeStep,
        call.provider,
        call.requestedModel,
        call.servedModel,
        call.outcome,
        call.failure,
        call.usage.input,
        call.usage.cacheWrite,
        call.usage.cacheRead,
        call.usage.output,
        PRICE_VERSION,
        price.costMicroUsd,
        billedMicro,
        substituted ? "estimated" : price.reconciliation,
        now(),
      )
      .run();
  }
  return billed;
}

export async function recordAction(
  db: D1Database,
  reviewKey: string,
  repositoryId: number,
  itemNodeId: string,
  action: "comment" | "label" | "close" | "appeal" | "human_reopen",
  detail: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO slopbot_actions (review_key, repository_id, item_node_id, action, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(reviewKey, repositoryId, itemNodeId, action, detail, now())
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function commentId(
  db: D1Database,
  itemNodeId: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT comment_id FROM slopbot_item_comments WHERE item_node_id = ?",
    )
    .bind(itemNodeId)
    .first<{ comment_id: number }>();
  return row?.comment_id ?? null;
}

export async function saveCommentId(
  db: D1Database,
  itemNodeId: string,
  repositoryId: number,
  id: number,
) {
  await db
    .prepare(
      `INSERT INTO slopbot_item_comments (item_node_id, repository_id, comment_id) VALUES (?, ?, ?)
       ON CONFLICT(item_node_id) DO UPDATE SET comment_id = excluded.comment_id`,
    )
    .bind(itemNodeId, repositoryId, id)
    .run();
}
