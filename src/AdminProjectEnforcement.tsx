/**
 * Quarantine, Ban project and Request reinstatement for one project (PRD
 * ADM-06). Every action needs a reason and an evidence reference, shows the
 * server's exact project and revision preview, and asks for confirmation.
 * The API decides the moderator role and independent review on every call.
 */

import { CircleAlert } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { errorMessage, formatTime } from "./Admin";
import {
  type AdminProject,
  type EnforcementAction,
  type EnforcementPreview,
  projectApiRequest,
} from "./lib/project-api";

const ACTION_LABELS: Record<EnforcementAction, string> = {
  quarantine: "Quarantine",
  ban: "Ban project",
  request_reinstatement: "Request reinstatement",
  reinstate: "Reinstate after review",
  deny_reinstatement: "Deny reinstatement",
};

const RESULT_LABELS: Record<EnforcementPreview["result"], string> = {
  revision_appended: "Appends the matching revision",
  revision_pending: "Revision pending",
  no_revision_needed: "No revision needed",
};

function availableActions(
  enforcement: AdminProject["enforcement"],
): EnforcementAction[] {
  if (enforcement.state === "clear") return ["quarantine", "ban"];
  const escalate: EnforcementAction[] =
    enforcement.state === "quarantined" ? ["ban"] : [];
  return enforcement.appeal === "requested"
    ? [...escalate, "reinstate", "deny_reinstatement"]
    : [...escalate, "request_reinstatement"];
}

function stateLabel(state: AdminProject["enforcement"]["state"]): string {
  return state === "clear"
    ? "No restriction"
    : state === "quarantined"
      ? "Quarantined"
      : "Banned";
}

