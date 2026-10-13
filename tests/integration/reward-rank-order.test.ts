/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertLeaderboardSnapshot } from "../../src/lib/leaderboard";
import { createProjectView } from "../../src/lib/project-view";
import { createRewardCycleProposal } from "../../src/lib/reward-cycle";
import {
  assertRewardAllocationManifest,
  type RewardAllocationManifest,
} from "../../src/lib/rewards";

function frozenCycle(cycleId: string) {
  const directory = resolve(import.meta.dir, "../../cycles/eliza", cycleId);
  const sourceBytes = readFileSync(resolve(directory, "source-snapshot.json"));
  const snapshot: unknown = JSON.parse(sourceBytes.toString("utf8"));
  assertLeaderboardSnapshot(snapshot);
  const proposal = assertRewardAllocationManifest(
    JSON.parse(readFileSync(resolve(directory, "proposal.json"), "utf8")),
  );
  expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(
    proposal.sourceSnapshotSha256,
  );
  return { snapshot, proposal };
}

function reconstructProposal(
  snapshot: ReturnType<typeof frozenCycle>["snapshot"],
  proposal: RewardAllocationManifest,
) {
  return createRewardCycleProposal({
    projectId: "eliza",
    cycleId: proposal.cycleId,
    generatedAt: proposal.generatedAt,
    sourceSnapshotSha256: proposal.sourceSnapshotSha256,
    snapshot,
    ...(proposal.fundingBasis
      ? { fundingBasis: proposal.fundingBasis }
      : { legacyCapMinor: proposal.capMinor }),
    wallets: new Map(
      proposal.allocations.flatMap((allocation) =>
        allocation.wallet ? [[allocation.actor.id, allocation.wallet]] : [],
      ),
    ),
  });
}

test("score ties retain frozen allocation order and payment intent IDs despite unequal evidence weights", () => {
  const { snapshot, proposal } = frozenCycle("2026-09");
  const view = createProjectView(
    snapshot,
    "eliza",
    proposal.cycleId,
    proposal.fundingBasis,
  );
  const mashingaan = view.leaders.find(
    (leader) => leader.actor.login === "mashingaan",
  );
  const mluber = view.leaders.find(
    (leader) => leader.actor.login === "MLuber-bot",
  );
  expect([
    mashingaan?.scoreThirds,
    mashingaan?.adjustedWeight,
    mashingaan?.rank,
    mluber?.scoreThirds,
    mluber?.adjustedWeight,
    mluber?.rank,
  ]).toEqual([39, 408000, 13, 39, 390000, 13]);
  expect(view.leaders.map((leader) => leader.actor.id)).toEqual(
    proposal.allocations.map((allocation) => allocation.actor.id),
  );
  const regenerated = reconstructProposal(snapshot, proposal);
  if (regenerated.kind !== "reward-allocation") {
    throw new Error("Frozen monthly cycle must regenerate a reward allocation");
  }
  // Array equality protects index-derived intent IDs, not only per-actor amounts.
  expect(regenerated.allocations).toEqual(proposal.allocations);
  expect(regenerated.totals).toEqual(proposal.totals);
});

test("rank corrections retain the nonzero historical trial allocations", () => {
  const { snapshot, proposal } = frozenCycle("2026-07");
  const regenerated = reconstructProposal(snapshot, proposal);
  if (regenerated.kind !== "reward-allocation") {
    throw new Error("Frozen monthly cycle must regenerate a reward allocation");
  }
  expect(regenerated.allocations).toEqual(proposal.allocations);
  expect(regenerated.totals).toEqual(proposal.totals);
  expect(
    regenerated.allocations.reduce(
      (total, allocation) => total + BigInt(allocation.suggestedMinor),
      0n,
    ),
  ).toBe(10_000_000_000n);
});
