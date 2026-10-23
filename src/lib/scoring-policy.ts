/**
 * Versioned selection of the Slop Score producer for new work (PRD section 7;
 * SCR-04, SCR-05, SCR-06; MVP-09, MVP-05a).
 *
 * Work accepted before the selected policy's effective instant keeps the
 * Slop Score v2 and SCR-05 rules in `leaderboard.ts` unchanged. Work accepted
 * from that instant is scored from Slopbot's source-bound value assessments;
 * a valid maintainer ratification remains the exception that takes
 * precedence. Payment authority stays separate: a score is never an award.
 */
import { VALUE_RUBRIC_VERSION } from "./value-assessment";

export const VALUE_SCORING_POLICY_ID = "slop-value-v1" as const;

/** PRD section 7: up to the first five distinct qualifying reviewers. */
export const MAX_CREDITED_REVIEWERS = 5 as const;

/**
 * AWAITING OWNER DECISION. The PRD does not yet set these values (section 12,
 * "Remaining implementation decisions": review-credit allocation rounding).
 *
 * - `effectiveAt`: exact UTC instant from which accepted work uses the value
 *   policy. Earlier work keeps its historical policy.
 * - `reviewCreditPoolThirds`: review credit, in integer score thirds, that one
 *   pull request shares among its credited reviewers.
 *
 * While either value is null, leaderboard generation refuses to publish
 * instead of choosing an economic value or silently keeping the old producer.
 */
export const VALUE_SCORING_POLICY_DECISION: Readonly<ValueScoringPolicyDecision> =
  Object.freeze({ effectiveAt: null, reviewCreditPoolThirds: null });

export interface ValueScoringPolicyDecision {
  effectiveAt: string | null;
  reviewCreditPoolThirds: number | null;
}

export interface ValueScoringPolicy {
  id: typeof VALUE_SCORING_POLICY_ID;
  rubricVersion: string;
  effectiveAt: string;
  reviewCredit: {
    maxReviewers: typeof MAX_CREDITED_REVIEWERS;
    poolThirds: number;
  };
}

export class ScoringPolicyDecisionPendingError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `Scoring policy ${VALUE_SCORING_POLICY_ID} awaits an owner decision for ${missing.join(
        " and ",
      )}; refusing to publish scores under an undecided policy`,
    );
    this.name = "ScoringPolicyDecisionPendingError";
  }
}

const EXACT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Throws unless the policy is complete and well formed. */
export function assertValueScoringPolicy(
  policy: ValueScoringPolicy,
): ValueScoringPolicy {
  if (
    policy.id !== VALUE_SCORING_POLICY_ID ||
    policy.rubricVersion !== VALUE_RUBRIC_VERSION ||
    policy.reviewCredit.maxReviewers !== MAX_CREDITED_REVIEWERS
  )
    throw new TypeError("Value scoring policy has an unknown version");
  if (
    !EXACT_UTC.test(policy.effectiveAt) ||
    new Date(policy.effectiveAt).toISOString() !== policy.effectiveAt
  )
    throw new TypeError(
      "Value scoring policy effectiveAt must be an exact UTC timestamp",
    );
  if (
    !Number.isSafeInteger(policy.reviewCredit.poolThirds) ||
    policy.reviewCredit.poolThirds < 1
  )
    throw new TypeError(
      "Value scoring review credit pool must be a positive integer of thirds",
    );
  return policy;
}

/** The current policy, or a pending-decision error naming what is missing. */
export function valueScoringPolicy(
  decision: Readonly<ValueScoringPolicyDecision> = VALUE_SCORING_POLICY_DECISION,
): ValueScoringPolicy {
  const missing = [
    ...(decision.effectiveAt === null ? ["effectiveAt"] : []),
    ...(decision.reviewCreditPoolThirds === null
      ? ["reviewCreditPoolThirds"]
      : []),
  ];
  if (
    missing.length ||
    decision.effectiveAt === null ||
    decision.reviewCreditPoolThirds === null
  )
    throw new ScoringPolicyDecisionPendingError(missing);
  return assertValueScoringPolicy({
    id: VALUE_SCORING_POLICY_ID,
    rubricVersion: VALUE_RUBRIC_VERSION,
    effectiveAt: decision.effectiveAt,
    reviewCredit: {
      maxReviewers: MAX_CREDITED_REVIEWERS,
      poolThirds: decision.reviewCreditPoolThirds,
    },
  });
}

/**
 * Splits an integer pool by positive integer weights with the largest
 * remainder method. Equal remainders go to the earlier position, so callers
 * pass weights in credited-reviewer order. The shares always sum to the pool.
 */
