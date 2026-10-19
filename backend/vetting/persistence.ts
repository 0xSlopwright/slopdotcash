/**
 * D1 storage for vetting assessments and artifact quarantine records, and the
 * revision-bound clearance rule every executable surface asks before it
 * serves a project (PRD VET-01, VET-06, VET-07).
 */

import { canonicalJson } from "../../scripts/readme-proof-binding";
import type { ProjectD1Database } from "../projects/cloudflare-persistence";
import type { GithubActor } from "../projects/contracts";
import { sha256Hex } from "../trace/validation";
import type {
  VettingArtifact,
  VettingDisposition,
  VettingResult,
} from "./result";

export type AssessmentState = "pending" | VettingDisposition;

export type VettingAssessment = {
  id: string;
  projectId: string;
  revision: number;
  manifestSha256: string;
  contentSha256: string;
  requestedBy: GithubActor;
  requestedAt: string;
  requestReason: string;
  state: AssessmentState;
  commitSha: string | null;
  policyVersion: string | null;
  result: VettingResult | null;
  resultSha256: string | null;
  signingKeySha256: string | null;
  completedAt: string | null;
};

/** The safe public summary of one assessment (VET-01 display fields). */
export type AssessmentSummary = {
  id: string;
  revision: number;
  state: AssessmentState;
  commitSha: string | null;
  policyVersion: string | null;
  requestedAt: string;
  completedAt: string | null;
  modelRuns: { reviewer: string; provider: string; model: string }[];
  artifacts: number;
  heldArtifacts: number;
};

/**
 * What a revision may do. Only "cleared" lets Slop serve skills, list the
 * project for discovery, or activate the revision.
 */
export type VettingClearance =
  | { state: "unscanned" }
  | { state: "queued"; assessment: AssessmentSummary }
  | { state: "quarantined"; assessment: AssessmentSummary }
  | { state: "cleared"; assessment: AssessmentSummary }
  | { state: "banned"; assessment: AssessmentSummary };

type AssessmentRow = {
  id: string;
  project_id: string;
  revision: number;
  manifest_sha256: string;
  content_sha256: string;
  requested_by_github_id: string;
  requested_by_github_login: string;
  requested_at: string;
  request_reason: string;
  state: AssessmentState;
  commit_sha: string | null;
  policy_version: string | null;
  result: string | null;
  result_sha256: string | null;
  signing_key_sha256: string | null;
  completed_at: string | null;
};

const COLUMNS =
  "id, project_id, revision, manifest_sha256, content_sha256, requested_by_github_id, requested_by_github_login, requested_at, request_reason, state, commit_sha, policy_version, result, result_sha256, signing_key_sha256, completed_at";

function fromRow(row: AssessmentRow): VettingAssessment {
  return {
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    manifestSha256: row.manifest_sha256,
    contentSha256: row.content_sha256,
    requestedBy: {
      githubId: row.requested_by_github_id,
      githubLogin: row.requested_by_github_login,
    },
    requestedAt: row.requested_at,
    requestReason: row.request_reason,
    state: row.state,
    commitSha: row.commit_sha,
    policyVersion: row.policy_version,
    result:
      row.result === null ? null : (JSON.parse(row.result) as VettingResult),
    resultSha256: row.result_sha256,
    signingKeySha256: row.signing_key_sha256,
    completedAt: row.completed_at,
  };
}

/**
 * The executable content of a manifest: its key-sorted canonical JSON with
 * the status fixed to paused. Activating a cleared paused revision keeps the
 * digest, whatever key order the editor sent; any other change needs a
 * fresh scan.
 */
export async function vettedContentSha256(manifest: object): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(canonicalJson({ ...manifest, status: "paused" })),
  );
}

export function summarize(assessment: VettingAssessment): AssessmentSummary {
  const artifacts: VettingArtifact[] = assessment.result?.artifacts ?? [];
  return {
    id: assessment.id,
    revision: assessment.revision,
    state: assessment.state,
    commitSha: assessment.commitSha,
    policyVersion: assessment.policyVersion,
    requestedAt: assessment.requestedAt,
    completedAt: assessment.completedAt,
    modelRuns: (assessment.result?.modelReviews ?? []).map((review) => ({
      reviewer: review.reviewer,
      provider: review.provider,
      model: review.model,
    })),
    artifacts: artifacts.length,
    heldArtifacts: artifacts.filter((artifact) => artifact.state !== "released")
      .length,
  };
}

function newest<T>(items: T[], match: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1)
    if (match(items[index])) return items[index];
  return undefined;
}

export class CloudflareVettingPersistence {
  constructor(private readonly db: ProjectD1Database) {}

