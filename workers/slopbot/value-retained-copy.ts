/** Private GitHub evidence for copied contributions. A closure comment is a
 * discovery hint, never sufficient evidence for assigning implementation credit.
 */
import type { FileChange } from "./value-evidence";
import { hasCompleteValuePatch } from "./value-patch";
import type { WorkUnitSource } from "./value-work-unit";

export function retainedCopySources(
  original: WorkUnitSource,
  sources: readonly WorkUnitSource[],
): WorkUnitSource[] {
  const evidence = original.evidence;
  if (evidence.pull.merged_at !== null || evidence.indirectAcceptance)
    return [];
  return sources.filter(({ evidence: integration }) => {
    const accepted = integration.pull;
    if (
      integration.repositoryNodeId !== evidence.repositoryNodeId ||
      accepted.node_id === evidence.pull.node_id ||
      !accepted.merged_at ||
      !accepted.merge_commit_sha ||
      !accepted.merged_by ||
      accepted.merged_by.type === "Bot" ||
      !evidence.files.some((file) =>
        integration.files.some(
          (retained) => retained.filename === file.filename,
        ),
      )
    )
      return false;
    return evidence.comments.some(
      (comment) =>
        comment.user?.node_id === accepted.merged_by?.node_id &&
        Date.parse(comment.created_at) >=
          Date.parse(accepted.merged_at as string) &&
        /\b(?:merged?|integrat(?:ed|ion))\b/iu.test(comment.body) &&
        [...comment.body.matchAll(/\b[a-f0-9]{40}\b/gu)].some(
          ([sha]) => sha === accepted.merge_commit_sha,
        ),
    );
  });
}

/** Keep the complete ordered changed lines, including whitespace. Context and
 * hunk offsets may change when other accepted fixes precede a copied commit.
 * This identifies exact retained edits for review, not their semantic value.
 */
export function retainedEditIdentity(file: FileChange): string | null {
  if (
    !hasCompleteValuePatch(file) ||
    file.previous_filename !== undefined ||
    !["added", "modified", "removed"].includes(file.status) ||
    file.additions + file.deletions === 0
  )
    return null;
  return JSON.stringify([
    file.filename,
    file.status,
    file.patch?.split("\n").filter((line) => /^[+-]/u.test(line)),
  ]);
}

function changedHunks(file: FileChange): string[] | null {
  if (retainedEditIdentity(file) === null) return null;
  const hunks = (file.patch ?? "")
    .split(/^@@.*@@.*$/mu)
    .map((hunk) => hunk.split("\n").filter((line) => /^[+-]/u.test(line)))
    .filter((lines) => lines.length > 0)
    .map((lines) => JSON.stringify(lines));
  return new Set(hunks).size === hunks.length ? hunks : null;
}

function isAncestor(
  source: WorkUnitSource,
  before: string,
  after: string,
): boolean {
  const commits = new Map(
    source.evidence.commits.map((commit) => [commit.sha, commit]),
  );
  const pending = [after];
  const seen = new Set<string>();
  while (pending.length) {
    const sha = pending.pop();
    if (!sha || seen.has(sha)) continue;
    if (sha === before) return true;
    seen.add(sha);
    for (const parent of commits.get(sha)?.parents ?? [])
      pending.push(parent.sha);
  }
  return false;
}

/** A rebase may omit a hunk already introduced by another accepted fix.
 * Require that exact hunk in an independently captured ancestor commit. This
 * does not match arbitrary subsets, whitespace rewrites or model assertions.
 */
function preexistingHunks(
  original: FileChange,
  copied: FileChange,
  integration: WorkUnitSource,
  acceptedSha: string,
): string[] | null {
  if (
    original.filename !== copied.filename ||
    original.status !== copied.status
  )
    return null;
  const before = changedHunks(original);
  const after = changedHunks(copied);
  if (
    !before ||
    !after?.length ||
    after.length >= before.length ||
    after.some((hunk) => !before.includes(hunk))
  )
    return null;
  const retainedOrder = before.filter((hunk) => after.includes(hunk));
  if (JSON.stringify(retainedOrder) !== JSON.stringify(after)) return null;
  const prior = new Set<string>();
  for (const missing of before.filter((hunk) => !after.includes(hunk))) {
    const matches = integration.evidence.commitAttribution.filter(
      (candidate) =>
        candidate.sha !== acceptedSha &&
        candidate.limitations.length === 0 &&
        isAncestor(integration, candidate.sha, acceptedSha) &&
        candidate.files?.some(
          (file) =>
            file.filename === original.filename &&
            changedHunks(file)?.includes(missing),
        ),
    );
    if (matches.length !== 1) return null;
    prior.add(matches[0].sha);
  }
  return [...prior].sort();
}

