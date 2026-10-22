import { repositoryIdentity } from "../../backend/projects/enforcement";
import { assertProjectDefinition } from "../../src/lib/project-schema.mjs";
import type { Job } from "./contracts";
import type { D1Database } from "./persistence";

/** Read the live registry, not the release's generated snapshot. Installation
 * access alone does not authorize reviews. Database failures must propagate.
 */
export async function registeredRepository(
  db: D1Database,
  job: Pick<Job, "owner" | "repo" | "repositoryId">,
): Promise<boolean> {
  const key = `${job.owner}/${job.repo}`.toLowerCase();
  const row = await db
    .prepare(`SELECT p.manifest FROM project_repositories r
      JOIN projects p ON p.id = r.project_id
      WHERE r.repository_key = ? AND p.status = 'active'`)
    .bind(key)
    .first<{ manifest: string }>();
  if (row === null) return false;
  const project = assertProjectDefinition(JSON.parse(row.manifest));
  if (project.status !== "active" || project.listingTier === "retired")
    return false;
  const index = project.repositories.findIndex(
    (repository) =>
      new URL(repository.githubUrl).pathname
        .replace(/^\/|\/$/gu, "")
        .toLowerCase() === key,
  );
  // Old aliases are history, not permission to review a reused repository name.
  if (
    index < 0 ||
    (index === 0 && String(job.repositoryId) !== project.authority.repositoryId)
  )
    return false;
  const identity = repositoryIdentity(project);
  // An enforcement can be effective before its paused revision is appended.
  // Match the current restriction of every project sharing this identity.
  const restricted = await db
    .prepare(`SELECT 1 AS restricted FROM project_enforcements e
      WHERE NOT EXISTS (SELECT 1 FROM project_enforcements newer
        WHERE newer.project_id = e.project_id AND newer.sequence > e.sequence)
      AND e.state_after <> 'clear'
      AND (e.project_id = ? OR e.repository_github_id = ? OR EXISTS (
        SELECT 1 FROM json_each(e.repository_keys) old_key
        JOIN json_each(?) current_key ON old_key.value = current_key.value)) LIMIT 1`)
    .bind(project.id, identity.githubId, JSON.stringify(identity.keys))
    .first();
  return restricted === null;
}

export async function requireRegisteredRepository(db: D1Database, job: Job) {
  if (!(await registeredRepository(db, job)))
    throw new Error("Repository is not active in the Slop project registry");
}
