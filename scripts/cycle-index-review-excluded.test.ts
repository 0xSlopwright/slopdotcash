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
 * `cycles:check` fail and froze that cycle's CI and deployment.
 *
 * `public/data/cycles/index.json` is a build output and is not committed, so
 * this test exports the tracked tree, builds the index with the real sync
 * script, and then exercises both the validator and that script.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertCycleIndex, type CycleIndex } from "../src/lib/cycle-index";

const repositoryRoot = resolve(import.meta.dir, "..");
const syncScript = "scripts/sync-cycle-index.ts";

let workingCopy = "";
let published: CycleIndex;

/** Runs the repository's own sync script inside the scratch copy. */
function sync(args: string[] = []) {
  return spawnSync(process.execPath, [join(workingCopy, syncScript), ...args], {
    cwd: workingCopy,
    encoding: "utf8",
  });
}

beforeAll(() => {
  workingCopy = mkdtempSync(join(tmpdir(), "cycle-index-review-"));
  // `git archive` exports exactly the tracked tree, which is what CI has.
  const archive = spawnSync("git", ["archive", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
  });
  expect(archive.status).toBe(0);
  const extract = spawnSync("tar", ["-x", "-C", workingCopy], {
    input: archive.stdout,
  });
  expect(extract.status).toBe(0);
  // The export holds the tracked tree only, so the installed dependencies are
  // linked in from the checkout that runs the test.
  symlinkSync(join(repositoryRoot, "node_modules"), join(workingCopy, "node_modules"));
  // `bun` needs a writable temporary directory for its own runtime files.
  const bunTemp = join(workingCopy, ".bun-tmp");
  mkdirSync(bunTemp, { recursive: true });
  process.env.TMPDIR ??= bunTemp;

  // Publish the artifact the site build consumes, inside the scratch copy.
  const generated = sync();
  expect(generated.status).toBe(0);

  published = JSON.parse(
    readFileSync(join(workingCopy, "public/data/cycles/index.json"), "utf8"),
  ) as CycleIndex;
  // The unmodified export must validate before any case mutates it.
  expect(() => assertCycleIndex(published)).not.toThrow();
});

afterAll(() => {
  if (workingCopy) rmSync(workingCopy, { recursive: true, force: true });
});

/** A fresh deep copy so each case starts from the published bytes. */
const fixture = (): CycleIndex =>
  JSON.parse(JSON.stringify(published)) as CycleIndex;

/** The first published cycle that is still inside its public review window. */
function reviewCycle(value: CycleIndex): CycleIndex["cycles"][number] {
  const cycle = value.cycles.find((entry) => entry.state === "review");
  expect(cycle).toBeDefined();
  // A review cycle has no allocation yet: that absence is what derives the
  // state, so it is also what makes the excluded row a review-window state.
  expect(cycle?.files.allocation).toBeNull();
  expect(cycle?.reward.approvedMinor).toBe("0");
  return cycle as CycleIndex["cycles"][number];
}

/** An unclaimed, unfunded row: the legal shape a creator may exclude. */
function unclaimedRow(cycle: CycleIndex["cycles"][number]) {
  const row = cycle.contributors.find(
    (contributor) => contributor.state === "unclaimed",
  );
  expect(row).toBeDefined();
  expect(row?.approvedMinor).toBe("0");
  expect(row?.paidMinor).toBe("0");
  return row as CycleIndex["cycles"][number]["contributors"][number];
}

/** Rewrites one row's state in the scratch copy's real `proposal.json`. */
function excludeRowOnDisk(projectId: string, cycleId: string, login: string) {
  const target = join(
    workingCopy,
    "cycles",
    projectId,
    cycleId,
    "proposal.json",
  );
  const proposal = JSON.parse(readFileSync(target, "utf8")) as {
    allocations: { actor: { login: string }; state: string }[];
  };
  const allocation = proposal.allocations.find(
    (candidate) => candidate.actor.login === login,
  );
  expect(allocation).toBeDefined();
  allocation!.state = "excluded";
  writeFileSync(target, `${JSON.stringify(proposal, null, 2)}\n`);
  return target;
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
    // able to hide that behind an excluded row. That total is caught before
    // the review-state guard by the reward reconciliation, which is part of
    // the same fail-closed contract.
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

  test("the sync script accepts an excluded row end to end", () => {
    // Proves the guard change through the same entry point CI runs, not only
    // through the in-process validator. A baseline run must pass first so a
    // failure below is attributable to the exclusion.
    expect(sync(["--check"]).status).toBe(0);

    const cycle = reviewCycle(fixture());
    const row = unclaimedRow(cycle);
    excludeRowOnDisk(cycle.projectId, cycle.cycleId, row.actor.login);

    const result = sync(["--check"]);
    expect(result.stderr).not.toContain("refused");
    expect(result.stdout).toContain("validated");
    expect(result.status).toBe(0);
  });
});
