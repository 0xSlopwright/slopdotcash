/** Deterministic, non-custodial cycle funding reminder copy. */

export type CycleReminder = {
  kind: "funding-check";
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

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINOR = /^(0|[1-9][0-9]*)$/u;

/**
 * Remind the viewer to check current vault funding near cycle close. A public
 * cycle record and its manifest do not establish the monthly payment run's
 * funding state. Only that run can qualify obligations against current funds.
 */
export function cycleSettlementReminder(input: {
  closesAt: string;
  capMinor: string;
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
  if (!MINOR.test(input.capMinor))
    throw new TypeError("cycle reminder cap is invalid");
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
  if (BigInt(input.capMinor) === 0n) return null;
  return {
    kind: "funding-check",
    message:
      "Check current vault funds before this cycle is paid. This record does not verify the month's funding status.",
  };
}
