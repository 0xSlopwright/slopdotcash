import { describe, expect, test } from "bun:test";
import {
  type CycleReminderFunding,
  cycleSettlementReminder,
} from "./funding-reminders";

const reminder = (funding: CycleReminderFunding) =>
  cycleSettlementReminder({
    closesAt: "2026-11-30T23:59:59.999Z",
    funding,
    kind: "monthly-pool",
    now: "2026-11-28T00:00:00.000Z",
    settledAt: null,
    state: "live",
  });

describe("cycle funding reminder", () => {
  test("a pledged pool is reported unfunded", () => {
    expect(
      reminder({
        capMinor: "1000000000",
        committedMinor: "0",
        fundingState: "pledged",
      })?.kind,
    ).toBe("unfunded");
  });
  test("committed funds below the monthly cap are reported underfunded", () => {
    expect(
      reminder({
        capMinor: "1000000000",
        committedMinor: "999999999",
        fundingState: "committed",
      })?.kind,
    ).toBe("underfunded");
  });
  test("a pool whose committed funds cover the whole month shows no reminder", () => {
    expect(
      reminder({
        capMinor: "1000000000",
        committedMinor: "1000000000",
        fundingState: "committed",
      }),
    ).toBeNull();
  });
  test("a points-only pool has nothing to fund", () => {
    expect(
      reminder({
        capMinor: "0",
        committedMinor: "0",
        fundingState: "pledged",
      }),
    ).toBeNull();
  });
});
