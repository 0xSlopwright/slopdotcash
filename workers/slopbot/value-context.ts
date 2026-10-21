import type { EvidenceClient, ValueEvidence } from "./value-evidence";

/** Selected unchanged files let reviewers check claims outside the PR diff.
 * Bind complete bytes to the same immutable head; never infer missing context.
 */
export async function collectValueContext(
  client: EvidenceClient,
  evidence: ValueEvidence,
  paths: readonly string[],
): Promise<ValueEvidence> {
  const selected = [...new Set(paths)].sort();
  if (
    selected.length > 16 ||
    selected.some(
      (path) =>
        !path ||
        path.length > 1024 ||
        path.includes("\\") ||
        [...path].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        path.split("/").some((part) => !part || part === "." || part === ".."),
    ) ||
    !/^[a-f0-9]{40}$/u.test(evidence.pull.head.sha)
  )
    throw new Error("Invalid immutable context selection");
  if (!selected.length) return evidence;
  const contextFiles = [];
  let total = 0;
  for (const path of selected) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const ref = evidence.pull.head.sha;
    const file = await client.get<{
      type: string;
      size: number;
      sha: string;
      encoding: string;
      content?: string;
    }>(`/repos/${evidence.repository}/contents/${encoded}?ref=${ref}`);
    if (
      file?.type !== "file" ||
      file.encoding !== "base64" ||
      typeof file.content !== "string" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 512 * 1024 ||
      !/^[a-f0-9]{40}$/u.test(file.sha)
    )
      throw new Error(`Complete context file unavailable: ${path}`);
    const bytes = Uint8Array.from(
      atob(file.content.replace(/\s+/gu, "")),
      (character) => character.charCodeAt(0),
    );
    total += bytes.length;
    if (bytes.length !== file.size || total > 2 * 1024 * 1024)
      throw new Error("Context file size is incomplete or exceeds the limit");
    contextFiles.push({
      path,
      ref,
      blobSha: file.sha,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      url: `https://github.com/${evidence.repository}/blob/${ref}/${encoded}`,
    });
  }
  return {
    ...evidence,
    contextFiles,
    evidenceUrls: [
      ...new Set([
        ...evidence.evidenceUrls,
        ...contextFiles.map((file) => file.url),
      ]),
    ],
  };
}