export function retainedCopyBindings(sources: readonly WorkUnitSource[]) {
  const bindings = new Map<
    string,
    {
      original: WorkUnitSource;
      originalCommitSha: string;
      integration: WorkUnitSource;
      acceptedCommitSha: string;
      path: string;
      preexistingCommitShas: string[];
    }
  >();
  const limitations = new Set<string>();
  for (const original of sources) {
    const integrations = retainedCopySources(original, sources);
    const evidence = original.evidence;
    // An exact edit match plus a GitHub PR relationship is an ownership
    // ambiguity even if the acknowledgement is missing, removed, or forged.
    // It must not fall back to an integration-only award.
    if (evidence.pull.merged_at === null && !evidence.indirectAcceptance) {
      const edits = new Set(
        evidence.commitAttribution.flatMap((commit) =>
          (commit.files ?? [])
            .map(retainedEditIdentity)
            .filter((edit) => edit !== null),
        ),
      );
      for (const candidate of sources) {
        const other = candidate.evidence;
        if (
          integrations.includes(candidate) ||
          !other.pull.merged_at ||
          other.repositoryNodeId !== evidence.repositoryNodeId ||
          !(
            other.relatedPullRequests.some(
              (ref) => ref.id === evidence.pull.node_id,
            ) ||
            evidence.relatedPullRequests.some(
              (ref) => ref.id === other.pull.node_id,
            )
          )
        )
          continue;
        if (
          other.commitAttribution.some((commit) =>
            (commit.files ?? []).some((file) => {
              const edit = retainedEditIdentity(file);
              if (edit === null || !edits.has(edit)) return false;
              // The same accepted commit can be carried by an intermediate
              // PR and the acknowledged final integration. It is one copy,
              // not another original requiring a separate acknowledgement.
              return !integrations.some(({ evidence: accepted }) =>
                accepted.commitAttribution.some(
                  (retained) =>
                    retained.sha === commit.sha &&
                    retained.limitations.length === 0 &&
                    retained.files?.some(
                      (retainedFile) =>
                        retainedEditIdentity(retainedFile) === edit,
                    ),
                ),
              );
            }),
          )
        )
          limitations.add(
            `${evidence.pull.node_id}: matching copied edits require authenticated retention acknowledgement`,
          );
      }
    }
    if (!integrations.length) continue;
    for (const commit of evidence.commits) {
      const attribution = evidence.commitAttribution.find(
        (a) => a.sha === commit.sha,
      );
      if (
        commit.parents.length > 1 ||
        !attribution?.files ||
        attribution.limitations.length ||
        attribution.changedPaths === null ||
        attribution.files.length !== attribution.changedPaths.length ||
        !attribution.files.every((file) =>
          attribution.changedPaths?.includes(file.filename),
        )
      ) {
        limitations.add(
          `${evidence.pull.node_id}: retained commit ${commit.sha} lacks complete file evidence`,
        );
        continue;
      }
      for (const file of attribution.files) {
        const identity = retainedEditIdentity(file);
        const matches = integrations.flatMap((integration) =>
          integration.evidence.commitAttribution.flatMap((accepted) => {
            const known = integration.evidence.commits.find(
              (c) => c.sha === accepted.sha,
            );
            if (
              !known ||
              known.parents.length > 1 ||
              accepted.limitations.length
            )
              return [];
            return (accepted.files ?? []).flatMap((candidate) => {
              if (identity === null) return [];
              const prior =
                retainedEditIdentity(candidate) === identity
                  ? []
                  : preexistingHunks(
                      file,
                      candidate,
                      integration,
                      accepted.sha,
                    );
              return prior === null
                ? []
                : [
                    {
                      original,
                      originalCommitSha: commit.sha,
                      integration,
                      acceptedCommitSha: accepted.sha,
                      path: file.filename,
                      preexistingCommitShas: prior,
                    },
                  ];
            });
          }),
        );
        if (matches.length !== 1) {
          limitations.add(
            `${evidence.pull.node_id}: retained ${commit.sha}:${file.filename} has ${matches.length} exact copy bindings`,
          );
          continue;
        }
        const match = matches[0];
        if (!match) continue;
        const key = JSON.stringify([
          evidence.repositoryNodeId,
          match.acceptedCommitSha,
          file.filename,
        ]);
        if (bindings.has(key)) {
          limitations.add(
            `${evidence.pull.node_id}: retained copy has competing original sources`,
          );
          continue;
        }
        bindings.set(key, match);
      }
    }
  }
  return { bindings, limitations: [...limitations].sort() };
}
