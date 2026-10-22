/**
 * Private security bounty pages (PRD SEC-01 to SEC-18, MVP-13).
 *
 * `/projects/:id/security` shows the public program terms and hands a
 * researcher to the project's GitHub private vulnerability reporting only
 * after a fresh readiness check. `/security` is the signed-in case inbox. The
 * API returns only the cases and fields the caller's current role allows.
 */
import { CircleAlert, ExternalLink, RotateCcw } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SignInPanel } from "./Admin";
import { Link } from "./Link";
import {
  ProjectApiError,
  projectApiRequest,
  useProjectSession,
} from "./lib/project-api";
import { PROJECTS, type ProjectDefinition } from "./lib/projects.mjs";
import {
  formatSecurityAmount,
  type SecurityBountyTerms,
  securityBountySplit,
} from "./lib/security-bounty.mjs";
import {
  ExternalLinkAnchor,
  formatNullableUtc as formatUtc,
  NotFound,
} from "./Presentation";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function amounts(terms: SecurityBountyTerms) {
  const split = securityBountySplit(terms.amount.grossMinor);
  return {
    gross: formatSecurityAmount(split.grossMinor, terms.amount),
    researcher: formatSecurityAmount(split.researcherMinor, terms.amount),
    slop: formatSecurityAmount(split.slopMinor, terms.amount),
  };
}

const PROGRAM_STATUS_LABELS: Record<SecurityBountyTerms["status"], string> = {
  draft: "Draft — not accepting paid reports",
  "pending-approval": "Waiting for approval — not accepting paid reports",
  open: "Open for paid reports",
  paused: "Paused — no new paid reports; private reporting stays open",
  closed: "Closed — no new paid reports; private reporting stays open",
};

type Readiness = {
  state: "ready" | "disabled" | "forbidden" | "unavailable";
  checkedAt: string;
  maxAgeSeconds: number;
  paidParticipation: "open" | "closed";
  handoffUrl: string | null;
};

type ReadinessState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "error"; message: string }
  | { status: "checked"; value: Readiness; stale: boolean };

const BLOCKED_INTAKE: Record<Exclude<Readiness["state"], "ready">, string> = {
  disabled:
    "GitHub private vulnerability reporting is turned off for this repository. Slop cannot hand you to a private report form.",
  forbidden:
    "GitHub refused the readiness check. Slop cannot confirm that private reporting is available.",
  unavailable:
    "GitHub did not answer the readiness check. Slop cannot confirm that private reporting is available.",
};

/**
 * Checks private reporting and shows the GitHub handoff only while the
 * answer is fresh. Every other state blocks the handoff (SEC-07).
 */
