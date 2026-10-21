/**
 * The exact D1 revision bytes behind each current project policy.
 *
 * `bun run projects:sync` snapshots GET /api/v1/project-revisions into
 * src/lib/project-revisions.generated.json and proves every digest. D1 stores
 * each revision as `JSON.stringify(manifest)`, so re-serializing the snapshot
 * entry gives the same bytes that GET /api/v1/project-revisions/<id>/<n>
 * serves as `manifestText`, and their SHA-256 is the revision's
 * `manifestSha256`.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertProjectDefinition } from "../src/lib/project-schema.mjs";

const REVISIONS_PATH = "src/lib/project-revisions.generated.json";

/** The newest revision of every project, sorted by project ID. */
export async function currentProjectPolicies(root) {
  const rows = JSON.parse(
    await readFile(resolve(root, REVISIONS_PATH), "utf8"),
  );
  if (!Array.isArray(rows))
    throw new TypeError("Project revision snapshot must be an array");
  // The snapshot lists each project's revisions in order; the last is current.
  const newest = new Map(rows.map((row) => [row.projectId, row]));
  return [...newest.values()]
    .sort((left, right) => left.projectId.localeCompare(right.projectId))
    .map((row) => {
      const bytes = Buffer.from(JSON.stringify(row.manifest), "utf8");
      if (
        createHash("sha256").update(bytes).digest("hex") !== row.manifestSha256
      )
        throw new TypeError(
          `Project ${row.projectId}@${row.revision} bytes do not match their D1 digest`,
        );
      const project = assertProjectDefinition(JSON.parse(bytes.toString()));
      if (project.id !== row.projectId)
        throw new TypeError(
          `Project ${row.projectId} revision names another ID`,
        );
      return {
        project,
        revision: row.revision,
        manifestSha256: row.manifestSha256,
        bytes,
      };
    });
}

/** The newest D1 revision of one project; unknown projects fail closed. */
export async function currentProjectPolicy(root, projectId) {
  const policy = (await currentProjectPolicies(root)).find(
    (entry) => entry.project.id === projectId,
  );
  if (!policy)
    throw new Error(
      `Project ${projectId} has no revision in the synced D1 registry; run bun run projects:sync`,
    );
  return policy;
}
