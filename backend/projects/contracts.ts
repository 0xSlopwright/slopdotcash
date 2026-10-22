import type {
  AdminNotification,
  ApplicationStatus,
  DecisionInput,
  ProjectApplication,
  ProjectEnforcement,
  ProjectRecord,
  ProjectRevision,
  ProjectRevisionInput,
} from "../../src/lib/project-contracts";

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

export type {
  AdminNotification,
  AppealState,
  ApplicationStatus,
  DecisionInput,
  EnforcementAction,
  EnforcementActorRole,
  EnforcementResult,
  GithubActor,
  ProjectApplication,
  ProjectEnforcement,
  ProjectRecord,
  ProjectRevision,
  ProjectRevisionInput,
  RestrictionState,
  WebSession,
} from "../../src/lib/project-contracts";

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
  /** Membership is keyed by the immutable current GitHub actor ID. */
  hasSignedInActor(githubId: string): Promise<boolean>;
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
