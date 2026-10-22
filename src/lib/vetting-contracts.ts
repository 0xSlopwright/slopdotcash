/** Shared public assessment and revision-clearance contracts. */
export const VETTING_DISPOSITIONS = [
  "clean",
  "incomplete",
  "malicious",
] as const;
export type VettingDisposition = (typeof VETTING_DISPOSITIONS)[number];

export type AssessmentState = "pending" | VettingDisposition;

/** The safe public summary of one assessment (VET-01 display fields). */
export type AssessmentSummary = {
  id: string;
  revision: number;
  state: AssessmentState;
  commitSha: string;
  templateSha256: string;
  policyVersion: string | null;
  requestedAt: string;
  completedAt: string | null;
  modelRuns: { reviewer: string; provider: string; model: string }[];
  artifacts: number;
  heldArtifacts: number;
};

/**
 * The exact code a clearance binds (PRD VET-07): the head commit of the
 * project's integration branch and the content digest of the skill template
 * inputs Slop renders the project skills from.
 */
export type VettingPin = { commitSha: string; templateSha256: string };

/**
 * What a revision may do. Only "cleared" lets Slop serve skills, list the
 * project for discovery, or activate the revision. "stale" means a scan of
 * this content exists, but for another branch head or template digest;
 * "unverified" means Slop could not read the live pin to compare.
 */
export type VettingClearance =
  | { state: "unscanned" }
  | { state: "unverified"; reason: string }
  | { state: "queued"; assessment: AssessmentSummary }
  | { state: "quarantined"; assessment: AssessmentSummary }
  | { state: "stale"; assessment: AssessmentSummary; live: VettingPin }
  | {
      state: "cleared";
      assessment: AssessmentSummary;
      reviewedMaliciousAssessmentIds?: string[];
    }
  | { state: "banned"; assessment: AssessmentSummary };
