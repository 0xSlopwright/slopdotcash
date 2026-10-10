import {
  VALUE_ASSESSMENT_SCHEMA,
  VALUE_RUBRIC_VERSION,
  VALUE_SYSTEM_PROMPT,
  validateValueAssessment,
} from "../../src/lib/value-assessment";
import { sha256Hex } from "./github";
import { type ModelEnv, runStructuredRoute, TRIAGE_ROUTE } from "./models";
import type { ValueEvidence } from "./value-evidence";

/** Callers must reserve an approved inference budget before invoking this.
 * This function returns a proposal and usage; it cannot publish or approve it.
 */
export async function assessValue(
  env: ModelEnv,
  evidence: ValueEvidence,
  policy: { sha: string; text: string },
) {
  if (evidence.limitations.length > 0)
    throw new Error("Complete source evidence is required before valuation");
  if (!/^[a-f0-9]{40}$/u.test(policy.sha) || !policy.text.trim())
    throw new Error("Pinned project policy is required");
  // Collection time is receipt metadata, not a new source revision. Re-reading
  // unchanged evidence must not manufacture another assessment identity.
  const { collectedAt: _collectedAt, ...sourceEvidence } = evidence;
  const source = JSON.stringify({ policy, evidence: sourceEvidence });
  const sourceDigest = await sha256Hex(source);
  const result = await runStructuredRoute(
    env,
    TRIAGE_ROUTE,
    {
      system: VALUE_SYSTEM_PROMPT,
      policy: `Project policy at ${policy.sha}:\n${policy.text}`,
      item: JSON.stringify(evidence),
    },
    "high",
    {
      name: "slop_value_assessment",
      schema: VALUE_ASSESSMENT_SCHEMA,
      validate: (value) =>
        validateValueAssessment(value, {
          evidenceUrls: new Set(evidence.evidenceUrls),
          reviewIds: new Set(evidence.reviews.map((review) => review.node_id)),
          reviewUrls: new Map(
            evidence.reviews.map((review) => [review.node_id, review.html_url]),
          ),
          eligibleReviewIds: new Set(evidence.eligibleReviewIds),
          merged: evidence.pull.merged_at !== null,
        }),
    },
  );
  return {
    rubricVersion: VALUE_RUBRIC_VERSION,
    sourceDigest,
    pullRequestNodeId: evidence.pull.node_id,
    headSha: evidence.pull.head.sha,
    policySha: policy.sha,
    assessedAt: new Date().toISOString(),
    ...result,
  };
}
