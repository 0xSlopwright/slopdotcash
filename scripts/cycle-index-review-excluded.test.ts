/**
 * Copyright 2026 The Slop Authors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A creator may exclude a row during the 14-day public review
 * (cycles/README.md, "Review lapse"): "A creator may approve, hold, exclude,
 * reduce, or increase any row during the 14-day public review." The review
 * window is the period where `proposal.json` exists and `allocation.json` does
 * not, so the published cycle stays in `state: "review"`.
 *
 * The review-state guard previously admitted only proposed / unclaimed /
 * held-below-minimum / held rows, so one legally excluded row made
 * `cycles:check` fail and froze CI and deployment for the rest of the review
 * window. This test pins the excluded row as a review-window state while
 * keeping the guard closed for every other state.
 */
import { describe, expect, test } from "bun:test";
import index from "../public/data/cycles/index.json";
import { assertCycleIndex } from "../src/lib/cycle-index";

type Index = typeof index;
type Contributor = Index["cycles"][number]["contributors"][number];

/** A fresh deep copy so each case starts from the published bytes. */
const fixture = (): Index => JSON.parse(JSON.stringify(index)) as Index;

/** The first published cycle that is still inside its public review window. */
function reviewCycle(value: Index): Index["cycles"][number] {
  const cycle = value.cycles.find((entry) => entry.state === "review");
  expect(cycle).toBeDefined();
  // A review cycle has no allocation yet: that absence is what derives the
  // state, so it is also what makes the excluded row a review-window state.
  expect(cycle?.files.allocation).toBeNull();
  expect(cycle?.reward.approvedMinor).toBe("0");
  return cycle as Index["cycles"][number];
}

/** An unclaimed, unfunded row: the legal shape a creator may exclude. */
function unclaimedRow(cycle: Index["cycles"][number]): Contributor {
  const row = cycle.contributors.find(
    (contributor) => contributor.state === "unclaimed",
  );
  expect(row).toBeDefined();
  expect(row?.approvedMinor).toBe("0");
  expect(row?.paidMinor).toBe("0");
  return row as Contributor;
}

describe("cycle index review window", () => {
  test("the published index is valid before any row is excluded", () => {
    expect(() => assertCycleIndex(fixture())).not.toThrow();
  });

  test("an excluded row keeps the cycle in its review window", () => {
    const value = fixture();
    const row = unclaimedRow(reviewCycle(value));
    row.state = "excluded";
    // An excluded row carries no wallet and no approved amount.
    row.wallet = null;
    row.approvedMinor = "0";
    row.paidMinor = "0";

    expect(() => assertCycleIndex(value)).not.toThrow();
  });

  test("an excluded row still fails once the cycle is funded outside review", () => {
    const value = fixture();
    const cycle = reviewCycle(value);
    const row = unclaimedRow(cycle);
    row.state = "excluded";
    row.wallet = null;
    // Review state requires an unfunded cycle, so an approved cycle total is
    // immutable evidence that the cycle left review. A creator must not be
    // able to hide that behind an excluded row. The funded total is caught
    // before the review-state guard by the reward reconciliation, which is
    // itself part of the same fail-closed contract.
    cycle.reward.approvedMinor = "1000000";

    expect(() => assertCycleIndex(value)).toThrow(
      /reward money totals do not reconcile/,
    );
  });

  test("a paid row is still rejected inside the review window", () => {
    const value = fixture();
    const row = unclaimedRow(reviewCycle(value));
    row.state = "paid";

    expect(() => assertCycleIndex(value)).toThrow(
      /wallet contradicts its state/,
    );
  });
});
