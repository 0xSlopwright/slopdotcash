/** Deterministic, non-custodial cycle funding reminder copy. */

export type CycleReminder = { kind: "unfunded"; message: string };

export type CycleReminderLifecycle =
  | "closed-no-awards"
  | "external-provisional"
  | "live"
  | "paid"
  | "payment-ready"
  | "review"
  | "settlement-planned"
  | "wound-up";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Escrow is the only funding mode, and no manifest instrument can commit
 * funds, so a monthly pool stays projected. The reminder starts seven days
 * before the cycle closes and never applies to a settled, external-prize, or
 * zero-award cycle.
 */
export function cycleSettlementReminder(input: {
  closesAt: string;
  kind: "external-prize-share" | "monthly-pool";
  now: string;
  settledAt: string | null;
  state: CycleReminderLifecycle;
}): CycleReminder | null {
  const close = Date.parse(input.closesAt);
  const current = Date.parse(input.now);
  if (
    !Number.isFinite(close) ||
    !Number.isFinite(current) ||
    (input.settledAt !== null && !Number.isFinite(Date.parse(input.settledAt)))
  ) {
    throw new TypeError("cycle reminder timestamps are invalid");
  }
  if (
    input.kind !== "monthly-pool" ||
    input.settledAt !== null ||
    input.state === "closed-no-awards" ||
    input.state === "external-provisional" ||
    input.state === "paid" ||
    input.state === "wound-up" ||
    current - close < -7 * DAY_MS
  ) {
    return null;
  }
  return {
    kind: "unfunded",
    message:
      "Unfunded pool reminder: allocations stay projected. Awards are paid only from funds in the project escrow vault.",
  };
}
