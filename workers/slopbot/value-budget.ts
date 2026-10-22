import type { D1Database } from "./persistence";

const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const attempt = (value: string) => /^value:[a-f0-9-]{36}$/.test(value);

/** One atomic admission check across all installations. The caller supplies an
 * operator-approved allowance and a conservative maximum for this attempt.
 * A retry cannot reuse a reservation as permission for another provider call.
 */
export async function reserveValueBudget(
  db: D1Database,
  attemptId: string,
  maximumMicroUsd: number,
  approvedMonthlyMicroUsd: number,
  at = new Date(),
): Promise<boolean> {
  if (
    !attempt(attemptId) ||
    !positive(maximumMicroUsd) ||
    !positive(approvedMonthlyMicroUsd) ||
    !Number.isFinite(at.getTime())
  )
    throw new Error("Explicit valid value inference budget is required");
  if (maximumMicroUsd > approvedMonthlyMicroUsd) return false;
  const stamp = at.toISOString();
  const row = await db
    .prepare(
      `WITH used AS (
         SELECT COALESCE(SUM(COALESCE(provider_cost_micro_usd,cost_micro_usd)),0) AS cost
         FROM slopbot_costs WHERE substr(created_at,1,7)=?1
       ), held AS (
         SELECT COALESCE(SUM(reserved_micro_usd),0) AS cost
         FROM slopbot_value_budget_reservations r
         WHERE NOT EXISTS
           (SELECT 1 FROM slopbot_value_budget_reconciliations c WHERE c.attempt_id=r.attempt_id)
       ) INSERT INTO slopbot_value_budget_reservations
         (attempt_id,month,reserved_micro_usd,approved_limit_micro_usd,reserved_at)
       SELECT ?2,?1,?3,?4,?5 FROM used,held
       WHERE used.cost<=?4-?3 AND held.cost<=?4-?3-used.cost
       AND NOT EXISTS(SELECT 1 FROM slopbot_value_budget_reservations WHERE attempt_id=?2)
       RETURNING attempt_id`,
    )
    .bind(
      stamp.slice(0, 7),
      attemptId,
      maximumMicroUsd,
      approvedMonthlyMicroUsd,
      stamp,
    )
    .first();
  return row !== null;
}

/** Release held capacity only after every expected call has an immutable,
 * provider-reported amount. Estimates or missing receipts remain reserved.
 * The attempt ID must be the review_key used by recordCalls, which retains
 * failed calls too. This does not bill contributors or change spend alerts.
 */
export async function reconcileValueBudget(
  db: D1Database,
  attemptId: string,
  expectedCalls: number,
): Promise<boolean> {
  if (!attempt(attemptId) || !positive(expectedCalls))
    throw new Error("Invalid value budget reconciliation");
  const row = await db
    .prepare(
      `WITH costs AS (
         SELECT COUNT(*) AS n,COUNT(provider_cost_micro_usd) AS known,
                COALESCE(SUM(provider_cost_micro_usd),0) AS cost
         FROM slopbot_costs WHERE review_key=?1
       ) INSERT INTO slopbot_value_budget_reconciliations
         (attempt_id,call_count,recorded_micro_usd,reconciled_at)
       SELECT ?1,costs.n,costs.cost,?3 FROM costs
       JOIN slopbot_value_budget_reservations r ON r.attempt_id=?1
       WHERE costs.n=?2 AND costs.known=costs.n AND costs.cost<=r.reserved_micro_usd
       AND NOT EXISTS(SELECT 1 FROM slopbot_value_budget_reconciliations WHERE attempt_id=?1)
       RETURNING attempt_id`,
    )
    .bind(attemptId, expectedCalls, new Date().toISOString())
    .first();
  return row !== null;
}
