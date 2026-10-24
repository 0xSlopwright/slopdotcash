import type { D1Database } from "../d1";

/** Account decisions use immutable GitHub IDs, never a current project role. */
export async function hasParticipationBan(
  db: D1Database,
  githubId: string,
): Promise<boolean> {
  const found = await db
    .prepare(`
    SELECT 1 AS banned FROM project_maintainer_bans b
    JOIN project_enforcements e ON e.id = b.enforcement_id
    WHERE b.github_id = ? AND NOT EXISTS (
      SELECT 1 FROM project_enforcements later
      WHERE later.project_id = e.project_id AND later.sequence > e.sequence
        AND later.action = 'reinstate'
    ) LIMIT 1
  `)
    .bind(githubId)
    .first<{ banned: number }>();
  return found !== null;
}