  async listAssessments(): Promise<VettingAssessment[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM vetting_assessments ORDER BY requested_at DESC, rowid DESC LIMIT 500`,
      )
      .all<AssessmentRow>();
    return (rows.results ?? []).map(fromRow);
  }

  async projectAssessments(projectId: string): Promise<VettingAssessment[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM vetting_assessments WHERE project_id = ? ORDER BY requested_at, rowid`,
      )
      .bind(projectId)
      .all<AssessmentRow>();
    return (rows.results ?? []).map(fromRow);
  }

  async pendingAssessments(): Promise<VettingAssessment[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM vetting_assessments WHERE state = 'pending' ORDER BY requested_at, rowid LIMIT 100`,
      )
      .all<AssessmentRow>();
    return (rows.results ?? []).map(fromRow);
  }

  async getAssessment(id: string): Promise<VettingAssessment | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM vetting_assessments WHERE id = ?`)
      .bind(id)
      .first<AssessmentRow>();
    return row === null ? null : fromRow(row);
  }

  /** Every revision of a project, oldest first, with its content digest. */
  async revisionContents(
    projectId: string,
  ): Promise<{ revision: number; contentSha256: string }[]> {
    const rows = await this.db
      .prepare(
        "SELECT revision, manifest FROM project_revisions WHERE project_id = ? ORDER BY revision",
      )
      .bind(projectId)
      .all<{ revision: number; manifest: string }>();
    return Promise.all(
      (rows.results ?? []).map(async (row) => ({
        revision: row.revision,
        contentSha256: await vettedContentSha256(JSON.parse(row.manifest)),
      })),
    );
  }

  /** Returns "conflict" when this revision already has a queued scan. */
  async createAssessment(
    assessment: Omit<
      VettingAssessment,
      | "state"
      | "commitSha"
      | "policyVersion"
      | "result"
      | "resultSha256"
      | "signingKeySha256"
      | "completedAt"
    >,
  ): Promise<"created" | "conflict"> {
    try {
      await this.db
        .prepare(
          `INSERT INTO vetting_assessments (id, project_id, revision, manifest_sha256, content_sha256, requested_by_github_id, requested_by_github_login, requested_at, request_reason, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .bind(
          assessment.id,
          assessment.projectId,
          assessment.revision,
          assessment.manifestSha256,
          assessment.contentSha256,
          assessment.requestedBy.githubId,
          assessment.requestedBy.githubLogin,
          assessment.requestedAt,
          assessment.requestReason,
        )
        .run();
      return "created";
    } catch (error) {
      if (error instanceof Error && /UNIQUE/u.test(error.message))
        return "conflict";
      throw error;
    }
  }

  /**
   * Records the one result of a pending assessment with its quarantine
   * records in one transaction. The update has no state filter on purpose:
   * the result-once trigger aborts the whole batch if a result already
   * landed, so artifacts can never attach to another result.
   */
  async recordResult(input: {
    result: VettingResult;
    resultText: string;
    resultSha256: string;
    signingKeySha256: string;
    at: string;
  }): Promise<"recorded" | "conflict"> {
    const { result } = input;
    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE vetting_assessments
                SET state = ?, commit_sha = ?, policy_version = ?, result = ?,
                    result_sha256 = ?, signing_key_sha256 = ?, completed_at = ?
              WHERE id = ?`,
          )
          .bind(
            result.disposition,
            result.assessed.commitSha,
            result.policyVersion,
            input.resultText,
            input.resultSha256,
            input.signingKeySha256,
            input.at,
            result.assessmentId,
          ),
        ...result.artifacts.map((artifact, ordinal) =>
          this.db
            .prepare(
              `INSERT INTO vetting_artifacts (assessment_id, ordinal, sha256, parent_sha256, origin, path, artifact_type, state, analysis, requested_execution)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              result.assessmentId,
              ordinal,
              artifact.sha256,
              artifact.parentSha256,
              artifact.origin,
              artifact.path,
              artifact.type,
              artifact.state,
              artifact.analysis,
              artifact.requestedExecution ? 1 : 0,
            ),
        ),
      ]);
      return "recorded";
    } catch (error) {
      if (
        error instanceof Error &&
        /a vetting result is recorded once/u.test(error.message)
      )
        return "conflict";
      throw error;
    }
  }

  /** The clearance of a manifest, a stored revision or an activation candidate. */
  async manifestClearance(
    projectId: string,
    manifest: object,
    throughRevision: number,
  ): Promise<VettingClearance> {
    return this.clearance(
      projectId,
      await vettedContentSha256(manifest),
      throughRevision,
    );
  }

  /**
   * The clearance of a project's content digest through a revision. A
   * confirmed-malicious result at any revision bans the project until the
   * separate reinstatement path (ADM-06) exists; a new commit or a later
   * clean scan cannot lift it. Otherwise the newest finished assessment of
   * the unbroken run of revisions with the same content decides.
   */
  async clearance(
    projectId: string,
    contentSha256: string,
    throughRevision: number,
  ): Promise<VettingClearance> {
    const assessments = await this.projectAssessments(projectId);
    const malicious = newest(
      assessments,
      (assessment) => assessment.state === "malicious",
    );
    if (malicious) return { state: "banned", assessment: summarize(malicious) };
    const window = new Set<number>();
    const revisions = await this.revisionContents(projectId);
    for (let index = revisions.length - 1; index >= 0; index -= 1) {
      const revision = revisions[index];
      if (revision.revision > throughRevision) continue;
      if (revision.contentSha256 !== contentSha256) break;
      window.add(revision.revision);
    }
    const relevant = assessments.filter(
      (assessment) =>
        window.has(assessment.revision) &&
        assessment.contentSha256 === contentSha256,
    );
    const finished = newest(
      relevant,
      (assessment) => assessment.state !== "pending",
    );
    if (finished?.state === "clean")
      return { state: "cleared", assessment: summarize(finished) };
    if (finished !== undefined)
      return { state: "quarantined", assessment: summarize(finished) };
    const queued = newest(
      relevant,
      (assessment) => assessment.state === "pending",
    );
    return queued
      ? { state: "queued", assessment: summarize(queued) }
      : { state: "unscanned" };
  }
}
