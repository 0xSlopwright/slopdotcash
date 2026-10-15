/** Prior-cycle carry replays the reviewed state as of the next proposal. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeRewardAllocation } from "../src/lib/reward-finalization";
import {
  assertRewardAllocationManifest,
  feeForPrincipal,
} from "../src/lib/rewards";
import { loadPriorCycleAccrual } from "./prior-cycle-accrual";

const VAULT = "59W5HpZu1FFqEHj8Qvkwd9UXb62aQMCt32LD4uarrRsc";
const NEXT_PROPOSED_AT = "2026-11-01T06:00:00.000Z";
const PRIOR_APPROVED_AT = "2026-11-03T00:00:00.000Z";

// The published asi 2026-09 proposal, funded, after a review that approved
// one row: one sub-minimum and one unclaimed row carry into 2026-10.
function reviewedPriorProposal() {
  const raw = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../cycles/asi/2026-09/proposal.json"),
      "utf8",
    ),
  );
  raw.fundingBasis = {
    cycleId: "2026-09",
    instrumentId: `squads-v4-vault:solana:${VAULT}:0:${VAULT}`,
    fundingState: "committed",
    committedMinor: "1000000000",
    monthlyCapMinor: "1000000000",
  };
  raw.capMinor = "1000000000";
  for (const [index, suggestedMinor, approvedMinor, state] of [
    [0, "600000000", "600000000", "approved"],
    [1, "1000000", "0", "held-below-minimum"],
    [7, "399000000", "0", "unclaimed"],
  ] as const) {
    Object.assign(raw.allocations[index], {
      suggestedMinor,
      accruedMinor: suggestedMinor,
      approvedMinor,
      state,
    });
  }
  raw.totals = {
    suggestedMinor: "1000000000",
    approvedMinor: "600000000",
    feeMinor: feeForPrincipal("600000000", 100),
  };
  return assertRewardAllocationManifest(raw);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

async function priorCycleRoot(proposal: unknown) {
  const cyclesRoot = mkdtempSync(join(tmpdir(), "prior-cycle-accrual-"));
  roots.push(cyclesRoot);
  const directory = join(cyclesRoot, "asi", "2026-09");
  mkdirSync(directory, { recursive: true });
  await writeFile(
    join(directory, "proposal.json"),
    `${JSON.stringify(proposal, null, 2)}\n`,
  );
  return { cyclesRoot, directory };
}

describe("a prior cycle finalized after the next proposal", () => {
  test("keeps the carry that the next proposal was built from", async () => {
    const proposal = reviewedPriorProposal();
    const { cyclesRoot, directory } = await priorCycleRoot(proposal);
    const input = {
      asOf: NEXT_PROPOSED_AT,
      cycleId: "2026-10",
      cyclesRoot,
      projectId: "asi" as const,
    };
    // rewards:close-month: review over, nothing proposed, not yet finalized.
    const atProposal = await loadPriorCycleAccrual(input);
    expect(Object.fromEntries(atProposal.accruedMinor)).toEqual({
      U_kgDOEtGEfg: "1000000",
      U_kgDOB1sUFQ: "399000000",
    });

    // finalize-allocation, then cycles:sync replays 2026-10 at its generatedAt.
    await writeFile(
      join(directory, "allocation.json"),
      `${JSON.stringify(
        finalizeRewardAllocation(
          proposal,
          PRIOR_APPROVED_AT,
          Date.parse(PRIOR_APPROVED_AT),
        ),
        null,
        2,
      )}\n`,
    );
    expect(await loadPriorCycleAccrual(input)).toEqual(atProposal);
    // A replay after the approval reads the approved allocation instead.
    expect(
      await loadPriorCycleAccrual({ ...input, asOf: PRIOR_APPROVED_AT }),
    ).toEqual(atProposal);
  });

  test("still refuses a prior proposal changed after the replay time", async () => {
    const proposal = reviewedPriorProposal();
    const { cyclesRoot } = await priorCycleRoot({
      ...proposal,
      review: {
        ...proposal.review,
        lastMaterialChangeAt: "2026-10-10T00:00:00.000Z",
        endsAt: "2026-10-24T00:00:00.000Z",
      },
    });
    await expect(
      loadPriorCycleAccrual({
        asOf: "2026-10-05T00:00:00.000Z",
        cycleId: "2026-10",
        cyclesRoot,
        projectId: "asi",
      }),
    ).rejects.toThrow(
      new RangeError("Prior cycle asi/2026-09 contains future review state"),
    );
  });
});
