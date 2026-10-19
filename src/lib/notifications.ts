/** In-app inbox contract shared by the API and the page (PRD NOT-01). */

export const NOTIFICATION_KINDS = [
  "application_approved",
  "application_rejected",
  "project_revision",
  "award_reserved",
  "payment_paid",
  "payout_held",
  "wallet_changed",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface Notification {
  /** Stable source event identity; a replay of the event reuses it. */
  eventKey: string;
  kind: NotificationKind;
  /** The project id, or the network for a wallet change. */
  subject: string;
  detail: string | null;
  /** A same-site path that opens the details. */
  actionPath: string;
  /** When the source change happened. */
  sourceAt: string;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsResponse {
  notifications: Notification[];
  unread: number;
}

/** The most event keys one read request may mark. */
export const MAX_NOTIFICATION_MARK = 100;

export function isNotificationEventKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 300 &&
    /^[a-z-]+:[\x21-\x7e]+$/u.test(value)
  );
}

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

function isNotification(value: unknown): value is Notification {
  if (typeof value !== "object" || value === null) return false;
  const n = value as Record<string, unknown>;
  return (
    isNotificationEventKey(n.eventKey) &&
    NOTIFICATION_KINDS.includes(n.kind as NotificationKind) &&
    typeof n.subject === "string" &&
    n.subject.length > 0 &&
    (n.detail === null || typeof n.detail === "string") &&
    typeof n.actionPath === "string" &&
    n.actionPath.startsWith("/") &&
    !n.actionPath.startsWith("//") &&
    isTimestamp(n.sourceAt) &&
    isTimestamp(n.createdAt) &&
    (n.readAt === null || isTimestamp(n.readAt))
  );
}

/** Rejects any response that does not match the contract exactly. */
export function parseNotificationsResponse(
  value: unknown,
): NotificationsResponse {
  const body = value as Partial<NotificationsResponse> | null;
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray(body.notifications) ||
    !body.notifications.every(isNotification) ||
    !Number.isSafeInteger(body.unread) ||
    (body.unread as number) < 0
  )
    throw new Error("The inbox returned an invalid response.");
  return body as NotificationsResponse;
}

/** One plain sentence for each event kind. */
export function notificationTitle(n: Notification): string {
  switch (n.kind) {
    case "application_approved":
      return `Your application for ${n.subject} was approved. The project is listed as paused.`;
    case "application_rejected":
      return `Your application for ${n.subject} was not approved.`;
    case "project_revision":
      return `The ${n.subject} project manifest changed.`;
    case "award_reserved":
      return `An award from ${n.subject} is reserved for you.`;
    case "payment_paid":
      return `A payment from ${n.subject} is finalized.`;
    case "payout_held":
      return `A payout from ${n.subject} is held.`;
    case "wallet_changed":
      return `A ${n.subject} payout wallet was added to your account.`;
  }
}

/** The label of the link that opens the details. */
export function notificationAction(n: Notification): string {
  switch (n.kind) {
    case "application_approved":
    case "project_revision":
      return "Open project";
    case "application_rejected":
      return "Apply again";
    case "award_reserved":
    case "payment_paid":
    case "payout_held":
      return "Open payouts";
    case "wallet_changed":
      return "Review wallets";
  }
}
