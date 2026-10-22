import type { ProjectDefinition } from "../../src/lib/projects.mjs";

export const PROJECT_API_CONTRACT_VERSION = "project-registry-v1";
/** Bounds open applications so one account cannot flood the review queue. */
export const MAX_PENDING_APPLICATIONS_PER_APPLICANT = 3;
/**
 * GitHub's answer on whether the applicant controls the repository. It is
 * shown to the admin who decides; a mismatch means the manifest misstates the
 * repository and is refused.
 */
export type RepositoryControl =
  | { state: "proven"; reason: string }
  | { state: "unproven"; reason: string }
  | { state: "mismatch"; reason: string };

export type GithubActor = { githubId: string; githubLogin: string };

export type WebSession = GithubActor & { admin: boolean };

export type ProjectRecord = {
  id: string;
  status: ProjectDefinition["status"];
  revision: number;
  manifest: ProjectDefinition;
  manifestSha256: string;
  createdAt: string;
  updatedAt: string;
  sourceApplicationId: string | null;
};

export type ProjectRevision = {
  projectId: string;
  revision: number;
  manifest: ProjectDefinition;
  manifestSha256: string;
  reason: string;
  createdAt: string;
};

export type ApplicationStatus = "pending" | "approved" | "rejected";
export type AdminNotification = "pending" | "sent" | "failed";

export type ProjectApplication = {
  expectedRevision?: number;
  changeReason?: string;
  id: string;
  projectId: string;
  repositoryKey: string;
  manifest: ProjectDefinition;
  manifestSha256: string;
  acceptanceCriteria: string;
  applicant: GithubActor;
  submittedAt: string;
  status: ApplicationStatus;
  adminNotification: AdminNotification;
  adminNotificationAt: string | null;
  decidedAt: string | null;
  decidedBy: GithubActor | null;
  decisionReason: string | null;
  /** Public GitHub evidence about the applicant's repository control. */
  githubCheck: string | null;
};

export type ProjectRevisionInput = {
  applicationId?: string;
  projectId: string;
  /** Revision the caller read; the write fails if another write landed. */
  expectedRevision: number;
  manifest: ProjectDefinition;
  manifestText: string;
  manifestSha256: string;
  reason: string;
  actor: GithubActor;
  at: string;
};

export type DecisionInput = {
  applicationId: string;
  actor: GithubActor;
  reason: string | null;
  at: string;
};

export type EnforcementAction =
  | "quarantine"
  | "ban"
  | "request_reinstatement"
  | "reinstate"
  | "deny_reinstatement";
export type EnforcementActorRole =
  | "project-moderator"
  | "project-steward"
  | "project-applicant"
  | "vetting-service";
export type RestrictionState = "clear" | "quarantined" | "banned";
export type AppealState = "none" | "requested" | "granted" | "denied";
export type EnforcementResult =
  | "revision_appended"
  | "revision_pending"
  | "no_revision_needed";

/** One append-only ADM-06 record with the ADM-05 audit fields. */
export type ProjectEnforcement = {
  id: string;
  projectId: string;
  sequence: number;
  action: EnforcementAction;
  stateAfter: RestrictionState;
  appealAfter: AppealState;
  reason: string;
  evidenceReference: string;
  /** Immutable GitHub repository id from the manifest authority. */
  repositoryGithubId: string;
  /** Lowercase repository paths, including transfer aliases. */
  repositoryKeys: string[];
  actor: GithubActor | null;
  systemIssuer?: {
    kind: "vetting-service";
    keySha256: string;
    assessmentId: string;
    policyVersion: string;
    rule: string;
  };
  /** A steward or applicant may only file a reinstatement request (ELG-02). */
  actorRole: EnforcementActorRole;
  decisionSource: "admin-panel" | "owner-request" | "standing-rule";
  beforeRevision: number;
  beforeManifestSha256: string;
  afterRevision: number | null;
  afterManifestSha256: string | null;
  result: EnforcementResult;
  /** Exact scan and malicious findings covered by this independent decision. */
  vettingReview?: { assessmentId: string; maliciousAssessmentIds: string[] };
  createdAt: string;
};

export interface ProjectPersistence {
  listProjects(): Promise<ProjectRecord[]>;
  getProject(id: string): Promise<ProjectRecord | null>;
  /** The complete append-only policy history, oldest first per project. */
  listRevisions(): Promise<ProjectRevision[]>;
  /** One approved revision with its exact stored manifest bytes. */
  getRevisionText(
    projectId: string,
    revision: number,
  ): Promise<{ manifestText: string; manifestSha256: string } | null>;
  getApplication(id: string): Promise<ProjectApplication | null>;
  listApplications(status: ApplicationStatus): Promise<ProjectApplication[]>;
  listApplicantApplications(githubId: string): Promise<ProjectApplication[]>;
  countPendingApplications(githubId: string): Promise<number>;
  /** Returns "conflict" when the project or repository already has an open application. */
  createApplication(
    application: ProjectApplication & { manifestText: string },
  ): Promise<"created" | "conflict">;
  recordAdminNotification(
    applicationId: string,
    outcome: Exclude<AdminNotification, "pending">,
    at: string,
  ): Promise<void>;
  /** Atomically lists the submitted manifest as revision 1 of a paused project. */
  approveApplication(input: DecisionInput): Promise<"approved" | "conflict">;
  rejectApplication(
    input: DecisionInput & { reason: string },
  ): Promise<"rejected" | "conflict">;
  /**
   * Appends the revision only while the project is at `expectedRevision`
   * and the enforcement generation is still `expectedEnforcementGeneration`.
   */
  appendProjectRevision(
    input: ProjectRevisionInput,
    expectedEnforcementGeneration: number,
  ): Promise<"updated" | "conflict">;
  /** Every enforcement record, oldest first per project. */
  listEnforcements(): Promise<ProjectEnforcement[]>;
  /** Changes on every enforcement record; it keys the public edge cache. */
  enforcementGeneration(): Promise<number>;
  /**
   * Atomically appends the record and, when given, the matching revision.
   * Both apply only while the project is still at `beforeRevision`. The
   * same write adds the inbox rows for the project's applicant and steward,
   * and for `appealReviewers` when the record requests reinstatement.
   */
  appendEnforcement(
    record: ProjectEnforcement,
    revision: ProjectRevisionInput | null,
    appealReviewers: readonly string[],
  ): Promise<"recorded" | "conflict">;
}
