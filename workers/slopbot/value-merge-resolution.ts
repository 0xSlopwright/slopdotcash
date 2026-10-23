/** Local Git reconstruction, bound to the collected immutable merge parents.
 * This is scope evidence, never a finding that a resolution deserves credit.
 */
import type { ValueEvidence } from "./value-evidence";

export interface ValueMergeResolution {
  commitSha: string;
  parents: [string, string];
  gitVersion: string;
  automaticTree: string;
  resolvedTree: string;
  hadConflicts: boolean;
  patch: string;
  patchSha256: string;
  paths: string[];
}

export function mergeResolutionMatches(
  resolution: ValueMergeResolution,
  commit: ValueEvidence["commits"][number],
): boolean {
  const sha = /^[a-f0-9]{40}$/u;
  return (
    commit.parents.length === 2 &&
    resolution.commitSha === commit.sha &&
    resolution.parents.length === 2 &&
    resolution.parents.every(
      (parent, index) => parent === commit.parents[index].sha,
    ) &&
    sha.test(resolution.automaticTree) &&
    sha.test(resolution.resolvedTree) &&
    resolution.gitVersion.startsWith("git version ") &&
    typeof resolution.hadConflicts === "boolean" &&
    /^[a-f0-9]{64}$/u.test(resolution.patchSha256) &&
    new Set(resolution.paths).size === resolution.paths.length &&
    resolution.paths.every((path) => path.length > 0 && !path.includes("\0")) &&
    (resolution.paths.length === 0) === (resolution.patch.length === 0) &&
    (resolution.paths.length === 0) ===
      (resolution.automaticTree === resolution.resolvedTree)
  );
}
