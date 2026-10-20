import type { ProjectDefinition } from "../../src/lib/projects.mjs";
import {
  notifyApplicationDecision,
  notifyProjectRevision,
} from "../notifications/events";
import type {
  AdminNotification,
  ApplicationStatus,
  DecisionInput,
  ProjectApplication,
  ProjectEnforcement,
  ProjectPersistence,
  ProjectRecord,
  ProjectRevision,
  ProjectRevisionInput,
} from "./contracts";

type D1Result<T = unknown> = {
  success: boolean;
  results?: T[];
  meta?: { changes?: number };
};
type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
};

export type ProjectD1Database = {
  batch(statements: D1Statement[]): Promise<D1Result[]>;
  prepare(query: string): D1Statement;
};

type ProjectRow = {
  id: string;
  status: ProjectDefinition["status"];
  revision: number;
  manifest: string;
  manifest_sha256: string;
  created_at: string;
  updated_at: string;
  source_application_id: string | null;
};

type ApplicationRow = {
  id: string;
  project_id: string;
  repository_key: string;
  manifest: string;
  manifest_sha256: string;
  acceptance_criteria: string;
  applicant_github_id: string;
  applicant_github_login: string;
  submitted_at: string;
  status: ApplicationStatus;
  admin_notification: AdminNotification;
  admin_notification_at: string | null;
  decided_at: string | null;
  decided_by_github_id: string | null;
  decided_by_github_login: string | null;
  decision_reason: string | null;
  github_check: string | null;
};

const PROJECT_COLUMNS =
  "id, status, revision, manifest, manifest_sha256, created_at, updated_at, source_application_id";
const APPLICATION_COLUMNS =
  "id, project_id, repository_key, manifest, manifest_sha256, acceptance_criteria, applicant_github_id, applicant_github_login, submitted_at, status, admin_notification, admin_notification_at, decided_at, decided_by_github_id, decided_by_github_login, decision_reason, github_check";

function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    status: row.status,
    revision: row.revision,
    manifest: JSON.parse(row.manifest) as ProjectDefinition,
    manifestSha256: row.manifest_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceApplicationId: row.source_application_id,
  };
}

function applicationFromRow(row: ApplicationRow): ProjectApplication {
  return {
    id: row.id,
    projectId: row.project_id,
    repositoryKey: row.repository_key,
    manifest: JSON.parse(row.manifest) as ProjectDefinition,
    manifestSha256: row.manifest_sha256,
    acceptanceCriteria: row.acceptance_criteria,
    applicant: {
      githubId: row.applicant_github_id,
      githubLogin: row.applicant_github_login,
    },
    submittedAt: row.submitted_at,
    status: row.status,
    adminNotification: row.admin_notification,
    adminNotificationAt: row.admin_notification_at,
    decidedAt: row.decided_at,
    decidedBy:
      row.decided_by_github_id === null || row.decided_by_github_login === null
        ? null
        : {
            githubId: row.decided_by_github_id,
            githubLogin: row.decided_by_github_login,
          },
    decisionReason: row.decision_reason,
    githubCheck: row.github_check,
  };
}

type EnforcementRow = {
  id: string;
  project_id: string;
  sequence: number;
  action: ProjectEnforcement["action"];
  state_after: ProjectEnforcement["stateAfter"];
  appeal_after: ProjectEnforcement["appealAfter"];
  reason: string;
  evidence_reference: string;
  repository_github_id: string;
  repository_keys: string;
  actor_github_id: string;
  actor_github_login: string;
  actor_role: ProjectEnforcement["actorRole"];
  decision_source: ProjectEnforcement["decisionSource"];
  before_revision: number;
  before_manifest_sha256: string;
  after_revision: number | null;
  after_manifest_sha256: string | null;
  result: ProjectEnforcement["result"];
  created_at: string;
};

const ENFORCEMENT_COLUMNS =
  "id, project_id, sequence, action, state_after, appeal_after, reason, evidence_reference, repository_github_id, repository_keys, actor_github_id, actor_github_login, actor_role, decision_source, before_revision, before_manifest_sha256, after_revision, after_manifest_sha256, result, created_at";

