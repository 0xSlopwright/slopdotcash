import {
  VALUE_ASSESSMENT_SCHEMA,
  VALUE_RUBRIC_VERSION,
  VALUE_SYSTEM_PROMPT,
  type ValueAssessment,
  validateValueAssessment,
} from "../../src/lib/value-assessment";
import { type ModelEnv, runStructuredRoute, TRIAGE_ROUTE } from "./models";
import type { SubscriptionResult } from "./value-producer";
import {
  validateWorkUnitPartition,
  type WorkUnitEvidence,
} from "./value-work-unit";

export interface WorkUnitAssessment {
  units: { claimIds: string[]; assessment: ValueAssessment }[];
}

const WORK_UNIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claimIds", "assessment"],
        properties: {
          claimIds: { type: "array", items: { type: "string" } },
          assessment: VALUE_ASSESSMENT_SCHEMA,
        },
      },
    },
  },
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate scope conservation before tiers. Identity and contributor shares
 * come from collected GitHub evidence, never the proposed model response.
 */
export function validateWorkUnitAssessment(
  value: unknown,
  evidence: WorkUnitEvidence,
): WorkUnitAssessment | null {
  if (
    !object(value) ||
    Object.keys(value).join() !== "units" ||
    !Array.isArray(value.units) ||
    evidence.limitations.length > 0
  )
    return null;
  const sources = evidence.sources.map((source) => source.evidence);
  const reviews = sources.flatMap((source) =>
    source.reviews.map((review) => ({ source, review })),
  );
  const reviewIds = new Set(reviews.map(({ review }) => review.node_id));
  if (reviewIds.size !== reviews.length) return null;
  const usedReviews = new Set<string>();
  const units: WorkUnitAssessment["units"] = [];
  const claims = new Map(evidence.claims.map((claim) => [claim.id, claim]));
  const urls = new Set(sources.flatMap((source) => source.evidenceUrls));
  const jointUrls = new Set(sources.map((source) => source.pull.html_url));
  const relatedUrls = new Set([
    ...jointUrls,
    ...sources.flatMap((source) =>
      source.relatedPullRequests.map((pull) => pull.url),
    ),
  ]);
  for (const unit of value.units) {
    if (
      !object(unit) ||
      Object.keys(unit).sort().join() !== "assessment,claimIds" ||
      !Array.isArray(unit.claimIds) ||
      !unit.claimIds.every(
        (id): id is string => typeof id === "string" && claims.has(id),
      ) ||
      !object(unit.assessment) ||
      !Array.isArray(unit.assessment.reviews)
    )
      return null;
    const required = new Set<string>();
    for (const review of unit.assessment.reviews) {
      if (
        !object(review) ||
        typeof review.sourceId !== "string" ||
        usedReviews.has(review.sourceId)
      )
        return null;
      required.add(review.sourceId);
      usedReviews.add(review.sourceId);
    }
    if (unit.claimIds.length === 0 && required.size === 0) return null;
    const actors = new Set<string>();
    for (const id of unit.claimIds) {
      const claim = claims.get(id);
      if (!claim) return null;
      for (const actor of claim.implementationActorNodeIds) actors.add(actor);
    }
    const eligible = new Set(
      reviews
        .filter(
          ({ source, review }) =>
            review.user !== null &&
            review.user.type !== "Bot" &&
            !actors.has(review.user.node_id) &&
            // Retain the parent source's SCR-04 self-review boundary as well.
            source.eligibleReviewIds.includes(review.node_id),
        )
        .map(({ review }) => review.node_id),
    );
    const assessment = validateValueAssessment(unit.assessment, {
      evidenceUrls: urls,
      relatedPullRequestUrls: relatedUrls,
      jointPullRequestUrls: jointUrls,
      reviewIds,
      requiredReviewIds: required,
      reviewUrls: new Map(
        reviews.map(({ review }) => [review.node_id, review.html_url]),
      ),
      reviewTimes: new Map(
        reviews.map(({ review }) => [review.node_id, review.submitted_at]),
      ),
      eligibleReviewIds: eligible,
      merged: unit.claimIds.length > 0,
      closed: true,
    });
    if (!assessment) return null;
    units.push({ claimIds: [...unit.claimIds].sort(), assessment });
  }
  if (
    usedReviews.size !== reviewIds.size ||
    !validateWorkUnitPartition(
      evidence,
      units.filter((unit) => unit.claimIds.length > 0),
    )
  )
    return null;
  return { units };
}

/** Ongoing service callers must reserve their approved inference budget first.
 * Historical subscription assessments use the same validator without API calls.
 * Publication still needs a current-source check and an immutable joint record.
 */
export async function assessWorkUnits(
  env: ModelEnv,
  evidence: WorkUnitEvidence,
) {
  if (evidence.limitations.length > 0)
    throw new Error(
      "Complete joint source evidence is required before valuation",
    );
  const result = await runStructuredRoute(
    env,
    TRIAGE_ROUTE,
    {
      system: `${VALUE_SYSTEM_PROMPT}

Joint assessment: return units under the supplied joint schema. Partition EVERY supplied commit/path claim exactly once by its claimId. Shared PR carriers of the same claim are one source, not repeated work. One PR may contain several independent outcomes, and several PRs may contribute to one outcome. Do not make one unit per PR mechanically. Preserve original implementation separately from distinct integration work. Put EVERY supplied formal review in exactly one unit, compare findings across the entire source group chronologically, and retain the earliest source for duplicate findings. A review-only unit may have no claims and must have tier null; it still needs a demonstrated retained review outcome. Units with missing value evidence remain unresolved with tier null and explicit limitations. Do not assign actors or invent claims. Related PRs may be assessed together only when their full source is supplied; an uninspected external relationship remains unresolved.`,
      policy:
        "Use each source's exact pinned project policy. Conflicting or incomplete authority is unresolved.",
      item: JSON.stringify(evidence),
    },
    "high",
    {
      name: "slop_joint_value_assessment",
      schema: WORK_UNIT_SCHEMA,
      validate: (value) => validateWorkUnitAssessment(value, evidence),
    },
  );
  return {
    ...result,
    rubricVersion: VALUE_RUBRIC_VERSION,
    sourceDigest: evidence.sourceDigest,
    assessedAt: new Date().toISOString(),
  };
}

export type WorkUnitAssessmentResult =
  | Awaited<ReturnType<typeof assessWorkUnits>>
  | SubscriptionResult<Awaited<ReturnType<typeof assessWorkUnits>>>;
