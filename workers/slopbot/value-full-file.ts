import { valueFileReader } from "./value-blob";
import type { EvidenceClient, FileChange } from "./value-evidence";
import { hasCompleteValuePatch } from "./value-patch";

export function needsFullValueComparison(file: FileChange): boolean {
  if (file.status === "renamed")
    return (
      typeof file.previous_filename === "string" &&
      file.previous_filename !== file.filename &&
      !hasCompleteValuePatch(file)
    );
  return (
    file.status === "modified" &&
    file.previous_filename === undefined &&
    (!hasCompleteValuePatch(file) ||
      /(^|\/)package\.json$/u.test(file.filename))
  );
}

/** Preserve complete texts for missing patches and reordered package manifests.
 * This is explicit comparison evidence, not a manufactured unified diff. */
export async function recoverFullValueComparisons(
  client: EvidenceClient,
  repository: string,
  files: FileChange[],
  baseSha: string,
  headSha: string,
): Promise<void> {
  const read = valueFileReader(client, repository);
  for (const file of files) {
    if (!needsFullValueComparison(file)) continue;
    const before = await read(file.previous_filename ?? file.filename, baseSha);
    if (!before) continue;
    const after = await read(file.filename, headSha);
    if (!after) continue;
    // Leave identical renames to the existing unchanged-rename proof.
    if (file.status === "renamed" && before.sha === after.sha) continue;
    try {
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      });
      const beforeText = decoder.decode(before.bytes);
      const afterText = decoder.decode(after.bytes);
      if (beforeText.includes("\0") || afterText.includes("\0")) continue;
      file.fullComparison = {
        baseSha,
        headSha,
        before: { blobSha: before.sha, text: beforeText },
        after: { blobSha: after.sha, text: afterText },
      };
    } catch {
      // Invalid UTF-8 remains an explicit missing-diff limitation.
    }
  }
}
