import { type FormEvent, useState } from "react";
import type { reviewOwnerAwards } from "../backend/payments/owner-review";
import { readBoundedJson } from "./lib/browser-json";
import { formatBaseUnits } from "./lib/payments/contracts";
import type { ProjectDefinition } from "./lib/projects.mjs";
import { loginHref } from "./Points";

type Review = Awaited<ReturnType<typeof reviewOwnerAwards>>;
function previousMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
}
export default function OwnerAwards({
  project,
}: {
  project: ProjectDefinition;
}) {
  const [cycle, setCycle] = useState(previousMonth);
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  async function load(event: FormEvent) {
    event.preventDefault();
    setReview(null);
    setError("");
    setSignedOut(false);
    setLoading(true);
    try {
      const response = await fetch(
        `/api/v1/payments/projects/${encodeURIComponent(project.id)}/awards/${cycle}`,
        { signal: AbortSignal.timeout(120000) },
      );
      const body = (await readBoundedJson(
        response,
        8 * 1024 * 1024,
        "Owner award review",
      )) as Review & { message?: string };
      if (response.status === 401) {
        setSignedOut(true);
        return;
      }
      if (!response.ok)
        throw new Error(body.message ?? "Award review is unavailable. Retry.");
      if (
        body.projectId !== project.id ||
        body.cycleId !== cycle ||
        !Array.isArray(body.proposal?.awards) ||
        typeof body.reviewVerified !== "boolean"
      )
        throw new Error("The award review response could not be verified.");
      setReview(body);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Award review is unavailable. Retry.",
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="shell route-main owner-awards-page">
      <p>
        <a href={`/projects/${project.slug}`}>{project.name}</a> / Awards
      </p>
      <h1>Review awards</h1>
      <form onSubmit={load}>
        <label>
          Contribution month
          <input
            type="month"
            required
            value={cycle}
            disabled={loading}
            onChange={(event) => {
              setCycle(event.target.value);
              setReview(null);
            }}
          />
        </label>
        <button
          className="button primary-button"
          type="submit"
          disabled={loading}
        >
          {loading ? "Checking published review…" : "Load awards"}
        </button>
      </form>
      {signedOut && (
        <p>
          <a href={loginHref(`/projects/${project.slug}/awards`)}>
            Sign in with GitHub to review this project’s awards
          </a>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {review && (
        <section aria-label="Published award review">
          <h2>{review.cycleId} awards</h2>
          <p role="status">
            {review.reviewVerified
              ? "Published review verified."
              : review.blockedReason}
          </p>
          {review.reviewEndsAt && (
            <p>
              Review ends{" "}
              <time dateTime={review.reviewEndsAt}>
                {new Date(review.reviewEndsAt).toLocaleString()}
              </time>
              .
            </p>
          )}
          <p>
            <a href={review.sourceUrl} target="_blank" rel="noreferrer">
              Review evidence on GitHub
            </a>
          </p>
          <p>
            Approved awards need the owner’s wallet authorization and sufficient
            free funding.
          </p>
          {review.proposal.awards.length === 0 ? (
            <p>No awards in this cycle.</p>
          ) : (
            <ul className="owner-award-list" aria-label="Cycle awards">
              {review.proposal.awards.map((award) => {
                const decision = review.decisions?.rows.find(
                  (row) => row.githubUserId === award.githubUserId,
                );
                return (
                  <li key={award.githubUserId}>
                    <h3>{award.login}</h3>
                    <dl>
                      <dt>Published decision</dt>
                      <dd>{decision?.state ?? "Under review"}</dd>
                      <dt>Proposed gross</dt>
                      <dd>
                        {review.asset
                          ? `${formatBaseUnits(award.grossMicro, review.asset.decimals)} ${review.asset.symbol}`
                          : `${award.grossMicro} token base units`}
                      </dd>
                      <dt>Approved gross</dt>
                      <dd>
                        {decision
                          ? review.asset
                            ? `${formatBaseUnits(decision.approvedGrossMicro, review.asset.decimals)} ${review.asset.symbol}`
                            : `${decision.approvedGrossMicro} token base units`
                          : "Not approved"}
                      </dd>
                    </dl>
                    {decision?.adjustmentReason && (
                      <p>{decision.adjustmentReason}</p>
                    )}
                    {decision?.relatedParty &&
                      decision.state === "approved" && (
                        <p>
                          {review.reviewVerified
                            ? "Separate related-party approval verified."
                            : "Separate related-party approval is required before commitment."}
                        </p>
                      )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      <p>
        <a href={`/projects/${project.slug}/funding`}>Project funding</a> ·{" "}
        <a href={`/projects/${project.slug}/manage`}>Project settings</a>
      </p>
    </main>
  );
}
