import { valueBlobReader } from "./value-blob";
import type { EvidenceClient, FileChange } from "./value-evidence";

/** GitHub omits patches for pure renames. Counts alone are insufficient: bind
 * both paths and refs to identical verified Git bytes before admitting one. */
export async function recoverUnchangedValueRenames(
  client: EvidenceClient,
  repository: string,
  files: FileChange[],
  baseSha: string,
  headSha: string,
): Promise<void> {
  const blob = valueBlobReader(client, repository);
  for (const file of files) {
    if (
      file.status !== "renamed" ||
      file.patch !== undefined ||
      file.additions !== 0 ||
      file.deletions !== 0 ||
      !file.previous_filename ||
      file.previous_filename === file.filename
    )
      continue;
    const before = await blob(file.previous_filename, baseSha);
    if (before === null || (await blob(file.filename, headSha)) !== before)
      continue;
    file.unchangedRename = { baseSha, headSha, blobSha: before };
    file.patch = "";
  }
}