function IntakeHandoff({ project }: { project: ProjectDefinition }) {
  const [state, setState] = useState<ReadinessState>({ status: "idle" });
  const check = useCallback(() => {
    setState({ status: "checking" });
    projectApiRequest<Readiness>(
      "GET",
      `security-programs/${encodeURIComponent(project.id)}/intake`,
    ).then(
      (value) => setState({ status: "checked", value, stale: false }),
      (error: unknown) =>
        setState({ status: "error", message: errorMessage(error) }),
    );
  }, [project.id]);
  // The answer expires on this device's clock from when it arrived, so a
  // skewed clock cannot hide or extend it. The edge serves it at most
  // `maxAgeSeconds` old, so the handoff never relies on an older check.
  useEffect(() => {
    if (state.status !== "checked" || state.stale) return;
    const timer = window.setTimeout(
      () =>
        setState((current) =>
          current.status === "checked" ? { ...current, stale: true } : current,
        ),
      state.value.maxAgeSeconds * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <section aria-labelledby="security-report" className="admin-card">
      <h2 id="security-report">Report a vulnerability privately</h2>
      <p>
        Send every suspected critical finding and every suspected loss of funds
        through the private route, also when you are not sure about the
        severity. Do not put details in a public issue, pull request, gist, chat
        or video. You do not need a Slop account or a wallet to report.
      </p>
      <p>
        The report goes to GitHub private vulnerability reporting for this
        repository. You review and submit it on GitHub. Slop does not store your
        report. A redirect is not a receipt: your case is submitted only after a
        security maintainer confirms the GitHub report.
      </p>
      {state.status === "idle" ? (
        <button className="button primary-button" onClick={check} type="button">
          Check private reporting
        </button>
      ) : state.status === "checking" ? (
        <p aria-live="polite" className="admin-status">
          Checking GitHub private reporting…
        </p>
      ) : state.status === "error" ? (
        <div className="form-error" role="alert">
          <CircleAlert aria-hidden="true" /> {state.message} Slop cannot hand
          you to a private report form until the check succeeds.
          <button className="text-button" onClick={check} type="button">
            <RotateCcw aria-hidden="true" /> Check again
          </button>
        </div>
      ) : state.stale ? (
        <div className="form-error" role="alert">
          <CircleAlert aria-hidden="true" /> The readiness check from{" "}
          {formatUtc(state.value.checkedAt)} is out of date.
          <button className="text-button" onClick={check} type="button">
            <RotateCcw aria-hidden="true" /> Check again
          </button>
        </div>
      ) : state.value.state === "ready" && state.value.handoffUrl ? (
        <div aria-live="polite" className="security-handoff">
          <p className="admin-status">
            GitHub private reporting is on (checked{" "}
            {formatUtc(state.value.checkedAt)}).{" "}
            {state.value.paidParticipation === "open"
              ? "This program accepts paid reports."
              : "This program does not accept new paid reports now. Private reporting stays open."}
          </p>
          <a
            className="button primary-button"
            href={state.value.handoffUrl}
            rel="noreferrer"
            target="_blank"
          >
            Report privately on GitHub <ExternalLink aria-hidden="true" />
          </a>
        </div>
      ) : (
        <div className="form-error" role="alert">
          <CircleAlert aria-hidden="true" />{" "}
          {
            BLOCKED_INTAKE[
              state.value.state as Exclude<Readiness["state"], "ready">
            ]
          }{" "}
          Do not use a public channel. Keep your notes private and check again
          later.
          <button className="text-button" onClick={check} type="button">
            <RotateCcw aria-hidden="true" /> Check again
          </button>
        </div>
      )}
      <p>
        Did you already submit the report on GitHub?{" "}
        <Link href="/security">Link it to a private Slop case</Link>. Your
        original GitHub receipt time stays the same.
      </p>
    </section>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function people(list: SecurityBountyTerms["approvers"]["technical"]): string {
  return list.map((entry) => `@${entry.githubLogin}`).join(", ");
}

/** Public program terms and the verified private handoff. */
export function SecurityProgramPage({
  project,
}: {
  project: ProjectDefinition;
}) {
  const terms = project.securityBounty;
  if (terms === undefined)
    return <NotFound title="This project has no security bounty program" />;
  const money = amounts(terms);
  const { scope } = terms;
  return (
    <main className="shell route-main admin-page security-page">
      <div className="admin-intro">
        <p>
          <Link href={`/projects/${project.slug}`}>{project.name}</Link>
        </p>
        <h1>Security bounty</h1>
        <p className="security-lead">
          {money.researcher} for a confirmed critical vulnerability that can
          cause loss of funds. Funded by {terms.sponsor.name}.
        </p>
        <p>{PROGRAM_STATUS_LABELS[terms.status]}.</p>
      </div>
      <IntakeHandoff project={project} />
      <section aria-labelledby="security-terms" className="admin-card">
        <h2 id="security-terms">Award terms</h2>
        <dl className="admin-facts">
          <Fact term="Researcher award (75%)">{money.researcher}</Fact>
          <Fact term="Gross funding per eligible finding">{money.gross}</Fact>
          <Fact term="Slop share (25%)">{money.slop}</Fact>
          <Fact term="Currency">
            {terms.amount.currency}
            {terms.amount.network ? ` on ${terms.amount.network}` : ""}
          </Fact>
          <Fact term="Funding">
            {terms.funding.state === "pledged"
              ? "Pledged. A pledge is not a verified balance."
              : `Verified available on ${formatUtc(terms.funding.verifiedAt)}: ${terms.funding.evidence}`}
          </Fact>
          <Fact term="Capacity">
            {terms.capacity.awards} fundable award
            {terms.capacity.awards === 1 ? "" : "s"}
            {terms.capacity.closesAt
              ? `; closes ${formatUtc(terms.capacity.closesAt)}`
              : ""}
            . {terms.capacity.exhaustionRule}
          </Fact>
          <Fact term="Other work">
            {terms.rewardMode === "bounty-only"
              ? "Bounty only. Other accepted work earns no bounty and no monthly pool cash, also when it fixes a reported issue."
              : "The project's ordinary contribution rewards are separate. One outcome is never paid twice."}
          </Fact>
        </dl>
        <p>
          Only a human security reviewer can make a finding eligible. The
          reviewer must confirm critical severity and a reproducible path to
          loss of funds on an in-scope asset. Proven potential loss qualifies;
          nobody needs to lose funds. A severity label, scanner output or public
          fix alone is not sufficient. No additional payout fee applies. The
          amount and policy in force when GitHub received your report stay fixed
          for your case.
        </p>
      </section>
      <section aria-labelledby="security-scope" className="admin-card">
        <h2 id="security-scope">Scope</h2>
        <dl className="admin-facts">
          <Fact term="Covered source">
            <ul>
              {scope.sourceRevisions.map((source) => (
                <li key={`${source.repository}@${source.commit}`}>
                  <ExternalLinkAnchor
                    href={`https://github.com/${source.repository}/tree/${source.commit}`}
                  >
                    {source.repository}@{source.commit.slice(0, 12)}
                  </ExternalLinkAnchor>
                </li>
              ))}
            </ul>
          </Fact>
          <Fact term="Deployments">
            {scope.deployments.length === 0 ? (
              "None listed"
            ) : (
              <ul>
                {scope.deployments.map((deployment) => (
                  <li key={`${deployment.network}:${deployment.address}`}>
                    {deployment.network}: <code>{deployment.address}</code>
                    {deployment.codeIdentity
                      ? ` (${deployment.codeIdentity})`
                      : ""}
                  </li>
                ))}
              </ul>
            )}
          </Fact>
          <Fact term="Included assets">{scope.includedAssets.join("; ")}</Fact>
          <Fact term="Excluded dependencies">
            {scope.excludedDependencies.length === 0
              ? "None listed"
              : scope.excludedDependencies.join("; ")}
          </Fact>
          <Fact term="Testing permission">{scope.testingPermission}</Fact>
          <Fact term="Severity rubric">{scope.severityRubric}</Fact>
          <Fact term="Loss of funds">{scope.lossDefinition}</Fact>
        </dl>
        <p>
          Do not exploit a production system, move another person's funds,
          reveal keys or cause damage. A local fork or isolated test can show
          potential loss.
        </p>
      </section>
      <section aria-labelledby="security-trust" className="admin-card">
        <h2 id="security-trust">Decisions, disputes and disclosure</h2>
        <dl className="admin-facts">
          <Fact term="Technical decisions">
            {people(terms.approvers.technical)}
          </Fact>
          <Fact term="Award approval and payment">
            {people(terms.approvers.financial)}
          </Fact>
          <Fact term="Independent dispute review">
            {people(terms.approvers.dispute)} ({terms.dispute.authority}).{" "}
            {terms.dispute.process}
          </Fact>
          <Fact term="Response targets">
            Acknowledge within {terms.responseTargets.acknowledgeHours} hours;
            first triage within {terms.responseTargets.triageBusinessDays}{" "}
            business days; updates every{" "}
            {terms.responseTargets.updateIntervalDays} days. A missed target
            never publishes a report or approves an award.
          </Fact>
          <Fact term="Disclosure">{terms.disclosure}</Fact>
          <Fact term="Safe harbor">{terms.safeHarbor}</Fact>
        </dl>
        <p>
          Maintainer judgment is part of this program. Validity, severity,
          scope, duplicates and acceptance cannot be proven from blockchain
          records. Funding can lower the risk of nonpayment, but it cannot prove
          that a finding is valid or force a fair classification. A pledge or a
          reserve label is not a payment guarantee.
        </p>
        <p>
          Slop does not publish cases. Rejected, duplicate, disputed and paid
          reports stay private. A payment does not publish a report, and you
          decide separately whether your name is public. GitHub repository
          administrators and security managers can read GitHub advisories under
          GitHub's own rules; Slop cannot narrow that access. A public-chain
          payment shows its addresses, amount and time.
        </p>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Signed-in case inbox

type Terms = {
  grossMinor: string;
  researcherMinor: string;
  slopMinor: string;
  currency: "USD" | "USDC";
  decimals: 2 | 6;
  network: string | null;
};

type CaseEvent = {
  revision: number;
  kind: string;
  at: string;
  reason: string | null;
  actorRole?: string;
  evidenceReference?: string | null;
  detail?: {
    redactedContentDigest?: string | null;
    embargoChange?: string | null;
  };
};

type SecurityCase = {
  id: string;
  projectId: string;
  revision: number;
  view: "restricted" | "reporter" | "financial";
  viewerRoles: string[];
  allowedActions: string[];
  submissionState: "claimed" | "verified" | "link-rejected";
  receivedAt: string | null;
  /** Slop does not read the advisory; a maintainer enters the time. */
  receivedAtSource: "maintainer-attested" | null;
  policyRevision: number | null;
  terms: Terms | null;
  awardState: string;
  relatedParty: "not-assessed" | "unrelated" | "related";
  relatedPartyReview: "not-applicable" | "pending" | "approved" | "refused";
  paymentState: string;
  paymentRail: "unavailable";
  paymentDeadline: string | null;
  advisory?: { repository: string; ghsa: string; url: string };
  receiptState?: string;
  remediationState?: string;
  disclosureState?: string;
  recognition?: string;
  severity?: string | null;
  lossFinding?: string | null;
  appealState?: string;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  overdue?: boolean;
  reporter?: { githubId: string; githubLogin: string };
  payee?: { githubLogin: string };
  rootCauseKey?: string | null;
  duplicateOf?: string | null;
  evidenceDigest?: string | null;
  triagers?: {
    githubId: string;
    githubLogin: string;
    revokedAt: string | null;
  }[];
  events?: CaseEvent[];
};

type CaseList = {
  viewer: { githubId: string; githubLogin: string };
  programs: { projectId: string; roles: string[] }[];
  cases: SecurityCase[];
};

type Loaded<T> =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T };

function useSecurityData<T>(
  path: string | null,
): [Loaded<T>, () => void, (value: T) => void] {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const generation = useRef(0);
  const load = useCallback(() => {
    if (path === null) return;
    const current = ++generation.current;
    // A refresh keeps the loaded view, so an open case stays mounted.
    setState((previous) =>
      previous.status === "ready" ? previous : { status: "loading" },
    );
    projectApiRequest<T>("GET", path).then(
      (value) => {
        if (generation.current === current)
          setState({ status: "ready", value });
      },
      (error: unknown) => {
        if (generation.current !== current) return;
        setState(
          error instanceof ProjectApiError && error.status === 401
            ? { status: "signed-out" }
            : { status: "error", message: errorMessage(error) },
        );
      },
    );
  }, [path]);
  useEffect(() => {
    load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  const replace = useCallback(
    (value: T) => setState({ status: "ready", value }),
    [],
  );
  return [state, load, replace];
}

function requestKey(): string {
  return crypto.randomUUID();
}

function caseMoney(terms: Terms | null): string {
  if (terms === null) return "No paid terms were in force at receipt";
  return `${formatSecurityAmount(terms.researcherMinor, terms)} researcher · ${formatSecurityAmount(terms.slopMinor, terms)} Slop · ${formatSecurityAmount(terms.grossMinor, terms)} gross`;
}

const SUBMISSION_LABELS: Record<SecurityCase["submissionState"], string> = {
  claimed: "Not submitted yet — waiting for a maintainer to verify the link",
  verified: "Submitted and verified",
  "link-rejected":
    "Link rejected — link the GitHub report again, or ask a maintainer to record it",
};

function ProjectSelect({
  projects,
  value,
  onChange,
}: {
  projects: ProjectDefinition[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      Project
      <select onChange={(event) => onChange(event.target.value)} value={value}>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A reporter links a GitHub advisory they already submitted. */
function ClaimForm({
  programProjects,
  onCreated,
}: {
  programProjects: ProjectDefinition[];
  onCreated: (created: SecurityCase) => void;
}) {
  const [projectId, setProjectId] = useState(programProjects[0]?.id ?? "");
  const [advisory, setAdvisory] = useState("");
  const [key, setKey] = useState(requestKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (programProjects.length === 0)
    return (
      <p className="admin-status">No project runs a security program yet.</p>
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    projectApiRequest<{ case: SecurityCase }>("POST", "security-cases", {
      mode: "claim",
      projectId,
      advisory: advisory.trim(),
      idempotencyKey: key,
    }).then(
      (body) => {
        setBusy(false);
        setAdvisory("");
        setKey(requestKey());
        onCreated(body.case);
      },
      (caught: unknown) => {
        setBusy(false);
        setError(errorMessage(caught));
      },
    );
  };
  return (
    <form className="security-form" onSubmit={submit}>
      <ProjectSelect
        onChange={setProjectId}
        projects={programProjects}
        value={projectId}
      />
      <label>
        GitHub advisory ID
        <input
          autoComplete="off"
          onChange={(event) => setAdvisory(event.target.value)}
          pattern="GHSA-[2-9cfghjmpqrvwx]{4}-[2-9cfghjmpqrvwx]{4}-[2-9cfghjmpqrvwx]{4}"
          placeholder="GHSA-xxxx-xxxx-xxxx"
          required
          spellCheck={false}
          value={advisory}
        />
        <small className="field-hint">
          Only the ID. Do not paste report details here.
        </small>
      </label>
      {error ? (
        <p className="form-error" role="alert">
          <CircleAlert aria-hidden="true" /> {error}
        </p>
      ) : null}
      <button className="button primary-button" disabled={busy} type="submit">
        {busy ? "Linking…" : "Link my GitHub report"}
      </button>
    </form>
  );
}

function utcInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  return `${value}:00.000Z`;
}

/** A security maintainer records a report that arrived through GitHub. */
function RecordForm({
  programProjects,
  onCreated,
}: {
  programProjects: ProjectDefinition[];
  onCreated: (created: SecurityCase) => void;
}) {
  const [projectId, setProjectId] = useState(programProjects[0]?.id ?? "");
  const [advisory, setAdvisory] = useState("");
  const [reporterId, setReporterId] = useState("");
  const [reporterLogin, setReporterLogin] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [key, setKey] = useState(requestKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    projectApiRequest<{ case: SecurityCase }>("POST", "security-cases", {
      mode: "record",
      projectId,
      advisory: advisory.trim(),
      reporterGithubId: reporterId.trim(),
      reporterGithubLogin: reporterLogin.trim(),
      receivedAt: utcInput(receivedAt),
      confirmation: confirmed,
      idempotencyKey: key,
    }).then(
      (body) => {
        setBusy(false);
        setKey(requestKey());
        onCreated(body.case);
      },
      (caught: unknown) => {
        setBusy(false);
        setError(errorMessage(caught));
      },
    );
  };
  return (
    <form className="security-form" onSubmit={submit}>
      <ProjectSelect
        onChange={setProjectId}
        projects={programProjects}
        value={projectId}
      />
      <label>
        GitHub advisory ID
        <input
          autoComplete="off"
          onChange={(event) => setAdvisory(event.target.value)}
          required
          spellCheck={false}
          value={advisory}
        />
      </label>
      <label>
        Reporter GitHub account ID
        <input
          inputMode="numeric"
          onChange={(event) => setReporterId(event.target.value)}
          required
          value={reporterId}
        />
      </label>
      <label>
        Reporter GitHub login
        <input
          onChange={(event) => setReporterLogin(event.target.value)}
          required
          value={reporterLogin}
        />
      </label>
      <label>
        Time GitHub received the report (UTC)
        <input
          onChange={(event) => setReceivedAt(event.target.value)}
          required
          type="datetime-local"
          value={receivedAt}
        />
      </label>
      <label className="checkbox-label">
        <input
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          type="checkbox"
        />
        I checked on GitHub that this advisory exists and that this reporter
        submitted it.
      </label>
      {error ? (
        <p className="form-error" role="alert">
          <CircleAlert aria-hidden="true" /> {error}
        </p>
      ) : null}
      <button className="button primary-button" disabled={busy} type="submit">
        {busy ? "Recording…" : "Record verified report"}
      </button>
    </form>
  );
}

type FieldSpec =
  | {
      name: string;
      label: string;
      kind: "text" | "textarea";
      hint?: string;
      optional?: boolean;
    }
  | { name: string; label: string; kind: "select"; options: [string, string][] }
  | { name: string; label: string; kind: "checkbox" }
  | { name: string; label: string; kind: "utc" };

type ActionSpec = { title: string; submit: string; fields: FieldSpec[] };

const REASON: FieldSpec = {
  name: "reason",
  label: "Private reason",
  kind: "textarea",
  hint: "Do not name another reporter or quote another report.",
};

function actionSpec(action: string, record: SecurityCase): ActionSpec | null {
  switch (action) {
    case "verify-link":
      return {
        title: "Verify the GitHub report",
        submit: "Verify report",
        fields: [
          {
            name: "receivedAt",
            label: "Time GitHub received the report (UTC)",
            kind: "utc",
          },
          {
            name: "confirmation",
            label: `I checked on GitHub that ${record.advisory?.ghsa ?? "this advisory"} exists and that @${record.reporter?.githubLogin ?? "the reporter"} submitted it.`,
            kind: "checkbox",
          },
        ],
      };
    case "reject-link":
      return {
        title: "Reject this link",
        submit: "Reject link",
        fields: [REASON],
      };
    case "assign-triager":
      return {
        title: "Assign a triager",
        submit: "Assign triager",
        fields: [
          {
            name: "githubId",
            label: "Triager GitHub account ID",
            kind: "text",
          },
          { name: "githubLogin", label: "Triager GitHub login", kind: "text" },
        ],
      };
    case "revoke-triager": {
      const active = (record.triagers ?? []).filter(
        (entry) => entry.revokedAt === null,
      );
      if (active.length === 0) return null;
      return {
        title: "Remove a triager",
        submit: "Remove triager",
        fields: [
          {
            name: "githubId",
            label: "Triager",
            kind: "select",
            options: active.map((entry) => [
              entry.githubId,
              `@${entry.githubLogin}`,
            ]),
          },
        ],
      };
    }
    case "triage":
      return {
        title: "Triage",
        submit: "Save triage state",
        fields: [
          {
            name: "receiptState",
            label: "Receipt state",
            kind: "select",
            options: [
              ["triaging", "Triaging"],
              ["needs-information", "Needs information"],
            ],
          },
          { ...REASON, optional: true } as FieldSpec,
        ],
      };
    case "next-action":
      return {
        title: "Owner and next action",
        submit: "Save next action",
        fields: [
          { name: "nextAction", label: "Next action", kind: "text" },
          { name: "dueAt", label: "Due (UTC)", kind: "utc" },
        ],
      };
    case "decide":
      return {
        title: "Technical decision",
        submit: "Record decision",
        fields: [
          {
            name: "outcome",
            label: "Outcome",
            kind: "select",
            options: [
              ["confirmed", "Confirmed"],
              ["duplicate", "Duplicate"],
              ["out-of-scope", "Out of scope"],
              ["rejected", "Rejected"],
            ],
          },
          {
            name: "severity",
            label: "Severity",
            kind: "select",
            options: [
              ["critical", "Critical"],
              ["high", "High"],
              ["medium", "Medium"],
              ["low", "Low"],
              ["informational", "Informational"],
              ["unresolved", "Unresolved"],
            ],
          },
          {
            name: "loss",
            label: "Loss of funds",
            kind: "select",
            options: [
              ["verified-potential", "Verified potential loss"],
              ["verified-actual", "Verified actual loss"],
              ["not-verified", "Not verified"],
              ["unresolved", "Unresolved"],
            ],
          },
          {
            name: "inScope",
            label: "The affected asset is in scope",
            kind: "checkbox",
          },
          {
            name: "relatedParty",
            label:
              "The reporter is a related party (owner, employee, sponsor or approver). An independent reviewer must then approve the award.",
            kind: "checkbox",
          },
          {
            name: "rootCauseKey",
            label: "Root cause key",
            kind: "text",
            optional: true,
            hint: "Lowercase words and hyphens. One root cause reserves one award.",
          },
          {
            name: "duplicateOf",
            label: "Original case ID (duplicates only)",
            kind: "text",
            optional: true,
          },
          {
            name: "evidenceReference",
            label: "Private evidence reference",
            kind: "text",
            hint: "Where the reproduction, environment and tested revision are recorded.",
          },
          {
            name: "evidenceDigest",
            label: "Decision-evidence SHA-256",
            kind: "text",
            optional: true,
            hint: "Required to confirm. The digest of the frozen evidence snapshot.",
          },
          REASON,
        ],
      };
    case "remediation":
      return {
        title: "Remediation",
        submit: "Save remediation state",
        fields: [
          {
            name: "remediationState",
            label: "Remediation state",
            kind: "select",
            options: [
              ["investigating", "Investigating"],
              ["fixing", "Fixing in a private workspace"],
              ["retest", "Retest"],
              ["resolved", "Resolved (fix merged)"],
              ["mitigation-verified", "Deployed mitigation verified"],
              ["reopened", "Reopened"],
            ],
          },
          {
            name: "evidenceReference",
            label: "Private exact-head test or deployment evidence",
            kind: "text",
            optional: true,
            hint: "Required for resolved and for deployed mitigation.",
          },
          { ...REASON, optional: true } as FieldSpec,
        ],
      };
    case "disclosure":
      return {
        title: "Disclosure",
        submit: "Save disclosure decision",
        fields: [
          {
            name: "disclosureState",
            label: "Disclosure state",
            kind: "select",
            options: [
              ["embargoed", "Embargoed"],
              ["redaction-approved", "Redacted text approved"],
              ["disclosed", "Disclosed by the security maintainer"],
            ],
          },
          {
            name: "evidenceReference",
            label: "Private disclosure approval evidence",
            kind: "text",
            hint: "Reference the human approval and exact content version in the private advisory. Do not paste the content here.",
          },
          {
            name: "redactedContentDigest",
            label: "Approved redacted content SHA-256",
            kind: "text",
            optional: true,
            hint: "Required when approving redacted text or recording disclosure. Use the digest of the exact approved content.",
          },
          {
            name: "embargoChange",
            label: "Approved embargo change",
            kind: "textarea",
            optional: true,
            hint: "Record any approved deadline or terms change. Leave blank if unchanged. This does not publish content or schedule disclosure.",
          },
          REASON,
        ],
      };
    case "recognition":
      return {
        title: "Public recognition",
        submit: "Save my choice",
        fields: [
          {
            name: "recognition",
            label: "Show my name publicly",
            kind: "select",
            // The current choice is listed first, so the form shows it.
            options: (
              [
                ["private", "No, keep my identity private"],
                ["opt-in", "Yes, after authorized disclosure"],
              ] as [string, string][]
            ).sort(([value]) => (value === record.recognition ? -1 : 1)),
          },
        ],
      };
    case "appeal":
      return {
        title: "Appeal this decision",
        submit: "Send appeal",
        fields: [
          {
            name: "reason",
            label: "Why the decision is wrong",
            kind: "textarea",
            hint: "An independent reviewer reads this privately.",
          },
        ],
      };
    case "decide-appeal":
      return {
        title: "Decide the appeal",
        submit: "Record appeal decision",
        fields: [
          {
            name: "outcome",
            label: "Outcome",
            kind: "select",
            options: [
              ["uphold", "Uphold the original decision"],
              ["return", "Return the case for a new technical decision"],
            ],
          },
          REASON,
        ],
      };
    case "decide-related-party":
      return {
        title: "Related-party award review",
        submit: "Record review",
        fields: [
          {
            name: "outcome",
            label: "Outcome",
            kind: "select",
            options: [
              ["approve", "Approve: reserve the award if capacity remains"],
              ["refuse", "Refuse: the reporter is not eligible for this award"],
            ],
          },
          REASON,
        ],
      };
    case "reserve-award":
      return {
        title: "Reserve with raised capacity",
        submit: "Reserve award",
        fields: [
          {
            name: "reason",
            label: "Private reason",
            kind: "textarea",
            hint: "Name the project revision that raised capacity and the published exhaustion rule you apply. The earliest receipt is funded first.",
          },
        ],
      };
    case "approve-award":
      return {
        title: "Approve the award",
        submit: "Approve award",
        fields: [
          {
            name: "paymentDeadline",
            label: "Payment deadline (UTC)",
            kind: "utc",
          },
          {
            name: "confirmation",
            label: `I reviewed the preview: ${caseMoney(record.terms)}, payee @${record.payee?.githubLogin ?? record.reporter?.githubLogin ?? "reporter"}, reserved under policy revision ${record.policyRevision ?? "—"}.`,
            kind: "checkbox",
          },
        ],
      };
  }
  return null;
}

function initialValues(spec: ActionSpec): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const field of spec.fields)
    values[field.name] =
      field.kind === "checkbox"
        ? false
        : field.kind === "select"
          ? field.options[0][0]
          : "";
  return values;
}

function ActionForm({
  action,
  record,
  onDone,
}: {
  action: string;
  record: SecurityCase;
  onDone: (updated: SecurityCase | null, note: string) => void;
}) {
  const spec = actionSpec(action, record);
  const [values, setValues] = useState(() => (spec ? initialValues(spec) : {}));
  const [key] = useState(requestKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (spec === null) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body: Record<string, unknown> = {
      action,
      expectedRevision: record.revision,
      idempotencyKey: key,
    };
    for (const field of spec.fields) {
      const value = values[field.name];
      if (field.kind === "utc") body[field.name] = utcInput(String(value));
      else if (
        field.kind !== "checkbox" &&
        field.kind !== "select" &&
        field.optional &&
        String(value).trim() === ""
      )
        continue;
      else body[field.name] = value;
    }
    setBusy(true);
    setError(null);
    projectApiRequest<{ case: SecurityCase }>(
      "POST",
      `security-cases/${encodeURIComponent(record.id)}/actions`,
      body,
    ).then(
      (response) => {
        setBusy(false);
        onDone(
          "allowedActions" in response.case ? response.case : null,
          `${spec.title}: saved.`,
        );
      },
      (caught: unknown) => {
        setBusy(false);
        setError(errorMessage(caught));
      },
    );
  };
  const formId = `${record.id}-${action}`;
  return (
    <form
      aria-labelledby={`${formId}-title`}
      className="security-form security-action"
      onSubmit={submit}
    >
      <h4 id={`${formId}-title`}>{spec.title}</h4>
      {spec.fields.map((field) => {
        const set = (value: string | boolean) =>
          setValues((current) => ({ ...current, [field.name]: value }));
        if (field.kind === "checkbox")
          return (
            <label className="checkbox-label" key={field.name}>
              <input
                checked={values[field.name] === true}
                onChange={(event) => set(event.target.checked)}
                type="checkbox"
              />
              {field.label}
            </label>
          );
        if (field.kind === "select")
          return (
            <label key={field.name}>
              {field.label}
              <select
                onChange={(event) => set(event.target.value)}
                value={String(values[field.name])}
              >
                {field.options.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          );
        if (field.kind === "utc")
          return (
            <label key={field.name}>
              {field.label}
              <input
                onChange={(event) => set(event.target.value)}
                required
                type="datetime-local"
                value={String(values[field.name])}
              />
            </label>
          );
        const hint = field.hint ? (
          <small className="field-hint">{field.hint}</small>
        ) : null;
        if (field.kind === "textarea")
          return (
            <label key={field.name}>
              {field.label}
              <textarea
                onChange={(event) => set(event.target.value)}
                required={!field.optional}
                rows={3}
                value={String(values[field.name])}
              />
              {hint}
            </label>
          );
        return (
          <label key={field.name}>
            {field.label}
            <input
              autoComplete="off"
              onChange={(event) => set(event.target.value)}
              required={!field.optional}
              spellCheck={false}
              value={String(values[field.name])}
            />
            {hint}
          </label>
        );
      })}
      {error ? (
        <p className="form-error" role="alert">
          <CircleAlert aria-hidden="true" /> {error}
        </p>
      ) : null}
      <button className="button secondary-button" disabled={busy} type="submit">
        {busy ? "Saving…" : spec.submit}
      </button>
    </form>
  );
}

const EVENT_LABELS: Record<string, string> = {
  claim: "Reporter linked the GitHub report",
  record: "Maintainer recorded the GitHub report",
  "verify-link": "Maintainer verified the GitHub report",
  "reject-link": "Maintainer rejected the link",
  "assign-triager": "Triager assigned",
  "revoke-triager": "Triager removed",
  triage: "Triage state changed",
  "next-action": "Next action set",
  decide: "Technical decision recorded",
  remediation: "Remediation state changed",
  disclosure: "Disclosure decision recorded",
  recognition: "Recognition choice changed",
  appeal: "Appeal sent",
  "decide-appeal": "Appeal decided",
  "approve-award": "Award approved",
  "decide-related-party": "Related-party award reviewed",
  "reserve-award": "Award reserved with raised capacity",
};

const RELATED_PARTY_LABELS: Record<SecurityCase["relatedPartyReview"], string> =
  {
    "not-applicable": "No related-party review",
    pending: "Waiting for an independent reviewer",
    approved: "Approved by an independent reviewer",
    refused: "Refused by an independent reviewer",
  };

function CaseDetail({
  caseId,
  onChanged,
}: {
  caseId: string;
  onChanged: () => void;
}) {
  const [state, reload, replace] = useSecurityData<{ case: SecurityCase }>(
    `security-cases/${encodeURIComponent(caseId)}`,
  );
  const [note, setNote] = useState<string | null>(null);
  if (state.status === "loading")
    return (
      <p aria-live="polite" className="admin-status">
        Loading case…
      </p>
    );
  if (state.status === "signed-out")
    return (
      <p className="form-error" role="alert">
        <CircleAlert aria-hidden="true" /> Your session ended. Sign in again.
      </p>
    );
  if (state.status === "error")
    return (
      <div className="form-error" role="alert">
        <CircleAlert aria-hidden="true" /> {state.message}
        <button className="text-button" onClick={reload} type="button">
          <RotateCcw aria-hidden="true" /> Retry
        </button>
      </div>
    );
  const record = state.value.case;
  return (
    <article
      aria-labelledby={`case-${record.id}`}
      className="admin-card security-case"
    >
      <header>
        <h3 id={`case-${record.id}`}>
          Case {record.id} · {record.projectId}
        </h3>
        <span className="admin-badge">{record.view} view</span>
      </header>
      {note ? (
        <p className="admin-status" role="status">
          {note}
        </p>
      ) : null}
      <dl className="admin-facts">
        <Fact term="Your role">{record.viewerRoles.join(", ")}</Fact>
        <Fact term="Submission">
          {SUBMISSION_LABELS[record.submissionState]}
        </Fact>
        <Fact term="Received by GitHub">
          {formatUtc(record.receivedAt)}
          {record.receivedAtSource === "maintainer-attested"
            ? " — entered by a security maintainer from GitHub, not read from GitHub by Slop"
            : ""}
        </Fact>
        <Fact term="Policy revision">{record.policyRevision ?? "—"}</Fact>
        <Fact term="Award terms">{caseMoney(record.terms)}</Fact>
        <Fact term="Award">{record.awardState}</Fact>
        {record.relatedParty === "related" ? (
          <Fact term="Related party">
            {RELATED_PARTY_LABELS[record.relatedPartyReview]}
          </Fact>
        ) : null}
        <Fact term="Payment">
          {record.paymentState === "rail-unavailable"
            ? "Approved, not paid. No private payment rail is approved yet, so Slop cannot pay or mark this paid."
            : "Not applicable"}
          {record.paymentDeadline
            ? ` Deadline ${formatUtc(record.paymentDeadline)}.`
            : ""}
        </Fact>
        {record.advisory ? (
          <Fact term="GitHub advisory">
            <ExternalLinkAnchor href={record.advisory.url}>
              {record.advisory.ghsa}
            </ExternalLinkAnchor>{" "}
            (opens only for people GitHub allows)
          </Fact>
        ) : null}
        {record.receiptState ? (
          <>
            <Fact term="Receipt">{record.receiptState}</Fact>
            <Fact term="Remediation">{record.remediationState}</Fact>
            <Fact term="Disclosure">{record.disclosureState}</Fact>
            <Fact term="Recognition">{record.recognition}</Fact>
            <Fact term="Severity">{record.severity ?? "—"}</Fact>
            <Fact term="Loss of funds">{record.lossFinding ?? "—"}</Fact>
            <Fact term="Appeal">{record.appealState}</Fact>
            <Fact term="Next action">
              {record.nextAction ?? "—"}
              {record.nextActionDueAt
                ? ` · due ${formatUtc(record.nextActionDueAt)}`
                : ""}
              {record.overdue ? " · overdue" : ""}
            </Fact>
          </>
        ) : null}
        {record.reporter ? (
          <Fact term="Reporter">@{record.reporter.githubLogin}</Fact>
        ) : null}
        {record.payee ? (
          <Fact term="Payee">@{record.payee.githubLogin}</Fact>
        ) : null}
        {record.view === "restricted" ? (
          <>
            <Fact term="Root cause">{record.rootCauseKey ?? "—"}</Fact>
            <Fact term="Duplicate of">{record.duplicateOf ?? "—"}</Fact>
            <Fact term="Evidence digest">
              {record.evidenceDigest ? (
                <code>{record.evidenceDigest}</code>
              ) : (
                "—"
              )}
            </Fact>
            <Fact term="Triagers">
              {(record.triagers ?? [])
                .filter((entry) => entry.revokedAt === null)
                .map((entry) => `@${entry.githubLogin}`)
                .join(", ") || "None"}
            </Fact>
          </>
        ) : null}
      </dl>
      {record.events && record.events.length > 0 ? (
        <details>
          <summary>History ({record.events.length})</summary>
          <ol className="security-history">
            {record.events.map((event) => (
              <li key={event.revision}>
                {formatUtc(event.at)} · {EVENT_LABELS[event.kind] ?? event.kind}
                {event.reason ? ` — ${event.reason}` : ""}
                {event.evidenceReference
                  ? ` (evidence: ${event.evidenceReference})`
                  : ""}
                {event.kind === "disclosure" &&
                event.detail?.redactedContentDigest
                  ? ` (approved content SHA-256: ${event.detail.redactedContentDigest})`
                  : ""}
                {event.kind === "disclosure" && event.detail?.embargoChange
                  ? ` (embargo change: ${event.detail.embargoChange})`
                  : ""}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {record.allowedActions.length === 0 ? (
        <p className="admin-status">Nothing waits for you on this case.</p>
      ) : (
        record.allowedActions.map((action) => (
          <ActionForm
            action={action}
            key={`${action}-${record.revision}`}
            onDone={(updated, saved) => {
              setNote(saved);
              if (updated) replace({ case: updated });
              else reload();
              onChanged();
            }}
            record={record}
          />
        ))
      )}
    </article>
  );
}

/** The signed-in private case inbox. */
export function SecurityCasesPage() {
  const session = useProjectSession();
  const [list, reload] = useSecurityData<CaseList>(
    session.status === "signed-in" ? "security-cases" : null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const programProjects = useMemo(
    () => PROJECTS.filter((project) => project.securityBounty !== undefined),
    [],
  );
  let body: ReactNode;
  if (session.status !== "signed-in") {
    body = (
      <SignInPanel
        next="/security"
        purpose="Sign in with GitHub to see your private security cases. Reporting on GitHub does not need a Slop account."
        state={session}
      />
    );
  } else if (list.status === "signed-out") {
    body = (
      <SignInPanel
        next="/security"
        purpose="Your session ended. Sign in again to continue."
        state={{ status: "signed-out" }}
      />
    );
  } else if (list.status === "loading") {
    body = (
      <p aria-live="polite" className="admin-status">
        Loading your cases…
      </p>
    );
  } else if (list.status === "error") {
    body = (
      <div className="form-error" role="alert">
        <CircleAlert aria-hidden="true" /> {list.message}
        <button className="text-button" onClick={reload} type="button">
          <RotateCcw aria-hidden="true" /> Retry
        </button>
      </div>
    );
  } else {
    const maintained = new Set(
      list.value.programs
        .filter((entry) => entry.roles.includes("security-maintainer"))
        .map((entry) => entry.projectId),
    );
    const created = (record: SecurityCase) => {
      setNote(`Case ${record.id} saved.`);
      setSelected(record.id);
      reload();
    };
    body = (
      <>
        {note ? (
          <p className="admin-status" role="status">
            {note}
          </p>
        ) : null}
        <section aria-labelledby="security-cases" className="admin-section">
          <h2 id="security-cases">Your cases</h2>
          {list.value.cases.length === 0 ? (
            <p className="admin-status">You have no private security cases.</p>
          ) : (
            <ul className="security-case-list">
              {list.value.cases.map((record) => (
                <li key={record.id}>
                  <button
                    aria-pressed={selected === record.id}
                    className="text-button"
                    onClick={() => setSelected(record.id)}
                    type="button"
                  >
                    {record.projectId} · {record.advisory?.ghsa ?? record.id}
                  </button>{" "}
                  · {SUBMISSION_LABELS[record.submissionState]}
                  {record.receiptState ? ` · ${record.receiptState}` : ""} ·
                  award {record.awardState}
                  {record.overdue ? " · overdue" : ""}
                </li>
              ))}
            </ul>
          )}
          {selected ? (
            <CaseDetail caseId={selected} key={selected} onChanged={reload} />
          ) : null}
        </section>
        <section aria-labelledby="security-link" className="admin-section">
          <h2 id="security-link">Link a report you submitted on GitHub</h2>
          <p className="admin-status">
            A link is a claim. It counts as submitted only after a security
            maintainer confirms on GitHub that you sent the advisory. Your
            original GitHub receipt time is kept.
          </p>
          <ClaimForm onCreated={created} programProjects={programProjects} />
        </section>
        {maintained.size > 0 ? (
          <section aria-labelledby="security-record" className="admin-section">
            <h2 id="security-record">
              Record a report that came through GitHub
            </h2>
            <RecordForm
              onCreated={created}
              programProjects={programProjects.filter((project) =>
                maintained.has(project.id),
              )}
            />
          </section>
        ) : null}
      </>
    );
  }
  return (
    <main className="shell route-main admin-page security-page">
      <div className="admin-intro">
        <h1>Security cases</h1>
        <details>
          <summary>Who can access a case?</summary>
          <p>
            Private. Only the reporter, the program's security maintainers,
            assigned triagers, its finance approvers (award fields only) and its
            independent dispute reviewers (appealed cases only) can see a case.
            Slop admins have no automatic access. Slop never publishes cases or
            counts them.
          </p>
        </details>
        {session.status === "signed-in" ? (
          <p>Signed in as @{session.session.githubLogin}.</p>
        ) : null}
      </div>
      {body}
    </main>
  );
}

export default SecurityCasesPage;
