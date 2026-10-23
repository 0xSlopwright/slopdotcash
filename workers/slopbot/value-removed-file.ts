import { valueFileReader } from "./value-blob";
import type { EvidenceClient, FileChange } from "./value-evidence";
import { hasCompleteValuePatch } from "./value-patch";
import { readValueTree } from "./value-tree";

export function needsRemovedValueComparison(file: FileChange): boolean {
  return (
    file.status === "removed" &&
    file.previous_filename === undefined &&
    file.additions === 0 &&
    !hasCompleteValuePatch(file)
  );
}

/** A verified parent blob plus a complete accepted tree proves a text deletion.
 * Keep this proof separate from potentially omitted GitHub diff/count fields. */
export async function recoverRemovedValueComparisons(
  client: EvidenceClient,
  repository: string,
  files: FileChange[],
  baseSha: string,
  headSha: string,
): Promise<void> {
  const missing = files.filter(needsRemovedValueComparison);
  if (missing.length === 0) return;
  const before = await readValueTree(client, repository, baseSha);
  const after = await readValueTree(client, repository, headSha);
  if (!before || !after) return;
  const read = valueFileReader(client, repository);
  for (const file of missing) {
    const entry = before.get(file.filename);
    if (
      entry?.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode) ||
      after.has(file.filename)
    )
      continue;
    const blob = await read(file.filename, baseSha);
    if (!blob || blob.sha !== entry.sha) continue;
    try {
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(blob.bytes);
      if (text.includes("\0")) continue;
      file.removedComparison = {
        baseSha,
        headSha,
        before: { blobSha: blob.sha, text },
      };
    } catch {
      // Binary or invalid UTF-8 remains an explicit evidence gap.
    }
  }
}
