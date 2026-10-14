/**
 * Admin recipients come from the `ADMIN_EMAILS` Worker secret, a
 * comma-separated list that operators configure outside the repository.
 */
export const MAX_ADMIN_RECIPIENTS = 10;
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