function enforcementFromRow(row: EnforcementRow): ProjectEnforcement {
  return {
    id: row.id,
    projectId: row.project_id,
    sequence: row.sequence,
    action: row.action,
    stateAfter: row.state_after,
    appealAfter: row.appeal_after,
    reason: row.reason,
    evidenceReference: row.evidence_reference,
    repositoryGithubId: row.repository_github_id,
    repositoryKeys: JSON.parse(row.repository_keys) as string[],
    actor: {
      githubId: row.actor_github_id,
      githubLogin: row.actor_github_login,
    },
    actorRole: row.actor_role,
    decisionSource: row.decision_source,
    beforeRevision: row.before_revision,
    beforeManifestSha256: row.before_manifest_sha256,
    afterRevision: row.after_revision,
    afterManifestSha256: row.after_manifest_sha256,
    result: row.result,
    createdAt: row.created_at,
  };
}

/** Constraint failures are expected races; anything else is a real fault. */
function isConstraintConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed|PRIMARY KEY|project (?:row|update) requires|enforcement sequence/u.test(
      error.message,
    )
  );
}

export class CloudflareProjectPersistence implements ProjectPersistence {
  constructor(private readonly db: ProjectD1Database) {}

  async listProjects(): Promise<ProjectRecord[]> {
    const result = await this.db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY id`)
      .all<ProjectRow>();
    return (result.results ?? []).map(projectFromRow);
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`)
      .bind(id)
      .first<ProjectRow>();
    return row === null ? null : projectFromRow(row);
  }

  async listRevisions(): Promise<ProjectRevision[]> {
    const result = await this.db
      .prepare(
        `SELECT project_id, revision, manifest, manifest_sha256, reason, created_at
           FROM project_revisions ORDER BY project_id, revision`,
      )
      .all<{
        project_id: string;
        revision: number;
        manifest: string;
        manifest_sha256: string;
        reason: string;
        created_at: string;
      }>();
    return (result.results ?? []).map((row) => ({
      projectId: row.project_id,
      revision: row.revision,
      manifest: JSON.parse(row.manifest) as ProjectDefinition,
      manifestSha256: row.manifest_sha256,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  async getRevisionText(
    projectId: string,
    revision: number,
  ): Promise<{ manifestText: string; manifestSha256: string } | null> {
    const row = await this.db
      .prepare(
        `SELECT manifest, manifest_sha256 FROM project_revisions
          WHERE project_id = ? AND revision = ?`,
      )
      .bind(projectId, revision)
      .first<{ manifest: string; manifest_sha256: string }>();
    return row === null
      ? null
      : { manifestText: row.manifest, manifestSha256: row.manifest_sha256 };
  }

  async getApplication(id: string): Promise<ProjectApplication | null> {
    const row = await this.db
      .prepare(
        `SELECT ${APPLICATION_COLUMNS} FROM project_applications WHERE id = ?`,
      )
      .bind(id)
      .first<ApplicationRow>();
    return row === null ? null : applicationFromRow(row);
  }

  async listApplications(
    status: ApplicationStatus,
  ): Promise<ProjectApplication[]> {
    const result = await this.db
      .prepare(
        `SELECT ${APPLICATION_COLUMNS} FROM project_applications
          WHERE status = ? ORDER BY submitted_at DESC, id LIMIT 200`,
      )
      .bind(status)
      .all<ApplicationRow>();
    return (result.results ?? []).map(applicationFromRow);
  }

  async listApplicantApplications(
    githubId: string,
  ): Promise<ProjectApplication[]> {
    const result = await this.db
      .prepare(
        `SELECT ${APPLICATION_COLUMNS} FROM project_applications
          WHERE applicant_github_id = ? ORDER BY submitted_at DESC, id LIMIT 50`,
      )
      .bind(githubId)
      .all<ApplicationRow>();
    return (result.results ?? []).map(applicationFromRow);
  }

  async countPendingApplications(githubId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM project_applications
          WHERE applicant_github_id = ? AND status = 'pending'`,
      )
      .bind(githubId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async createApplication(
    application: ProjectApplication & { manifestText: string },
  ): Promise<"created" | "conflict"> {
    try {
      await this.db
        .prepare(
          `INSERT INTO project_applications (
             id, project_id, repository_key, manifest, manifest_sha256,
             acceptance_criteria, applicant_github_id, applicant_github_login,
             submitted_at, status, admin_notification, github_check
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)`,
        )
        .bind(
          application.id,
          application.projectId,
          application.repositoryKey,
          application.manifestText,
          application.manifestSha256,
          application.acceptanceCriteria,
          application.applicant.githubId,
          application.applicant.githubLogin,
          application.submittedAt,
          application.githubCheck,
        )
        .run();
      return "created";
    } catch (error) {
      if (isConstraintConflict(error)) return "conflict";
      throw error;
    }
  }

  async recordAdminNotification(
    applicationId: string,
    outcome: Exclude<AdminNotification, "pending">,
    at: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE project_applications
            SET admin_notification = ?, admin_notification_at = ?
          WHERE id = ?`,
      )
      .bind(outcome, at, applicationId)
      .run();
  }

  async approveApplication(
    input: DecisionInput,
  ): Promise<"approved" | "conflict"> {
    const application = await this.getApplication(input.applicationId);
    if (application === null || application.status !== "pending") {
      return "conflict";
    }
    const pending = `EXISTS (SELECT 1 FROM project_applications WHERE id = ? AND status = 'pending')`;
    const manifestText = JSON.stringify(application.manifest);
    const reason = `Approved application ${application.id}${input.reason ? `: ${input.reason}` : ""}`;
    const statements = [
      this.db
        .prepare(
          `INSERT INTO project_revisions (
             project_id, revision, manifest, manifest_sha256, reason,
             actor_github_id, actor_github_login, created_at
           ) SELECT ?, 1, ?, ?, ?, ?, ?, ? WHERE ${pending}`,
        )
        .bind(
          application.projectId,
          manifestText,
          application.manifestSha256,
          reason.slice(0, 1000),
          input.actor.githubId,
          input.actor.githubLogin,
          input.at,
          application.id,
        ),
      this.db
        .prepare(
          `INSERT INTO projects (${PROJECT_COLUMNS})
           SELECT ?, 'paused', 1, ?, ?, ?, ?, ? WHERE ${pending}`,
        )
        .bind(
          application.projectId,
          manifestText,
          application.manifestSha256,
          input.at,
          input.at,
          application.id,
          application.id,
        ),
      ...application.manifest.repositories.map((repository) =>
        this.db
          .prepare(
            `INSERT INTO project_repositories (repository_key, project_id)
             SELECT ?, ? WHERE ${pending}`,
          )
          .bind(
            repository.id.toLowerCase(),
            application.projectId,
            application.id,
          ),
      ),
      this.db
        .prepare(
          `UPDATE project_applications
              SET status = 'approved', decided_at = ?, decided_by_github_id = ?,
                  decided_by_github_login = ?, decision_reason = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .bind(
          input.at,
          input.actor.githubId,
          input.actor.githubLogin,
          input.reason,
          application.id,
        ),
    ];
    const decision = statements.length - 1;
    statements.push(
      notifyApplicationDecision(this.db, application.id, input.at),
    );
    try {
      const results = await this.db.batch(statements);
      return results[decision]?.meta?.changes === 1 ? "approved" : "conflict";
    } catch (error) {
      if (isConstraintConflict(error)) return "conflict";
      throw error;
    }
  }

  async rejectApplication(
    input: DecisionInput & { reason: string },
  ): Promise<"rejected" | "conflict"> {
    const [result] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE project_applications
              SET status = 'rejected', decided_at = ?, decided_by_github_id = ?,
                  decided_by_github_login = ?, decision_reason = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .bind(
          input.at,
          input.actor.githubId,
          input.actor.githubLogin,
          input.reason,
          input.applicationId,
        ),
      notifyApplicationDecision(this.db, input.applicationId, input.at),
    ]);
    return result?.meta?.changes === 1 ? "rejected" : "conflict";
  }

  async appendProjectRevision(
    input: ProjectRevisionInput,
    expectedEnforcementGeneration: number,
  ): Promise<"updated" | "conflict"> {
    const nextRevision = input.expectedRevision + 1;
    // The revision applies only while no enforcement record has landed since
    // the caller read the restrictions it checked.
    const unrestricted =
      "(SELECT COALESCE(MAX(rowid), 0) FROM project_enforcements) = ?";
    const current = `EXISTS (SELECT 1 FROM projects WHERE id = ? AND revision = ?) AND ${unrestricted}`;
    try {
      const results = await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO project_revisions (
               project_id, revision, manifest, manifest_sha256, reason,
               actor_github_id, actor_github_login, created_at
             ) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${current}`,
          )
          .bind(
            input.projectId,
            nextRevision,
            input.manifestText,
            input.manifestSha256,
            input.reason,
            input.actor.githubId,
            input.actor.githubLogin,
            input.at,
            input.projectId,
            input.expectedRevision,
            expectedEnforcementGeneration,
          ),
        this.db
          .prepare(
            `UPDATE projects
                SET status = ?, revision = ?, manifest = ?, manifest_sha256 = ?,
                    updated_at = ?
              WHERE id = ? AND revision = ? AND ${unrestricted}`,
          )
          .bind(
            input.manifest.status,
            nextRevision,
            input.manifestText,
            input.manifestSha256,
            input.at,
            input.projectId,
            input.expectedRevision,
            expectedEnforcementGeneration,
          ),
        notifyProjectRevision(
          this.db,
          input.projectId,
          nextRevision,
          input.manifestSha256,
          input.at,
        ),
      ]);
      return results[1]?.meta?.changes === 1 ? "updated" : "conflict";
    } catch (error) {
      if (isConstraintConflict(error)) return "conflict";
      throw error;
    }
  }

  async listEnforcements(): Promise<ProjectEnforcement[]> {
    const result = await this.db
      .prepare(
        `SELECT ${ENFORCEMENT_COLUMNS} FROM project_enforcements
          ORDER BY project_id, sequence`,
      )
      .all<EnforcementRow>();
    return (result.results ?? []).map(enforcementFromRow);
  }

  async enforcementGeneration(): Promise<number> {
    // Records are never updated or deleted, so the newest rowid changes on
    // every append and on nothing else.
    const row = await this.db
      .prepare(
        "SELECT COALESCE(MAX(rowid), 0) AS generation FROM project_enforcements",
      )
      .first<{ generation: number }>();
    if (row === null || !Number.isSafeInteger(row.generation))
      throw new Error("Enforcement generation is unavailable");
    return row.generation;
  }

  async appendEnforcement(
    record: ProjectEnforcement,
    revision: ProjectRevisionInput | null,
  ): Promise<"recorded" | "conflict"> {
    const current = `EXISTS (SELECT 1 FROM projects WHERE id = ? AND revision = ? AND manifest_sha256 = ?)`;
    const statements = [
      this.db
        .prepare(
          `INSERT INTO project_enforcements (${ENFORCEMENT_COLUMNS})
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE ${current}`,
        )
        .bind(
          record.id,
          record.projectId,
          record.sequence,
          record.action,
          record.stateAfter,
          record.appealAfter,
          record.reason,
          record.evidenceReference,
          record.repositoryGithubId,
          JSON.stringify(record.repositoryKeys),
          record.actor.githubId,
          record.actor.githubLogin,
          record.actorRole,
          record.decisionSource,
          record.beforeRevision,
          record.beforeManifestSha256,
          record.afterRevision,
          record.afterManifestSha256,
          record.result,
          record.createdAt,
          record.projectId,
          record.beforeRevision,
          record.beforeManifestSha256,
        ),
    ];
    if (revision !== null) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO project_revisions (
               project_id, revision, manifest, manifest_sha256, reason,
               actor_github_id, actor_github_login, created_at
             ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
                WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND revision = ?)`,
          )
          .bind(
            revision.projectId,
            revision.expectedRevision + 1,
            revision.manifestText,
            revision.manifestSha256,
            revision.reason,
            revision.actor.githubId,
            revision.actor.githubLogin,
            revision.at,
            revision.projectId,
            revision.expectedRevision,
          ),
        this.db
          .prepare(
            `UPDATE projects
                SET status = ?, revision = ?, manifest = ?, manifest_sha256 = ?,
                    updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .bind(
            revision.manifest.status,
            revision.expectedRevision + 1,
            revision.manifestText,
            revision.manifestSha256,
            revision.at,
            revision.projectId,
            revision.expectedRevision,
          ),
      );
    }
    try {
      const results = await this.db.batch(statements);
      return results.every((entry) => entry.meta?.changes === 1)
        ? "recorded"
        : "conflict";
    } catch (error) {
      if (isConstraintConflict(error)) return "conflict";
      throw error;
    }
  }
}
