import { expect, test } from "bun:test";
import { cycleSettlementReminder } from "./funding-reminders";

const input = {
  capMinor: "1000000000",
  closesAt: "2026-11-30T23:59:59.999Z",
  kind: "monthly-pool" as const,
  now: "2026-11-28T00:00:00.000Z",
  settledAt: null,
  state: "live" as const,
};

test("a cycle cap alone does not classify current vault funding", () => {
  const reminder = cycleSettlementReminder(input);
  expect(reminder?.kind).toBe("funding-check");
  expect(reminder?.message).toContain("does not verify");
  expect(cycleSettlementReminder({ ...input, capMinor: "0" })).toBeNull();
  expect(cycleSettlementReminder({ ...input, state: "paid" })).toBeNull();
  expect(
    cycleSettlementReminder({ ...input, kind: "external-prize-share" }),
  ).toBeNull();
});
