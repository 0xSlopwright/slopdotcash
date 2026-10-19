import { resolveRewardCapMinor } from "./reward-cap.mjs";

/**
 * Frozen monetary basis of a monthly allocation. Escrow is the only funding
 * mode and the escrow vault enforces available funds, so no manifest
 * instrument backs a monthly commitment: `instrumentId` is always null and
 * the funding-backed principal is zero.
 */
export function assertAllocationFundingBasis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid allocation funding basis");
  const money = /^(0|[1-9][0-9]{0,19})$/u;
  if (
    Object.keys(value).sort().join(",") !==
      "committedMinor,cycleId,fundingState,instrumentId,monthlyCapMinor" ||
    typeof value.cycleId !== "string" ||
    !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value.cycleId) ||
    !["pledged", "committed"].includes(value.fundingState) ||
    value.committedMinor !== "0" ||
    typeof value.monthlyCapMinor !== "string" ||
    !money.test(value.monthlyCapMinor) ||
    value.instrumentId !== null
  )
    throw new TypeError("invalid allocation funding basis");
  return { ...value };
}

/** Input project has already passed the reviewed project schema. */
export function deriveAllocationFundingBasis(project, cycleId) {
  return assertAllocationFundingBasis({
    cycleId,
    instrumentId: null,
    fundingState: project.reward.fundingState,
    committedMinor: "0",
    monthlyCapMinor: resolveRewardCapMinor(project, cycleId),
  });
}
