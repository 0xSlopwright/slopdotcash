/** Deterministic, non-custodial cycle funding reminder copy. */

export type CycleReminder = {
  kind: "unfunded" | "underfunded";
  message: string;
};

export type CycleReminderLifecycle =
  | "closed-no-awards"
  | "external-provisional"
  | "live"
  | "paid"
  | "payment-ready"
  | "review"
  | "settlement-planned"
  | "wound-up";

/** The project's current reviewed funding against the cycle's monthly cap. */
export interface CycleReminderFunding {
  capMinor: string;
  committedMinor: string;
  fundingState: "committed" | "external-opportunity" | "pledged";
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINOR = /^(0|[1-9][0-9]*)$/u;

/**
 * A monthly pool is covered only when the project's reviewed funding is
 * committed and at least the cycle's monthly cap (PRD section 6: an
 * underfunded month creates no obligations until the whole month is
 * covered). The reminder starts seven days before the cycle closes, names
 * whether the pool is unfunded or underfunded, and never applies to a
 * covered, settled, external-prize, points-only, or zero-award cycle.
 */
export function cycleSettlementReminder(input: {
  closesAt: string;
  funding: CycleReminderFunding;
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
    !MINOR.test(input.funding.capMinor) ||
    !MINOR.test(input.funding.committedMinor)
  )
    throw new TypeError("cycle reminder funding amounts are invalid");
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
  const cap = BigInt(input.funding.capMinor);
  const committed =
    input.funding.fundingState === "committed"
      ? BigInt(input.funding.committedMinor)
      : 0n;
  if (cap === 0n || committed >= cap) return null;
  return committed === 0n
    ? {
        kind: "unfunded",
        message:
          "Unfunded pool reminder: allocations stay projected. Awards are paid only from funds in the project vault.",
      }
    : {
        kind: "underfunded",
        message:
          "Underfunded pool reminder: committed funds do not cover this month's cap, so allocations stay projected until the whole month is covered.",
      };
}
