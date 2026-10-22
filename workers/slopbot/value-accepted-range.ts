import { valueBlobReader } from "./value-blob";
import type { EvidenceClient, FileChange } from "./value-evidence";
import { hasCompleteValuePatch } from "./value-patch";

export interface AcceptedValueRange {
  headSha: string;
  mergeSha: string;
  parentSha: string;
  files: { path: string; blobSha: string; alreadyPresent: boolean }[];
}

/** A stacked squash may omit dependency changes already in its parent. Prove
 * every submitted path survives unchanged, and every omitted change was already
 * present. Preserve both diffs: this proves acceptance, not separate credit.
 */
export async function collectAcceptedValueRange(
  client: EvidenceClient,
  repository: string,
  headSha: string,
  files: FileChange[],
  merge: { sha: string; parents: { sha: string }[]; files: FileChange[] },
): Promise<AcceptedValueRange | null> {
  if (
    merge.parents.length !== 1 ||
    ![headSha, merge.sha, merge.parents[0]?.sha].every((sha) =>
      /^[a-f0-9]{40}$/u.test(sha ?? ""),
    ) ||
    !files.length ||
    files.length > 16 ||
    !merge.files.length ||
    merge.files.length >= files.length ||
    new Set(files.map((file) => file.filename)).size !== files.length ||
    new Set(merge.files.map((file) => file.filename)).size !==
      merge.files.length ||
    files.some(
      (file) =>
        !["added", "modified"].includes(file.status) ||
        file.previous_filename !== undefined ||
        !hasCompleteValuePatch(file),
    )
  )
    return null;
  const changed = new Map(merge.files.map((file) => [file.filename, file]));
  for (const accepted of merge.files) {
    const submitted = files.find((file) => file.filename === accepted.filename);
    if (
      !submitted ||
      accepted.previous_filename !== undefined ||
      accepted.status !== submitted.status ||
      accepted.additions !== submitted.additions ||
      accepted.deletions !== submitted.deletions ||
      accepted.patch !== submitted.patch
    )
      return null;
  }
  const blob = valueBlobReader(client, repository);
  const proof: AcceptedValueRange = {
    headSha,
    mergeSha: merge.sha,
    parentSha: merge.parents[0].sha,
    files: [],
  };
  for (const file of [...files].sort((a, b) =>
    a.filename.localeCompare(b.filename),
  )) {
    const path = file.filename;
    if (
      !path ||
      path.length > 1024 ||
      path.includes("\\") ||
      [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      return null;
    const head = await blob(path, headSha);
    if (head === null || (await blob(path, merge.sha)) !== head) return null;
    const alreadyPresent = !changed.has(path);
    if (alreadyPresent && (await blob(path, proof.parentSha)) !== head)
      return null;
    proof.files.push({ path, blobSha: head, alreadyPresent });
  }
  return proof;
}
