/**
 * The fixed admin recipient list. `wrangler.toml` must list exactly these
 * addresses in `allowed_destination_addresses`; the test suite enforces that.
 */
export const ADMIN_NOTIFICATION_RECIPIENTS = [
  "shawmakesmagic@gmail.com",
  "drew.piers@gmail.com",
] as const;

export const NOTIFY_INTERNAL_HOST = "notify.internal";
export const PROJECT_APPLICATION_NOTICE_PATH = "/v1/project-applications";
export const MAX_NOTICE_BODY_BYTES = 8 * 1024;
export const REVIEW_URL_PREFIX = "https://slop.cash/admin";

export type ProjectApplicationNotice = {
  applicationId: string;
  projectId: string;
  projectName: string;
  repository: string;
  applicantLogin: string;
  submittedAt: string;
  reviewUrl: string;
};