export function allocateReviewCredit(
  poolThirds: number,
  weights: readonly number[],
): number[] {
  if (!Number.isSafeInteger(poolThirds) || poolThirds < 1)
    throw new RangeError("Review credit pool must be a positive integer");
  if (
    weights.length === 0 ||
    weights.length > MAX_CREDITED_REVIEWERS ||
    weights.some((weight) => !Number.isSafeInteger(weight) || weight < 1)
  )
    throw new RangeError(
      `Review credit needs one to ${MAX_CREDITED_REVIEWERS} positive integer weights`,
    );
  const pool = BigInt(poolThirds);
  const total = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  const shares = weights.map((weight) => (pool * BigInt(weight)) / total);
  const remainders = weights.map((weight) => (pool * BigInt(weight)) % total);
  let left = pool - shares.reduce((sum, share) => sum + share, 0n);
  const order = weights
    .map((_, index) => index)
    .sort((a, b) =>
      remainders[a] === remainders[b]
        ? a - b
        : (remainders[b] as bigint) > (remainders[a] as bigint)
          ? 1
          : -1,
    );
  for (const index of order) {
    if (left === 0n) break;
    shares[index] = (shares[index] as bigint) + 1n;
    left -= 1n;
  }
  return shares.map(Number);
}

export interface QualifyingReview<Actor extends { id: string }> {
  reviewId: string;
  actor: Actor;
  submittedAt: string;
  /** Assessed review band in thirds; only positive values qualify. */
  thirds: number;
}

export interface CreditedReviewer<Actor extends { id: string }> {
  actor: Actor;
  /** The reviewer's highest-band review; the one source record credited. */
  source: QualifyingReview<Actor>;
  shareThirds: number;
  /** The reviewer's other qualifying reviews; they add no credit. */
  repeatedReviewIds: string[];
}

export interface ReviewCreditAllocation<Actor extends { id: string }> {
  credited: CreditedReviewer<Actor>[];
  /** Qualifying reviews by reviewers after the first five. */
  beyondLimitReviewIds: string[];
}

function compareReviewTime(
  left: { submittedAt: string; reviewId: string },
  right: { submittedAt: string; reviewId: string },
): number {
  const difference =
    Date.parse(left.submittedAt) - Date.parse(right.submittedAt);
  if (difference !== 0) return difference;
  return left.reviewId < right.reviewId
    ? -1
    : left.reviewId > right.reviewId
      ? 1
      : 0;
}

/**
 * One explicit allocation for one pull request: dedupe by immutable reviewer
 * ID, order reviewers by their first qualifying review (submission time, then
 * review node ID), credit the first five, and split the pool by assessed band.
 * A reviewer's weight is their highest band, so repeated reviews cannot grow a
 * share. Callers exclude self-review, bot, post-merge and duplicate findings
 * before this step.
 */
export function allocatePullRequestReviewCredit<Actor extends { id: string }>(
  reviews: readonly QualifyingReview<Actor>[],
  poolThirds: number,
): ReviewCreditAllocation<Actor> {
  const seen = new Set<string>();
  const byReviewer = new Map<string, QualifyingReview<Actor>[]>();
  for (const review of reviews) {
    if (seen.has(review.reviewId))
      throw new Error("Review credit received a repeated review source");
    seen.add(review.reviewId);
    if (!Number.isFinite(Date.parse(review.submittedAt)))
      throw new Error("Qualifying review lacks a verified submission time");
    if (!Number.isSafeInteger(review.thirds) || review.thirds < 1)
      throw new RangeError("Qualifying review needs a positive band");
    const list = byReviewer.get(review.actor.id) ?? [];
    list.push(review);
    byReviewer.set(review.actor.id, list);
  }
  const reviewers = [...byReviewer.values()]
    .map((list) => {
      const ordered = [...list].sort(compareReviewTime);
      const first = ordered[0] as QualifyingReview<Actor>;
      const source = ordered.reduce((best, review) =>
        review.thirds > best.thirds ? review : best,
      );
      return { first, source, ordered };
    })
    .sort(
      (left, right) =>
        compareReviewTime(left.first, right.first) ||
        (left.first.actor.id < right.first.actor.id ? -1 : 1),
    );
  const creditedReviewers = reviewers.slice(0, MAX_CREDITED_REVIEWERS);
  const shares = creditedReviewers.length
    ? allocateReviewCredit(
        poolThirds,
        creditedReviewers.map((reviewer) => reviewer.source.thirds),
      )
    : [];
  return {
    credited: creditedReviewers.map((reviewer, index) => ({
      actor: reviewer.source.actor,
      source: reviewer.source,
      shareThirds: shares[index] as number,
      repeatedReviewIds: reviewer.ordered
        .filter((review) => review !== reviewer.source)
        .map((review) => review.reviewId),
    })),
    beyondLimitReviewIds: reviewers
      .slice(MAX_CREDITED_REVIEWERS)
      .flatMap((reviewer) => reviewer.ordered.map((review) => review.reviewId)),
  };
}
