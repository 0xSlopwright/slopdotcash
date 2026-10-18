import {
  ChevronRight,
  CircleAlert,
  ExternalLink,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DonorFundingProfile, useFundingIndex } from "./FundingRecords";
import { Link } from "./Link";
import { browserDeployment } from "./lib/browser-deployment";
import { readBoundedJson } from "./lib/browser-json";
import { isFundingAddress } from "./lib/funding";
import { githubUserIdFromNodeId } from "./lib/github-actor";
import { createGlobalLeaders } from "./lib/global-leaderboard";
import {
  type GitHubActor,
  PROFILE_OPPORTUNITY_LIMIT,
  type ScoreOpportunity,
} from "./lib/leaderboard";
import { findProject, type ProjectDefinition } from "./lib/projects.mjs";
import { formatThirds } from "./lib/reviewer-leaders";
import {
  type FundingReviewsState,
  useFundingReviews,
} from "./lib/use-funding-reviews";
import type { DataState } from "./lib/use-snapshot";
import { ProfilePoints } from "./Points";
import {
  ContributorIdentity,
  cycleLifecycleLabel,
  DataNotice,
  ExternalLinkAnchor,
  formatCycleMonth,
  formatDate,
  formatMicroUsdc,
  formatScore,
} from "./Presentation";
import { RewardValue } from "./ProjectLeaderboard";

