/** Signed-in inbox for account, project and payment events (PRD NOT-01). */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithDeadline, readBoundedJson } from "./lib/browser-json";
import {
  MAX_NOTIFICATION_MARK,
  type Notification,
  type NotificationsResponse,
  notificationAction,
  notificationTitle,
  parseNotificationsResponse,
} from "./lib/notifications";
import { loginHref } from "./Points";
import { formatDateTime } from "./Presentation";

type InboxState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error"; message: string }
  | { status: "ready"; value: NotificationsResponse };

const UNAVAILABLE =
  "The inbox is unavailable. Your account and payouts are unchanged. Please retry.";

async function loadInbox(signal: AbortSignal): Promise<InboxState> {
  const response = await fetchWithDeadline("/api/v1/notifications", {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (response.status === 401) return { status: "signed-out" };
  if (!response.ok) throw new Error(UNAVAILABLE);
  return {
    status: "ready",
    value: parseNotificationsResponse(
      await readBoundedJson(response, 1_048_576, "inbox"),
    ),
  };
}

async function markRead(eventKeys: string[]): Promise<"ok" | "signed-out"> {
  const response = await fetchWithDeadline("/api/v1/notifications/read", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventKeys }),
  });
  if (response.status === 401) return "signed-out";
  if (!response.ok)
    throw new Error("Could not mark the notification as read. Please retry.");
  return "ok";
}

export function InboxPage() {
  const [state, setState] = useState<InboxState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setState({ status: "loading" });
    loadInbox(controller.signal).then(
      (next) => {
        if (generation.current === current) setState(next);
      },
      () => {
        if (generation.current === current)
          setState({ status: "error", message: UNAVAILABLE });
      },
    );
    return () => controller.abort();
  }, []);
  useEffect(() => load(), [load]);

  async function mark(eventKeys: string[], done: string) {
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      if ((await markRead(eventKeys)) === "signed-out") {
        setState({ status: "signed-out" });
        return;
      }
      const current = ++generation.current;
      const next = await loadInbox(new AbortController().signal);
      if (generation.current === current) {
        setState(next);
        setMessage(done);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : UNAVAILABLE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell route-main inbox-page">
      <h1>Inbox</h1>
      <p>
        Decisions on your project applications, changes to your projects,
        awards, payments and payout wallets. Slop does not send these by email.
      </p>
      {state.status === "loading" ? (
        <p role="status">Loading your inbox…</p>
      ) : null}
      {state.status === "signed-out" ? (
        <div className="sign-in-panel">
          <p>Sign in with GitHub to read your inbox.</p>
          <a className="button primary-button" href={loginHref("/inbox")}>
            Sign in with GitHub
          </a>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div role="alert">
          <p>{state.message}</p>
          <button
            className="button secondary-button"
            type="button"
            onClick={load}
          >
            Retry
          </button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <InboxList
          busy={busy}
          response={state.value}
          onMark={(keys, done) => void mark(keys, done)}
        />
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {actionError ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}
    </main>
  );
}

function InboxList({
  response,
  busy,
  onMark,
}: {
  response: NotificationsResponse;
  busy: boolean;
  onMark(eventKeys: string[], done: string): void;
}) {
  const unreadKeys = response.notifications
    .filter((n) => n.readAt === null)
    .map((n) => n.eventKey)
    .slice(0, MAX_NOTIFICATION_MARK);
  if (response.notifications.length === 0)
    return <p className="inbox-empty">You have no notifications.</p>;
  return (
    <>
      <div className="inbox-summary">
        <p>
          {response.unread === 0
            ? "All notifications are read."
            : `${response.unread} unread`}
        </p>
        {unreadKeys.length > 0 ? (
          <button
            className="button secondary-button"
            type="button"
            disabled={busy}
            onClick={() =>
              onMark(unreadKeys, "All shown notifications are read.")
            }
          >
            Mark all as read
          </button>
        ) : null}
      </div>
      <ol className="inbox-list" aria-label="Notifications">
        {response.notifications.map((n) => (
          <InboxItem
            busy={busy}
            key={n.eventKey}
            notification={n}
            onMark={onMark}
          />
        ))}
      </ol>
    </>
  );
}

function InboxItem({
  notification: n,
  busy,
  onMark,
}: {
  notification: Notification;
  busy: boolean;
  onMark(eventKeys: string[], done: string): void;
}) {
  const unread = n.readAt === null;
  const title = notificationTitle(n);
  return (
    <li className={unread ? "inbox-item inbox-unread" : "inbox-item"}>
      <p className="inbox-state">{unread ? "Unread" : "Read"}</p>
      <p className="inbox-title">{title}</p>
      {n.detail ? <p className="inbox-detail">{n.detail}</p> : null}
      <p className="inbox-meta">
        <time dateTime={n.sourceAt}>{formatDateTime(n.sourceAt)}</time>
      </p>
      <div className="inbox-actions">
        <a href={n.actionPath}>{notificationAction(n)}</a>
        {unread ? (
          <button
            className="button secondary-button"
            type="button"
            disabled={busy}
            aria-label={`Mark as read: ${title}`}
            onClick={() => onMark([n.eventKey], "Marked as read.")}
          >
            Mark as read
          </button>
        ) : null}
      </div>
    </li>
  );
}

export default InboxPage;
