/**
 * Authenticated in-app inbox (PRD NOT-01). Rows are written only by the
 * migration 0024 triggers, in the same transaction as the source change; this
 * route lists the signed-in recipient's own rows and marks them read. It never
 * sends email and never reads another account's rows.
 */
import { readBoundedJson } from "../../src/lib/browser-json";
import {
  isNotificationEventKey,
  MAX_NOTIFICATION_MARK,
  type Notification,
  type NotificationsResponse,
} from "../../src/lib/notifications";

export interface NotificationsDependencies {
  db: {
    prepare(query: string): {
      bind(...values: (string | number)[]): {
        all<T>(): Promise<{ results: T[] }>;
        run(): Promise<{ meta?: { changes?: number } }>;
      };
    };
  };
  sessionActor(request: Request): Promise<{ githubId: string } | null>;
  now(): Date;
}

export const NOTIFICATIONS_PATH = "/api/v1/notifications";
const READ_PATH = `${NOTIFICATIONS_PATH}/read`;
const LIST_LIMIT = 100;

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

interface Row {
  event_key: string;
  kind: Notification["kind"];
  subject: string;
  detail: string | null;
  action_path: string;
  source_at: string;
  created_at: string;
  read_at: string | null;
}

/** Returns null when the request is not for this route. */
export async function handleNotificationsApi(
  request: Request,
  deps: NotificationsDependencies,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== NOTIFICATIONS_PATH && url.pathname !== READ_PATH)
    return null;
  const write = url.pathname === READ_PATH;
  if (request.method !== (write ? "POST" : "GET"))
    return json(405, { error: "method_not_allowed" });
  // Writes ride the SameSite session cookie, so they must come from this
  // origin as JSON; a cross-site form can never submit one.
  if (
    write &&
    (request.headers.get("origin") !== url.origin ||
      request.headers.get("content-type")?.split(";")[0] !== "application/json")
  )
    return json(403, { error: "origin_forbidden" });
  try {
    const actor = await deps.sessionActor(request);
    if (actor === null) return json(401, { error: "not_signed_in" });
    if (!write) {
      const [rows, unread] = await Promise.all([
        deps.db
          .prepare(
            `SELECT event_key, kind, subject, detail, action_path, source_at,
                    created_at, read_at
               FROM notifications WHERE recipient_github_id = ?
              ORDER BY source_at DESC, event_key LIMIT ?`,
          )
          .bind(actor.githubId, LIST_LIMIT)
          .all<Row>(),
        deps.db
          .prepare(
            `SELECT COUNT(*) AS count FROM notifications
              WHERE recipient_github_id = ? AND read_at IS NULL`,
          )
          .bind(actor.githubId)
          .all<{ count: number }>(),
      ]);
      const body: NotificationsResponse = {
        notifications: rows.results.map((row) => ({
          eventKey: row.event_key,
          kind: row.kind,
          subject: row.subject,
          detail: row.detail,
          actionPath: row.action_path,
          sourceAt: row.source_at,
          createdAt: row.created_at,
          readAt: row.read_at,
        })),
        unread: unread.results[0]?.count ?? 0,
      };
      return json(200, body);
    }
    let body: unknown;
    try {
      body = await readBoundedJson(
        request as unknown as Response,
        32 * 1024,
        "notification read request",
      );
    } catch {
      return json(400, { error: "invalid_request" });
    }
    const keys = (body as { eventKeys?: unknown } | null)?.eventKeys;
    if (
      typeof body !== "object" ||
      body === null ||
      Object.keys(body).length !== 1 ||
      !Array.isArray(keys) ||
      keys.length < 1 ||
      keys.length > MAX_NOTIFICATION_MARK ||
      !keys.every(isNotificationEventKey) ||
      new Set(keys).size !== keys.length
    )
      return json(400, { error: "invalid_request" });
    const result = await deps.db
      .prepare(
        `UPDATE notifications SET read_at = ?
          WHERE recipient_github_id = ? AND read_at IS NULL
            AND event_key IN (${keys.map(() => "?").join(", ")})`,
      )
      .bind(deps.now().toISOString(), actor.githubId, ...keys)
      .run();
    const marked = result.meta?.changes;
    if (typeof marked !== "number") throw new Error("D1 reported no changes");
    return json(200, { marked });
  } catch {
    console.error("notifications API failure");
    return json(500, { error: "internal_error" });
  }
}