export function ProfilePage({
  login,
  state,
  retry,
}: {
  login: string;
  state: DataState;
  retry: () => void;
}) {
  const [funding, retryFunding] = useFundingIndex();
  const [fundingReviews] = useFundingReviews(true);
  const currentWallet = useCurrentWallet(state, login, fundingReviews);
  if (state.status !== "ready")
    return (
      <main className="shell route-main">
        <ProfilePoints
          key={login.toLowerCase()}
          login={login}
          recordsLoading={state.status === "loading"}
          showIdentity
        />
        <DataNotice state={state} retry={retry} />
      </main>
    );
  const matches = state.views.flatMap((view) =>
    view.leaders
      .filter(
        (leader) => leader.actor.login.toLowerCase() === login.toLowerCase(),
      )
      .map((leader) => ({ leader, view })),
  );
  const history = state.cycleIndex.cycles.flatMap((cycle) =>
    cycle.contributors
      .filter(
        (contributor) =>
          contributor.actor.login.toLowerCase() === login.toLowerCase(),
      )
      .map((contributor) => ({ contributor, cycle })),
  );
  const loginOpportunities = state.views.flatMap((view) =>
    view.opportunities
      .filter(
        (opportunity) =>
          opportunity.actor.login.toLowerCase() === login.toLowerCase(),
      )
      .map((opportunity) => ({ opportunity, project: view.project })),
  );
  const globalLeaders = createGlobalLeaders(
    state.snapshot,
    state.views,
    state.cycleIndex,
  );
  const globalRank = globalLeaders.findIndex(
    (leader) => leader.actor.login.toLowerCase() === login.toLowerCase(),
  );
  const globalLeader =
    globalRank === -1 ? undefined : globalLeaders[globalRank];
  // A frozen month with no cycle directory still records the contributor.
  const preparations =
    fundingReviews.status === "ready"
      ? fundingReviews.index.reviews
          .filter(
            (review) =>
              !state.cycleIndex.cycles.some(
                (cycle) =>
                  cycle.projectId === review.projectId &&
                  cycle.cycleId === review.cycleId,
              ),
          )
          .flatMap((review) =>
            review.contributors
              .filter(
                (contributor) =>
                  contributor.actor.login.toLowerCase() === login.toLowerCase(),
              )
              .map((contributor) => ({ contributor, review })),
          )
          .sort(
            (left, right) =>
              right.review.cycleId.localeCompare(left.review.cycleId) ||
              left.review.projectId.localeCompare(right.review.projectId),
          )
      : [];
  if (
    matches.length === 0 &&
    history.length === 0 &&
    !globalLeader &&
    loginOpportunities.length === 0 &&
    preparations.length === 0
  ) {
    if (fundingReviews.status === "loading")
      return (
        <main className="shell route-main" aria-busy="true">
          <ContributorIdentity
            actor={{
              login,
              avatarUrl: `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?size=160`,
              url: `https://github.com/${encodeURIComponent(login)}`,
            }}
          />
          <p className="data-notice" role="status">
            Checking frozen months…
          </p>
        </main>
      );
    return (
      <main className="shell route-main">
        <ProfilePoints
          key={login.toLowerCase()}
          login={login}
          cycles={state.cycleIndex}
          showIdentity
          notFoundWhenUnrecorded={fundingReviews.status === "ready"}
        />
      </main>
    );
  }
  const historicalActor =
    history[0]?.contributor.actor ?? preparations[0]?.contributor.actor;
  const opportunityActor = loginOpportunities[0]?.opportunity.actor;
  const actor: GitHubActor = globalLeader?.actor ??
    matches[0]?.leader.actor ??
    opportunityActor ?? {
      id: historicalActor?.id ?? `historical:${login.toLowerCase()}`,
      login: historicalActor?.login ?? login,
      avatarUrl: `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?size=160`,
      url: `https://github.com/${encodeURIComponent(login)}`,
      kind: "User",
    };
  const events = state.snapshot.ledger.filter(
    (event) => event.actor.id === actor.id,
  );
  const opportunities = loginOpportunities
    .filter(({ opportunity }) => opportunity.actor.id === actor.id)
    .sort(
      (left, right) =>
        Date.parse(right.opportunity.occurredAt) -
          Date.parse(left.opportunity.occurredAt) ||
        left.opportunity.source.number - right.opportunity.source.number ||
        left.opportunity.id.localeCompare(right.opportunity.id),
    )
    .slice(0, PROFILE_OPPORTUNITY_LIMIT);
  // Outside the rolling window the frozen months are the only scored record.
  const score = globalLeader
    ? formatScore(globalLeader.score)
    : formatThirds(
        preparations.reduce(
          (total, { contributor }) => total + Number(contributor.scoreThirds),
          0,
        ),
      );
  // Closed cycles replace their overlapping ledger events in this cumulative score.
  const scoreLabel = globalLeader ? "Slop Score" : "Slop Score · frozen months";
  const historicalWallet = history.find(({ contributor }) => contributor.wallet)
    ?.contributor.wallet;
  const wallet =
    currentWallet.status === "ready" ? currentWallet : historicalWallet;
  return (
    <main className="shell route-main profile-page">
      <DataNotice state={state} retry={retry} />
      <ContributorIdentity actor={actor}>
        {wallet ? (
          <ExternalLinkAnchor
            className="profile-wallet"
            href={wallet.sourceUrl}
          >
            {currentWallet.status === "ready" ? "Wallet" : "Past wallet"} ·{" "}
            {shortAddress(wallet.address)}
          </ExternalLinkAnchor>
        ) : currentWallet.status === "loading" ? (
          <span>Checking wallet…</span>
        ) : (
          <Link href="/account#wallets">Add a payout wallet</Link>
        )}
      </ContributorIdentity>
      <ProfilePoints
        key={login.toLowerCase()}
        actorId={actor.id}
        work={events}
        login={login}
        cycles={state.cycleIndex}
        summary={
          <>
            {globalRank >= 0 ? (
              <div>
                <strong>#{globalRank + 1}</strong>
                <span>overall rank</span>
              </div>
            ) : null}
            <div>
              <strong title="Closed cycles and ledger events outside those cycles">
                {score}
              </strong>
              <span>{scoreLabel}</span>
            </div>
          </>
        }
      >
        {matches.length > 0 ? (
          <section className="profile-card" aria-label="Projects">
            <div className="profile-card-heading">
              <h2>Projects</h2>
              <span>{formatCycleMonth(matches[0].view.cycle.id)}</span>
            </div>
            <ul className="project-bars">
              {matches
                .slice()
                .sort((left, right) => right.leader.score - left.leader.score)
                .map(({ leader, view }) => {
                  const totalWeight = view.leaders.reduce(
                    (total, entry) => total + entry.adjustedWeight,
                    0,
                  );
                  const share =
                    totalWeight > 0 ? leader.adjustedWeight / totalWeight : 0;
                  return (
                    <li key={view.project.id}>
                      <Link href={`/projects/${view.project.slug}`}>
                        <span className="project-bar-label">
                          <strong>{view.project.name}</strong>
                          <small title={`Exact score ${leader.scoreThirds}/3`}>
                            {formatThirds(leader.scoreThirds)} score ·{" "}
                            <RewardValue leader={leader} view={view} />
                          </small>
                        </span>
                        <span className="project-bar-track" aria-hidden="true">
                          <span
                            style={{ width: `${Math.max(2, share * 100)}%` }}
                          />
                        </span>
                      </Link>
                    </li>
                  );
                })}
            </ul>
          </section>
        ) : null}
      </ProfilePoints>
      {opportunities.length > 0 ? (
        <section className="section profile-section">
          <div className="profile-section-heading">
            <h2>Open work</h2>
            <span>{opportunities.length} available</span>
          </div>
          <OpportunityList opportunities={opportunities} />
        </section>
      ) : null}
      {history.length > 0 ? (
        <section className="section profile-section">
          <div className="profile-section-heading">
            <h2>Past cycles</h2>
          </div>
          <div className="profile-projects">
            {history.map(({ contributor, cycle }) => (
              <Link
                href={`/cycles/${cycle.projectId}/${cycle.cycleId}`}
                key={`${cycle.projectId}:${cycle.cycleId}`}
              >
                <span>
                  <strong>
                    {findProject(cycle.projectId)?.name ?? cycle.projectId}
                  </strong>
                  <small>{formatCycleMonth(cycle.cycleId)}</small>
                </span>
                <span>
                  <strong>{contributor.score} score</strong>
                  <small>
                    <span
                      className={`payout-state payout-state-${contributor.state}`}
                    >
                      {contributor.state === "paid"
                        ? "Paid"
                        : cycleLifecycleLabel(cycle)}
                    </span>
                  </small>
                </span>
                <span>
                  <strong>
                    {formatMicroUsdc(
                      contributor.state === "paid"
                        ? contributor.paidMinor
                        : contributor.approvedMinor !== "0"
                          ? contributor.approvedMinor
                          : contributor.suggestedMinor,
                    )}
                  </strong>
                  <small>
                    {contributor.state === "paid"
                      ? "paid"
                      : contributor.state.replaceAll("-", " ")}
                  </small>
                </span>
                <ChevronRight aria-hidden="true" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      {preparations.length > 0 ? (
        <section className="section profile-section">
          <div className="profile-section-heading">
            <h2>Frozen months</h2>
            <span>scored, not approved</span>
          </div>
          <div className="profile-projects">
            {preparations.map(({ contributor, review }) => {
              const project = findProject(review.projectId);
              return (
                <Link
                  href={`/projects/${project?.slug ?? review.projectId}/funding`}
                  key={`${review.projectId}:${review.cycleId}`}
                >
                  <span>
                    <strong>{project?.name ?? review.projectId}</strong>
                    <small>{review.cycleId} · preparation</small>
                  </span>
                  <span>
                    <strong title={`Exact score ${contributor.scoreThirds}/3`}>
                      {formatThirds(Number(contributor.scoreThirds))} score
                    </strong>
                    <small>
                      {contributor.eventCount} scored event
                      {contributor.eventCount === 1 ? "" : "s"}
                    </small>
                  </span>
                  <span>
                    <strong>
                      {contributor.simulatedMinor === null
                        ? "External prize share"
                        : formatMicroUsdc(contributor.simulatedMinor)}
                    </strong>
                    <small>
                      {contributor.wallet
                        ? "simulated · wallet on file at freeze"
                        : "simulated · unclaimed, no wallet at freeze"}
                    </small>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </Link>
              );
            })}
          </div>
        </section>
      ) : fundingReviews.status === "error" ? (
        <section className="section profile-section">
          <div className="data-notice data-error" role="alert">
            <CircleAlert aria-hidden="true" size={18} /> Frozen month records
            unavailable: {fundingReviews.message}
          </div>
        </section>
      ) : null}
      {funding.status === "error" ? (
        <section className="section profile-section">
          <div className="data-notice data-error" role="alert">
            <CircleAlert aria-hidden="true" size={18} />
            <span>Public donor records unavailable: {funding.message}</span>
            <button onClick={retryFunding} type="button">
              <RotateCcw aria-hidden="true" size={15} /> Retry
            </button>
          </div>
        </section>
      ) : funding.status === "ready" ? (
        <DonorFundingProfile actor={actor} records={funding.index.records} />
      ) : null}
    </main>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function useCurrentWallet(
  state: DataState,
  login: string,
  fundingReviews: FundingReviewsState,
): CurrentWalletState {
  const [wallet, setWallet] = useState<CurrentWalletState>({
    status: "loading",
  });
  const normalizedLogin = login.toLowerCase();
  // Funding reviews matter only for an actor outside the rolling window and
  // the cycles. Reduce the inputs to primitive values, so a window actor's
  // request does not restart when the reviews finish loading.
  const lookup = useMemo(
    () => findWalletLookup(state, normalizedLogin, fundingReviews),
    [state, normalizedLogin, fundingReviews],
  );
  const lookupStatus = lookup.status;
  const githubActorId = lookup.status === "actor" ? lookup.githubActorId : "";
  useEffect(() => {
    if (lookupStatus === "waiting") {
      setWallet({ status: "loading" });
      return;
    }
    if (lookupStatus === "error") {
      setWallet({ status: "error", login: normalizedLogin });
      return;
    }
    if (lookupStatus === "none") {
      setWallet({ status: "none", login: normalizedLogin });
      return;
    }
    setWallet({ status: "loading" });
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(new Error("wallet claim request timed out")),
      WALLET_CLAIM_TIMEOUT_MS,
    );
    void fetch(
      `${browserDeployment.api}/api/v1/wallet-claims/actors/${githubActorId}/current`,
      {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return readBoundedJson(
          response,
          MAX_WALLET_CLAIM_BYTES,
          "Wallet claim",
        );
      })
      .then((value) => {
        if (!active) return;
        if (value === null) {
          setWallet({ status: "none", login: normalizedLogin });
          return;
        }
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value)
        ) {
          throw new TypeError("Wallet claim must be an object");
        }
        const claim = value as Record<string, unknown>;
        if (
          typeof claim.claimId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(claim.claimId) ||
          claim.githubActorId !== githubActorId ||
          typeof claim.address !== "string" ||
          !isFundingAddress("solana", claim.address)
        ) {
          throw new TypeError("Wallet claim has invalid actor-bound metadata");
        }
        setWallet({
          status: "ready",
          address: claim.address,
          login: normalizedLogin,
          sourceUrl: `${browserDeployment.api}/api/v1/wallet-claims/${claim.claimId}`,
        });
      })
      .catch(() => {
        if (active) setWallet({ status: "error", login: normalizedLogin });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [lookupStatus, githubActorId, normalizedLogin]);
  if (wallet.status !== "loading" && wallet.login !== normalizedLogin) {
    return { status: "loading" };
  }
  return wallet;
}

type WalletLookup =
  | { status: "waiting" }
  | { status: "error" }
  | { status: "none" }
  | { status: "actor"; githubActorId: string };

function findWalletLookup(
  state: DataState,
  normalizedLogin: string,
  fundingReviews: FundingReviewsState,
): WalletLookup {
  if (state.status !== "ready") return { status: "waiting" };
  const actors: Array<{ id: string; login: string; avatarUrl?: string }> = [
    ...state.views.flatMap((view) => [
      ...view.leaders.map((leader) => leader.actor),
      ...view.opportunities.map((opportunity) => opportunity.actor),
    ]),
    ...state.cycleIndex.cycles.flatMap((cycle) =>
      cycle.contributors.map((contributor) => contributor.actor),
    ),
  ];
  const windowActor = actors.find(
    (candidate) => candidate.login.toLowerCase() === normalizedLogin,
  );
  // A frozen-month-only actor is in neither list; its review record has it.
  if (!windowActor && fundingReviews.status === "loading") {
    return { status: "waiting" };
  }
  if (!windowActor && fundingReviews.status !== "ready") {
    return { status: "error" };
  }
  const actor: { id: string; login: string; avatarUrl?: string } | undefined =
    windowActor ??
    (fundingReviews.status === "ready"
      ? fundingReviews.index.reviews
          .flatMap((review) => review.contributors)
          .map((contributor) => contributor.actor)
          .find(
            (candidate) => candidate.login.toLowerCase() === normalizedLogin,
          )
      : undefined);
  if (!actor) return { status: "none" };
  const avatarActorId = actor.avatarUrl
    ? /^https:\/\/avatars\.githubusercontent\.com\/u\/(\d+)(?:\?|$)/u.exec(
        actor.avatarUrl,
      )?.[1]
    : undefined;
  // Frozen-month records keep only the GitHub node id, which encodes the
  // numeric id that wallet claims are keyed by.
  const githubActorId = /^\d+$/u.test(actor.id)
    ? actor.id
    : (githubUserIdFromNodeId(actor.id) ?? avatarActorId);
  return githubActorId
    ? { status: "actor", githubActorId }
    : { status: "error" };
}

type CurrentWalletState =
  | { status: "loading" }
  | { status: "none"; login: string }
  | { status: "error"; login: string }
  | { status: "ready"; address: string; login: string; sourceUrl: string };

const WALLET_CLAIM_TIMEOUT_MS = 12_000;

const MAX_WALLET_CLAIM_BYTES = 16 * 1024;

function OpportunityList({
  opportunities,
}: {
  opportunities: Array<{
    opportunity: ScoreOpportunity;
    project: ProjectDefinition;
  }>;
}) {
  return (
    <div className="event-list opportunity-list">
      {opportunities.map(({ opportunity, project }) => (
        <ExternalLinkAnchor href={opportunity.source.url} key={opportunity.id}>
          <span className="event-points">
            {opportunityPointsLabel(opportunity)}
          </span>
          <span>
            <strong>{opportunity.hint}</strong>
            <small>
              {opportunity.source.title} · {project.name} ·{" "}
              {formatDate(opportunity.occurredAt)}
            </small>
          </span>
          <ExternalLink aria-hidden="true" size={16} />
        </ExternalLinkAnchor>
      ))}
    </div>
  );
}

function opportunityPointsLabel(opportunity: ScoreOpportunity): string {
  if (
    opportunity.kind === "missing-evidence" ||
    opportunity.kind === "partial-evidence"
  ) {
    return "Evidence guidance";
  }
  return opportunity.kind === "expand-review"
    ? "Review guidance"
    : "Test guidance";
}
