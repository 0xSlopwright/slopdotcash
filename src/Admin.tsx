/**
 * The admin review surface for project applications and registry revisions.
 * Authority is decided by the API on every request; this view only hides
 * controls a session cannot use.
 */

import { CircleAlert, ExternalLink, RotateCcw } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type AdminProject,
  type ProjectApplication,
  type ProjectSessionState,
  projectApiRequest,
  useProjectSession,
} from "./lib/project-api";
import { loginHref } from "./Points";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function SignInPanel({
  state,
  next,
  purpose,
}: {
  state: Exclude<ProjectSessionState, { status: "signed-in" }>;
  next: string;
  purpose: string;
}) {
  if (state.status === "checking") {
    return (
      <p aria-live="polite" className="admin-status">
        Checking your GitHub session…
      </p>
    );
  }
  return (
    <div className="sign-in-panel">
      <p>{purpose}</p>
      {state.status === "error" ? (
        <p className="form-error" role="alert">
          <CircleAlert aria-hidden="true" /> {state.message}
        </p>
      ) : null}
      <a className="button primary-button" href={loginHref(next)}>
        Sign in with GitHub
      </a>
    </div>
  );
}

function formatTime(value: string | null): string {
  if (value === null) return "—";
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T };

function useAdminData<T>(
  path: string,
  select: (body: never) => T,
): [LoadState<T>, () => void] {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  // Only the newest request may settle, so a slow reply cannot overwrite a
  // retry or a newer tab selection.
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    setState({ status: "loading" });
    projectApiRequest<never>("GET", path).then(
      (body) => {
        if (generation.current === current) {
          setState({ status: "ready", value: select(body) });
        }
      },
      (error: unknown) => {
        if (generation.current === current) {
          setState({ status: "error", message: errorMessage(error) });
        }
      },
    );
  }, [path, select]);
  useEffect(() => {
    load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  return [state, load];
}

function LoadNotice({
  state,
  retry,
  label,
}: {
  state: { status: "loading" } | { status: "error"; message: string };
  retry: () => void;
  label: string;
}) {
  if (state.status === "loading") {
    return (
      <p aria-live="polite" className="admin-status">
        Loading {label}…
      </p>
    );
  }
  return (
    <div className="form-error" role="alert">
      <CircleAlert aria-hidden="true" /> {state.message}
      <button className="text-button" onClick={retry} type="button">
        <RotateCcw aria-hidden="true" /> Retry
      </button>
    </div>
  );
}

const selectApplications = (body: { applications: ProjectApplication[] }) =>
  body.applications;
const selectProjects = (body: { projects: AdminProject[] }) => body.projects;

function ApplicationCard({
  application,
  onDecided,
}: {
  application: ProjectApplication;
  onDecided: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manifest = application.manifest;
  const repository = application.repository ?? manifest.repositories[0]?.id;
  const decide = (decision: "approve" | "reject") => {
    if (decision === "reject" && reason.trim() === "") {
      setError("Write a reason before you reject. The applicant sees it.");
      return;
    }
    setBusy(decision);
    setError(null);
    projectApiRequest(
      "POST",
      `admin/project-applications/${encodeURIComponent(application.id)}/${decision}`,
      reason.trim() === "" ? {} : { reason: reason.trim() },
    ).then(onDecided, (caught: unknown) => {
      setBusy(null);
      setError(errorMessage(caught));
    });
  };
  return (
    <article className="admin-card" id={`application-${application.id}`}>
      <header>
        <h3>{manifest.name}</h3>
        <span className={`admin-badge admin-badge-${application.status}`}>
          {application.status}
        </span>
      </header>
      <p>{manifest.description}</p>
      <dl className="admin-facts">
        <div>
          <dt>Repository</dt>
          <dd>
            <a
              href={`https://github.com/${repository}`}
              rel="noreferrer"
              target="_blank"
            >
              {repository} <ExternalLink aria-hidden="true" />
            </a>
          </dd>
        </div>
        <div>
          <dt>Applicant</dt>
          <dd>
            <a
              href={`https://github.com/${application.applicant.githubLogin}`}
              rel="noreferrer"
              target="_blank"
            >
              @{application.applicant.githubLogin}
            </a>
          </dd>
        </div>
        <div>
          <dt>Steward</dt>
          <dd>
            {manifest.steward.displayName} (@{manifest.steward.github.login})
          </dd>
        </div>
        <div>
          <dt>Monthly pool</dt>
          <dd>{manifest.reward.monthlyCapDisplay} pledged</dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd>{formatTime(application.submittedAt)} UTC</dd>
        </div>
        <div>
          <dt>Admin email</dt>
          <dd>
            {application.adminNotification === "sent"
              ? "Sent"
              : application.adminNotification === "failed"
                ? "Failed to send"
                : "Not sent"}
          </dd>
        </div>
        {application.decidedBy ? (
          <div>
            <dt>Decision</dt>
            <dd>
              {application.status} by @{application.decidedBy.githubLogin} on{" "}
              {formatTime(application.decidedAt)} UTC
              {application.decisionReason
                ? ` — ${application.decisionReason}`
                : ""}
            </dd>
          </div>
        ) : null}
      </dl>
      <h4>Acceptance criteria</h4>
      <p className="admin-criteria">{application.acceptanceCriteria}</p>
      <details>
        <summary>Submitted manifest</summary>
        <pre>{JSON.stringify(manifest, null, 2)}</pre>
      </details>
      {application.status === "pending" ? (
        <div className="admin-actions">
          <label>
            Note to the applicant (required to reject)
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
              className="button primary-button"
              disabled={busy !== null}
              onClick={() => decide("approve")}
              type="button"
            >
              {busy === "approve" ? "Approving…" : "Approve as paused project"}
            </button>
            <button
              className="button secondary-button"
              disabled={busy !== null}
              onClick={() => decide("reject")}
              type="button"
            >
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function ApplicationsSection({ onDecided }: { onDecided: () => void }) {
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">(
    "pending",
  );
  const [state, reload] = useAdminData(
    `admin/project-applications?status=${status}`,
    selectApplications,
  );
  // The admin email links to /admin/applications/<id>; bring that card into view.
  useEffect(() => {
    if (state.status !== "ready") return;
    const id = /^\/admin\/applications\/([A-Za-z0-9_-]+)\/?$/u.exec(
      window.location.pathname,
    )?.[1];
    if (id) document.getElementById(`application-${id}`)?.scrollIntoView();
  }, [state]);
  return (
    <section aria-labelledby="admin-applications" className="admin-section">
      <div className="admin-section-heading">
        <h2 id="admin-applications">Project applications</h2>
        <fieldset className="admin-tabs">
          <legend className="visually-hidden">Application status</legend>
          {(["pending", "approved", "rejected"] as const).map((value) => (
            <label key={value}>
              <input
                checked={status === value}
                name="application-status"
                onChange={() => setStatus(value)}
                type="radio"
              />
              {value[0].toUpperCase() + value.slice(1)}
            </label>
          ))}
        </fieldset>
      </div>
      {state.status !== "ready" ? (
        <LoadNotice label="applications" retry={reload} state={state} />
      ) : state.value.length === 0 ? (
        <p className="admin-status">No {status} applications.</p>
      ) : (
        state.value.map((application) => (
          <ApplicationCard
            application={application}
            key={application.id}
            onDecided={() => {
              reload();
              onDecided();
            }}
          />
        ))
      )}
    </section>
  );
}

function ProjectEditor({
  project,
  onSaved,
}: {
  project: AdminProject;
  onSaved: () => void;
}) {
  const [text, setText] = useState(() =>
    JSON.stringify(project.manifest, null, 2),
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (event: FormEvent) => {
    event.preventDefault();
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      setError("The manifest is not valid JSON.");
      return;
    }
    setBusy(true);
    setError(null);
    projectApiRequest(
      "PUT",
      `admin/projects/${encodeURIComponent(project.id)}/manifest`,
      { manifest, expectedRevision: project.revision, reason },
    ).then(onSaved, (caught: unknown) => {
      setBusy(false);
      setError(errorMessage(caught));
    });
  };
  return (
    <form className="admin-editor" onSubmit={save}>
      <label>
        Manifest (revision {project.revision})
        <textarea
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          value={text}
        />
      </label>
      <label>
        Reason for this revision (public history)
        <input
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
          required
          value={reason}
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          <CircleAlert aria-hidden="true" /> {error}
        </p>
      ) : null}
      <button
        className="button primary-button"
        disabled={busy || reason.trim() === ""}
        type="submit"
      >
        {busy ? "Saving…" : `Save revision ${project.revision + 1}`}
      </button>
    </form>
  );
}

function ProjectsSection() {
  const [state, reload] = useAdminData("admin/projects", selectProjects);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section aria-labelledby="admin-projects" className="admin-section">
      <div className="admin-section-heading">
        <h2 id="admin-projects">Projects</h2>
      </div>
      <p className="admin-status">
        Approved projects start paused. The public site lists registry changes
        after the next build. A project can open only after its reviewed
        contributor and reviewer skills are on the development branch.
      </p>
      {state.status !== "ready" ? (
        <LoadNotice label="projects" retry={reload} state={state} />
      ) : state.value.length === 0 ? (
        <p className="admin-status">No projects are listed yet.</p>
      ) : (
        state.value.map((project) => (
          <article className="admin-card" key={project.id}>
            <header>
              <h3>{project.manifest.name}</h3>
              <span className={`admin-badge admin-badge-${project.status}`}>
                {project.status}
              </span>
            </header>
            <dl className="admin-facts">
              <div>
                <dt>Project id</dt>
                <dd>{project.id}</dd>
              </div>
              <div>
                <dt>Revision</dt>
                <dd>
                  {project.revision} · updated {formatTime(project.updatedAt)}{" "}
                  UTC
                </dd>
              </div>
              <div>
                <dt>Skills</dt>
                <dd>
                  {project.manifest.skill.sourcePath} ·{" "}
                  {project.manifest.reviewSkill.sourcePath}
                </dd>
              </div>
            </dl>
            {editing === project.id ? (
              <ProjectEditor
                onSaved={() => {
                  setEditing(null);
                  reload();
                }}
                project={project}
              />
            ) : (
              <button
                className="button secondary-button"
                onClick={() => setEditing(project.id)}
                type="button"
              >
                Edit manifest
              </button>
            )}
          </article>
        ))
      )}
    </section>
  );
}

export function AdminPage() {
  const state = useProjectSession();
  // An approval adds a project, so the registry list reloads after decisions.
  const [registryVersion, setRegistryVersion] = useState(0);
  let body: ReactNode;
  if (state.status !== "signed-in") {
    body = (
      <SignInPanel
        next="/admin"
        purpose="Admins sign in with GitHub to review project applications."
        state={state}
      />
    );
  } else if (!state.session.admin) {
    body = (
      <p className="form-error" role="alert">
        <CircleAlert aria-hidden="true" /> @{state.session.githubLogin} is not a
        Slop admin.
      </p>
    );
  } else {
    body = (
      <>
        <ApplicationsSection
          onDecided={() => setRegistryVersion((value) => value + 1)}
        />
        <ProjectsSection key={registryVersion} />
      </>
    );
  }
  return (
    <main className="shell route-main admin-page">
      <div className="admin-intro">
        <h1>Admin</h1>
        {state.status === "signed-in" ? (
          <p>Signed in as @{state.session.githubLogin}.</p>
        ) : null}
      </div>
      {body}
    </main>
  );
}

export default AdminPage;
