/**
 * The admin view of community project security vetting (PRD VET-01 to
 * VET-08). It shows each project's revision-bound clearance, the restricted
 * scan results and quarantine records, and queues a scan of the current
 * revision. The secure-VM service is external; when it is not configured the
 * view says so and offers no scan control.
 */

import { CircleAlert, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { projectApiRequest } from "./lib/project-api";
import type {
  AssessmentState,
  AssessmentSummary,
  VettingClearance as Clearance,
} from "./lib/vetting-contracts";

type AdminAssessment = AssessmentSummary & {
  projectId: string;
  requestedBy: { githubLogin: string };
  requestReason: string;
  result: {
    environment: { runId: string };
    telemetry: { visibilityGaps: string[]; tamperDetected: boolean };
    artifacts: {
      sha256: string;
      path: string;
      type: string;
      state: string;
      analysis: string;
    }[];
    findings: { severity: string; category: string; summary: string }[];
    confirmation: { basis: string; rule: string } | null;
  } | null;
};

type Overview = {
  service: { queueRegistrationAvailable: boolean } & (
    | { state: "available" }
    | { state: "unavailable"; reason: string }
  );
  projects: {
    id: string;
    name: string;
    status: string;
    revision: number;
    clearance: Clearance;
  }[];
  assessments: AdminAssessment[];
};

const LABELS: Record<Clearance["state"], string> = {
  unscanned: "Unscanned",
  unverified: "Unverified",
  stale: "Stale",
  queued: "Queued",
  quarantined: "Quarantined",
  cleared: "Cleared",
  banned: "Banned",
};

const STATE_TEXT: Record<AssessmentState, string> = {
  pending: "Queued",
  incomplete: "Incomplete",
  clean: "Clean",
  malicious: "Confirmed malicious",
};

function time(value: string | null): string {
  if (value === null) return "—";
  return `${new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  })} UTC`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function QueueScan({
  project,
  onQueued,
}: {
  project: Overview["projects"][number];
  onQueued: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queue = () => {
    if (reason.trim() === "") {
      setError("Write a reason for the scan.");
      return;
    }
    setBusy(true);
    setError(null);
    projectApiRequest("POST", "admin/vetting/assessments", {
      projectId: project.id,
      revision: project.revision,
      reason: reason.trim(),
    }).then(onQueued, (caught: unknown) => {
      setBusy(false);
      setError(message(caught));
    });
  };
  return (
    <div className="admin-actions">
      <label>
        Reason for the scan
        <textarea
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
          value={reason}
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          <CircleAlert aria-hidden="true" /> {error}
        </p>
      ) : null}
      <div>
        <button
          className="button secondary-button"
          disabled={busy}
          onClick={queue}
          type="button"
        >
          {busy ? "Queuing…" : `Queue scan of revision ${project.revision}`}
        </button>
      </div>
    </div>
  );
}

function AssessmentDetails({ assessment }: { assessment: AdminAssessment }) {
  const result = assessment.result;
  return (
    <details>
      <summary>
        Revision {assessment.revision} · {STATE_TEXT[assessment.state]} ·{" "}
        {time(assessment.completedAt ?? assessment.requestedAt)}
      </summary>
      <dl className="admin-facts">
        <div>
          <dt>Queued by</dt>
          <dd>
            @{assessment.requestedBy.githubLogin} — {assessment.requestReason}
          </dd>
        </div>
        <div>
          <dt>Assigned commit</dt>
          <dd>{assessment.commitSha}</dd>
        </div>
        <div>
          <dt>Skill template digest</dt>
          <dd>{assessment.templateSha256}</dd>
        </div>
        <div>
          <dt>Policy version</dt>
          <dd>{assessment.policyVersion ?? "—"}</dd>
        </div>
        <div>
          <dt>Model reviews</dt>
          <dd>
            {assessment.modelRuns.length === 0
              ? "—"
              : assessment.modelRuns
                  .map((run) => `${run.reviewer}: ${run.provider}/${run.model}`)
                  .join(", ")}
          </dd>
        </div>
        {result ? (
          <div>
            <dt>Retained evidence</dt>
            <dd>
              <a
                href={`/vetting-evidence?assessmentId=${encodeURIComponent(assessment.id)}&runId=${encodeURIComponent(result.environment.runId)}`}
              >
                Open restricted evidence console
              </a>
              <p>Separate designated-operator access is required.</p>
            </dd>
          </div>
        ) : null}
        {result ? (
          <div>
            <dt>Telemetry</dt>
            <dd>
              {result.telemetry.tamperDetected ? "Tampering detected. " : ""}
              {result.telemetry.visibilityGaps.length === 0
                ? "No visibility gaps"
                : result.telemetry.visibilityGaps.join("; ")}
            </dd>
          </div>
        ) : null}
        {result?.confirmation ? (
          <div>
            <dt>Confirmation</dt>
            <dd>
              {result.confirmation.basis} under {result.confirmation.rule}
            </dd>
          </div>
        ) : null}
      </dl>
      {result && result.findings.length > 0 ? (
        <>
          <h4>Findings</h4>
          <ul>
            {result.findings.map((finding) => (
              <li key={`${finding.category}-${finding.summary}`}>
                {finding.severity} · {finding.category}: {finding.summary}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {result && result.artifacts.length > 0 ? (
        <>
          <h4>Artifact quarantine</h4>
          <ul>
            {result.artifacts.map((artifact) => (
              <li key={`${artifact.sha256}-${artifact.path}`}>
                {artifact.path} ({artifact.type}) · {artifact.state} ·{" "}
                {artifact.analysis} · {artifact.sha256.slice(0, 12)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  );
}

export function VettingSection() {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; value: Overview }
  >({ status: "loading" });
  const [note, setNote] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    setState({ status: "loading" });
    projectApiRequest<Overview>("GET", "admin/vetting").then(
      (value) => {
        if (generation.current === current)
          setState({ status: "ready", value });
      },
      (error: unknown) => {
        if (generation.current === current)
          setState({ status: "error", message: message(error) });
      },
    );
  }, []);
  useEffect(() => {
    load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  return (
    <section aria-labelledby="admin-vetting" className="admin-section">
      <div className="admin-section-heading">
        <h2 id="admin-vetting">Security vetting</h2>
      </div>
      <p className="admin-status">
        A secure virtual machine scans each exact project revision before Slop
        serves its skills or lets it become active. Only a clean result clears a
        revision. An incomplete result quarantines it, and a confirmed malicious
        result bans the project. A changed revision needs a new scan; a revision
        that only changes the status of a cleared one keeps its clearance.
      </p>
      {note ? (
        <p className="admin-status" role="status">
          {note}
        </p>
      ) : null}
      {state.status === "loading" ? (
        <p aria-live="polite" className="admin-status">
          Loading security vetting…
        </p>
      ) : state.status === "error" ? (
        <div className="form-error" role="alert">
          <CircleAlert aria-hidden="true" /> {state.message}
          <button className="text-button" onClick={load} type="button">
            <RotateCcw aria-hidden="true" /> Retry
          </button>
        </div>
      ) : (
        <>
          {state.value.service.state === "unavailable" ? (
            <p className="form-error" role="alert">
              <CircleAlert aria-hidden="true" /> Vetting service unavailable.{" "}
              {state.value.service.reason}
            </p>
          ) : null}
          {state.value.projects.length === 0 ? (
            <p className="admin-status">No projects are listed yet.</p>
          ) : (
            state.value.projects.map((project) => {
              const clearance = project.clearance;
              const history = state.value.assessments.filter(
                (assessment) => assessment.projectId === project.id,
              );
              const queued = history.some(
                (assessment) =>
                  assessment.state === "pending" &&
                  assessment.revision === project.revision,
              );
              return (
                <article
                  aria-label={`Security vetting for ${project.id}`}
                  className="admin-card"
                  key={project.id}
                >
                  <header>
                    <h3>{project.name}</h3>
                    <span
                      className={`admin-badge admin-badge-vetting-${clearance.state}`}
                    >
                      {LABELS[clearance.state]}
                    </span>
                  </header>
                  <dl className="admin-facts">
                    <div>
                      <dt>Current revision</dt>
                      <dd>
                        {project.id} · revision {project.revision} ·{" "}
                        {project.status}
                      </dd>
                    </div>
                    <div>
                      <dt>Decided by</dt>
                      <dd>
                        {clearance.state === "unscanned"
                          ? "No scan of this content yet"
                          : clearance.state === "unverified"
                            ? clearance.reason
                            : clearance.state === "stale"
                              ? `No scan of the live branch head ${clearance.live.commitSha} with skill template ${clearance.live.templateSha256}. The last scan covered ${clearance.assessment.commitSha}.`
                              : `Scan of revision ${clearance.assessment.revision} · ${STATE_TEXT[clearance.assessment.state]}`}
                      </dd>
                    </div>
                    {"assessment" in clearance ? (
                      <div>
                        <dt>Held artifacts</dt>
                        <dd>
                          {clearance.assessment.heldArtifacts} of{" "}
                          {clearance.assessment.artifacts}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  {clearance.state === "banned" ? (
                    <p className="form-error">
                      <CircleAlert aria-hidden="true" /> Confirmed malicious.
                      Skills, discovery and activation are blocked. A new scan
                      cannot lift a ban.
                    </p>
                  ) : null}
                  {state.value.service.queueRegistrationAvailable && !queued ? (
                    <QueueScan
                      onQueued={() => {
                        setNote(
                          `Queued a scan of ${project.id} revision ${project.revision}.`,
                        );
                        load();
                      }}
                      project={project}
                    />
                  ) : null}
                  {history.length > 0 ? (
                    <>
                      <h4>Scan history</h4>
                      {history.map((assessment) => (
                        <AssessmentDetails
                          assessment={assessment}
                          key={assessment.id}
                        />
                      ))}
                    </>
                  ) : null}
                </article>
              );
            })
          )}
        </>
      )}
    </section>
  );
}

/** The same revision-bound clearance used by the full security review panel. */
export function ActivationClearance({
  projectId,
  revision,
}: {
  projectId: string;
  revision: number;
}) {
  const [clearance, setClearance] = useState<string>(
    "Checking security clearance…",
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    projectApiRequest<Overview>("GET", `admin/vetting?refresh=${attempt}`).then(
      (body) => {
        if (!active) return;
        const project = body.projects.find((entry) => entry.id === projectId);
        setClearance(
          !project || project.revision !== revision
            ? "Project revision changed. Reload before activation."
            : `Revision ${revision}: ${LABELS[project.clearance.state]}.`,
        );
      },
      (error) => {
        if (active) setClearance(message(error));
      },
    );
    return () => {
      active = false;
    };
  }, [projectId, revision, attempt]);
  return (
    <div>
      <p role="status">{clearance}</p>
      <button
        type="button"
        className="text-button"
        onClick={() => setAttempt((value) => value + 1)}
      >
        Refresh clearance
      </button>
    </div>
  );
}
