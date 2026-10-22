import {
  type ModelEnv,
  type Prompt,
  runStructuredRoute,
  TRIAGE_ROUTE,
} from "./models";
import { type D1Database, recordCalls } from "./persistence";
import { reconcileValueBudget, reserveValueBudget } from "./value-budget";

/** Supplied by the trusted consumer, never repository/model input. The maximum
 * must cover every permitted route attempt. No default authorizes expenditure.
 */
export type ValueInferenceBudget = {
  db: D1Database;
  installationId: number;
  attemptId: string;
  maximumMicroUsd: number;
  approvedMonthlyMicroUsd: number;
};

export async function runValueInference<T>(
  env: ModelEnv,
  prompt: Prompt,
  output: {
    name: string;
    schema: Record<string, unknown>;
    validate(value: unknown): T | null;
  },
  mayCall: () => Promise<boolean>,
  budget: ValueInferenceBudget,
) {
  if (
    !Number.isSafeInteger(budget.installationId) ||
    budget.installationId <= 0
  )
    throw new Error("Value inference installation identity is invalid");
  // Check authority before holding any capacity. The route checks it again
  // before every request; a revocation during reservation still wins.
  if (!(await mayCall()))
    return {
      verdict: null,
      calls: [],
      servedBy: null,
      blocked: true,
      blockReason: "authority" as const,
    };
  if (
    !(await reserveValueBudget(
      budget.db,
      budget.attemptId,
      budget.maximumMicroUsd,
      budget.approvedMonthlyMicroUsd,
    ))
  )
    return {
      verdict: null,
      calls: [],
      servedBy: null,
      blocked: true,
      blockReason: "budget" as const,
    };
  const result = await runStructuredRoute(
    env,
    TRIAGE_ROUTE,
    prompt,
    "high",
    output,
    mayCall,
  );
  // Failure to persist usage must prevent publication. The reservation remains
  // held after a crash or ambiguous result; never release it on a timer.
  await recordCalls(
    budget.db,
    budget.attemptId,
    budget.installationId,
    "triage",
    result.calls,
    false,
  );
  if (result.calls.length)
    await reconcileValueBudget(
      budget.db,
      budget.attemptId,
      result.calls.length,
    );
  return {
    ...result,
    blockReason: result.blocked ? ("authority" as const) : null,
  };
}