export function ProjectEnforcementPanel({
  project,
  onDone,
}: {
  project: AdminProject;
  onDone: (note: string) => void;
}) {
  const enforcement = project.enforcement;
  const actions = availableActions(enforcement);
  const [action, setAction] = useState<EnforcementAction>(actions[0]);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [preview, setPreview] = useState<EnforcementPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const request = () => ({
    action,
    reason: reason.trim(),
    evidenceReference: evidence.trim(),
    expectedRevision: project.revision,
    expectedSequence: enforcement.nextSequence,
  });
  const path = (mode: "enforcement" | "enforcement-preview") =>
    `admin/projects/${encodeURIComponent(project.id)}/${mode}`;
  const showPreview = (event: FormEvent) => {
    event.preventDefault();
    setBusy("preview");
    setError(null);
    projectApiRequest<{ preview: EnforcementPreview }>(
      "POST",
      path("enforcement-preview"),
      request(),
    ).then(
      (body) => {
        setBusy(null);
        setPreview(body.preview);
      },
      (caught: unknown) => {
        setBusy(null);
        setError(errorMessage(caught));
      },
    );
  };
  const confirm = () => {
    setBusy("apply");
    setError(null);
    projectApiRequest("POST", path("enforcement"), request()).then(
      () =>
        onDone(
          `${ACTION_LABELS[action]} recorded for ${project.manifest.name}. Public lists and skill routes changed at once.`,
        ),
      (caught: unknown) => {
        setBusy(null);
        setPreview(null);
        setError(errorMessage(caught));
      },
    );
  };
  return (
    <section aria-labelledby={headingId} className="admin-enforcement">
      <header>
        <h4 id={headingId}>Enforcement</h4>
        <span className={`admin-badge admin-badge-${enforcement.state}`}>
          {stateLabel(enforcement.state)}
        </span>
      </header>
      <dl className="admin-facts">
        <div>
          <dt>Appeal</dt>
          <dd>
            {enforcement.appeal === "none"
              ? "None"
              : enforcement.appeal === "requested"
                ? "Reinstatement requested"
                : enforcement.appeal === "granted"
                  ? "Last appeal granted"
                  : "Last appeal denied"}
          </dd>
        </div>
        {enforcement.since ? (
          <div>
            <dt>Restricted since</dt>
            <dd>{formatTime(enforcement.since)} UTC</dd>
          </div>
        ) : null}
        {enforcement.restrictedBy.length > 0 ? (
          <div>
            <dt>Restricted by</dt>
            <dd>
              {enforcement.restrictedBy
                .map((actor) => `@${actor.githubLogin}`)
                .join(", ")}{" "}
              (cannot decide the appeal)
            </dd>
          </div>
        ) : null}
      </dl>
      {enforcement.revisionPending ? (
        <p className="form-error" role="status">
          <CircleAlert aria-hidden="true" /> Revision pending: the restriction
          is in force on every public route, but revision {project.revision} is
          still {project.status} and {project.manifest.listingTier}. Delist the
          project to append the paused, retired revision.
        </p>
      ) : null}
      {enforcement.records.length > 0 ? (
        <details>
          <summary>
            Enforcement history ({enforcement.records.length} records)
          </summary>
          <ol className="admin-enforcement-history">
            {enforcement.records.map((record) => (
              <li key={record.id}>
                <strong>{ACTION_LABELS[record.action]}</strong> by @
                {record.actor.githubLogin} ({record.actorRole},{" "}
                {record.decisionSource}) on {formatTime(record.createdAt)} UTC.
                Revision {record.beforeRevision}
                {record.afterRevision === null
                  ? ""
                  : ` → ${record.afterRevision}`}
                : {RESULT_LABELS[record.result]}.
                <br />
                Reason: {record.reason}
                <br />
                Evidence: {record.evidenceReference}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {enforcement.moderation === "unconfigured" ? (
        <p className="admin-status">
          Enforcement actions are unavailable: no project moderator is
          configured. A maintainer must set PROJECT_MODERATOR_GITHUB_IDS.
        </p>
      ) : enforcement.moderation === "not-moderator" ? (
        <p className="admin-status">
          Only a project moderator can quarantine, ban or reinstate a project.
        </p>
      ) : (
        <form className="admin-actions" onSubmit={showPreview}>
          <label>
            Action
            <select
              disabled={preview !== null}
              onChange={(event) =>
                setAction(event.target.value as EnforcementAction)
              }
              value={action}
            >
              {actions.map((value) => (
                <option key={value} value={value}>
                  {ACTION_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reason (private audit record)
            <textarea
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
              readOnly={preview !== null}
              required
              value={reason}
            />
          </label>
          <label>
            Evidence reference (link or case id)
            <input
              maxLength={500}
              onChange={(event) => setEvidence(event.target.value)}
              readOnly={preview !== null}
              required
              spellCheck={false}
              value={evidence}
            />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              <CircleAlert aria-hidden="true" /> {error}
            </p>
          ) : null}
          {preview === null ? (
            <div>
              <button
                className="button secondary-button"
                disabled={
                  busy !== null ||
                  reason.trim() === "" ||
                  evidence.trim() === ""
                }
                type="submit"
              >
                {busy === "preview" ? "Preparing preview…" : "Preview action"}
              </button>
            </div>
          ) : (
            <fieldset className="admin-enforcement-preview">
              <legend>Preview: check it, then confirm</legend>
              <dl className="admin-facts">
                <div>
                  <dt>Project</dt>
                  <dd>
                    {preview.projectName} ({preview.projectId})
                  </dd>
                </div>
                <div>
                  <dt>Action</dt>
                  <dd>
                    {ACTION_LABELS[preview.action]} · record {preview.sequence}
                  </dd>
                </div>
                <div>
                  <dt>Restriction</dt>
                  <dd>
                    {stateLabel(preview.stateBefore)} →{" "}
                    {stateLabel(preview.stateAfter)}
                  </dd>
                </div>
                <div>
                  <dt>Revision</dt>
                  <dd>
                    {preview.revision.after === null
                      ? `Stays at ${preview.revision.before}`
                      : `${preview.revision.before} → ${preview.revision.after}`}
                  </dd>
                </div>
                <div>
                  <dt>Status and listing</dt>
                  <dd>
                    {preview.revision.statusBefore},{" "}
                    {preview.revision.listingTierBefore} →{" "}
                    {preview.revision.statusAfter},{" "}
                    {preview.revision.listingTierAfter}
                  </dd>
                </div>
                <div>
                  <dt>Result</dt>
                  <dd>{RESULT_LABELS[preview.result]}</dd>
                </div>
              </dl>
              {preview.pendingReason ? (
                <p className="form-error" role="status">
                  <CircleAlert aria-hidden="true" /> The restriction applies at
                  once, but the matching revision cannot be appended yet:{" "}
                  {preview.pendingReason}
                </p>
              ) : null}
              <div>
                <button
                  className={`button ${
                    preview.action === "quarantine" || preview.action === "ban"
                      ? "danger-button"
                      : "primary-button"
                  }`}
                  disabled={busy !== null}
                  onClick={confirm}
                  type="button"
                >
                  {busy === "apply"
                    ? "Recording…"
                    : `Confirm: ${ACTION_LABELS[preview.action]}`}
                </button>
                <button
                  className="button ghost-button"
                  disabled={busy !== null}
                  onClick={() => setPreview(null)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </fieldset>
          )}
        </form>
      )}
    </section>
  );
}
