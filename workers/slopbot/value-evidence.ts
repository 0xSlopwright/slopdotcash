// Shared by the installation worker and the historical reviewer. Missing or
// moving evidence prevents assessment; pagination limits never imply coverage.
export interface EvidenceClient {
  get<T>(path: string): Promise<T | null>;
}
interface Actor {
  node_id: string;
  login: string;
  type: string;
}
interface Pull {
  node_id: string;
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  user: Actor;
  merged_by: Actor | null;
  state: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  updated_at: string;
  head: { sha: string };
  base: { sha: string; ref: string };
  changed_files: number;
  comments: number;
  review_comments: number;
  commits: number;
}
interface Review {
  node_id: string;
  id: number;
  html_url: string;
  body: string;
  user: Actor | null;
  submitted_at: string | null;
  state: string;
  commit_id: string;
}
interface Comment {
  node_id: string;
  html_url: string;
  body: string;
  user: Actor | null;
  created_at: string;
  updated_at: string;
  pull_request_review_id?: number;
}
interface FileChange {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  blob_url: string;
}
interface Commit {
  sha: string;
  html_url: string;
  author: Actor | null;
  committer: Actor | null;
  parents: { sha: string }[];
  commit: {
    message: string;
    author: { date: string };
    committer: { date: string };
  };
}
interface MergeCommitEvidence {
  sha: string;
  html_url: string;
  parents: { sha: string }[];
  stats: { additions: number; deletions: number; total: number };
  files: FileChange[];
}
function fileChange({
  filename,
  previous_filename,
  status,
  additions,
  deletions,
  patch,
  blob_url,
}: FileChange): FileChange {
  return {
    filename,
    ...(previous_filename === undefined ? {} : { previous_filename }),
    status,
    additions,
    deletions,
    ...(patch === undefined ? {} : { patch }),
    blob_url,
  };
}
function changeBytes(files: FileChange[]): string {
  return JSON.stringify(
    [...files]
      .sort((left, right) => left.filename.localeCompare(right.filename))
      .map((file) => [
        file.filename,
        file.previous_filename ?? null,
        file.status,
        file.additions,
        file.deletions,
        file.patch ?? null,
      ]),
  );
}
function actor({ node_id, login, type }: Actor): Actor {
  return { node_id, login, type };
}
function comment({
  node_id,
  html_url,
  body,
  user,
  created_at,
  updated_at,
  pull_request_review_id,
}: Comment): Comment {
  return {
    node_id,
    html_url,
    body,
    user: user === null ? null : actor(user),
    created_at,
    updated_at,
    ...(pull_request_review_id === undefined ? {} : { pull_request_review_id }),
  };
}
export interface ValueEvidence {
  repository: string;
  repositoryNodeId: string;
  repositoryDatabaseId: number;
  collectedAt: string;
  pull: Pull;
  files: FileChange[];
  mergeCommitEvidence: MergeCommitEvidence | null;
  commits: Commit[];
  reviews: Review[];
  comments: Comment[];
  reviewComments: Comment[];
  limitations: string[];
  evidenceUrls: string[];
  eligibleReviewIds: string[];
}
async function pages<T>(client: EvidenceClient, path: string): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await client.get<T[]>(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`Evidence unavailable: ${path}`);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
}
export async function collectValueEvidence(
  client: EvidenceClient,
  repository: string,
  number: number,
): Promise<ValueEvidence> {
  if (
    !/^[\w.-]+\/[\w.-]+$/u.test(repository) ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    throw new Error("Invalid PR identity");
  const root = `/repos/${repository}`;
  const repositoryIdentity = await client.get<{ id: number; node_id: string }>(
    root,
  );
  if (!repositoryIdentity) throw new Error("Repository identity unavailable");
  const path = `${root}/pulls/${number}`;
  const rawPull = await client.get<Pull>(path);
  if (!rawPull) throw new Error("Pull request unavailable");
  const {
    node_id,
    number: prNumber,
    html_url,
    title,
    body,
    user,
    merged_by,
    state,
    merged_at,
    merge_commit_sha,
    updated_at,
    head,
    base,
    changed_files,
    comments: commentCount,
    review_comments,
    commits: commitCount,
  } = rawPull;
  const pull: Pull = {
    node_id,
    number: prNumber,
    html_url,
    title,
    body,
    user: actor(user),
    merged_by: merged_by === null ? null : actor(merged_by),
    state,
    merged_at,
    merge_commit_sha,
    updated_at,
    head: { sha: head.sha },
    base: { sha: base.sha, ref: base.ref },
    changed_files,
    comments: commentCount,
    review_comments,
    commits: commitCount,
  };
  const [rawFiles, rawCommits, rawReviews, rawComments, rawReviewComments] =
    await Promise.all([
      pages<FileChange>(client, `${path}/files`),
      pages<Commit>(client, `${path}/commits`),
      pages<Review>(client, `${path}/reviews`),
      pages<Comment>(client, `${root}/issues/${number}/comments`),
      pages<Comment>(client, `${path}/comments`),
    ]);
  const files = rawFiles.map(fileChange);
  const commits = rawCommits.map(
    ({ sha, html_url, commit, author, committer, parents }) => ({
      sha,
      html_url,
      author: author === null ? null : actor(author),
      committer: committer === null ? null : actor(committer),
      parents: parents.map(({ sha }) => ({ sha })),
      commit: {
        message: commit.message,
        author: { date: commit.author.date },
        committer: { date: commit.committer.date },
      },
    }),
  );
  const reviews = rawReviews.map(
    ({
      node_id,
      id,
      html_url,
      body,
      user,
      submitted_at,
      state,
      commit_id,
    }) => ({
      node_id,
      id,
      html_url,
      body,
      user: user === null ? null : actor(user),
      submitted_at,
      state,
      commit_id,
    }),
  );
  const comments = rawComments.map(comment);
  const reviewComments = rawReviewComments.map(comment);
  const limitations: string[] = [];
  let mergeCommitEvidence: MergeCommitEvidence | null = null;
  if (pull.merged_at !== null) {
    if (!pull.merge_commit_sha) {
      limitations.push("Reported merge commit is unavailable");
    } else {
      // A PR diff can include work already brought in by another merge. Retain
      // both views; an empty accepted diff is not proof its author did no work.
      for (let page = 1; ; page++) {
        const commit: MergeCommitEvidence | null =
          await client.get<MergeCommitEvidence>(
            `${root}/commits/${pull.merge_commit_sha}?per_page=100&page=${page}`,
          );
        if (!commit || commit.sha !== pull.merge_commit_sha) {
          limitations.push("Reported merge commit evidence is unavailable");
          break;
        }
        if (mergeCommitEvidence === null) {
          mergeCommitEvidence = {
            sha: commit.sha,
            html_url: commit.html_url,
            parents: commit.parents.map(({ sha }) => ({ sha })),
            stats: { ...commit.stats },
            files: [],
          };
        }
        mergeCommitEvidence.files.push(...commit.files.map(fileChange));
        // GitHub caps this endpoint at 3,000 files. A cap is not completeness,
        // including when omitted files have no textual additions/deletions.
        if (mergeCommitEvidence.files.length >= 3000) {
          limitations.push(
            "Reported merge commit file limit reached; Git evidence required",
          );
          break;
        }
        if (commit.files.length < 100) break;
      }
      if (mergeCommitEvidence !== null) {
        for (const kind of ["additions", "deletions"] as const) {
          if (
            mergeCommitEvidence.files.reduce(
              (sum, file) => sum + file[kind],
              0,
            ) !== mergeCommitEvidence.stats[kind]
          )
            limitations.push(`Incomplete reported merge commit ${kind}`);
        }
        const directMerge =
          mergeCommitEvidence.parents.length === 2 &&
          mergeCommitEvidence.parents[1]?.sha === pull.head.sha;
        // A squash is usable when its entire diff matches the submitted diff.
        // Never assume that the final commit of a rebase contains the whole PR.
        const matchingSingleParent =
          mergeCommitEvidence.parents.length === 1 &&
          files.length > 0 &&
          changeBytes(files) === changeBytes(mergeCommitEvidence.files);
        if (!directMerge && !matchingSingleParent) {
          limitations.push(
            "Reported merge neither directly integrates this head nor matches its entire diff; reconcile the accepted range and related PRs",
          );
        }
      }
    }
  }
  const after = await client.get<Pull>(path);
  if (
    !after ||
    after.updated_at !== pull.updated_at ||
    after.head.sha !== pull.head.sha ||
    after.base.sha !== pull.base.sha ||
    after.merged_at !== pull.merged_at ||
    after.merge_commit_sha !== pull.merge_commit_sha
  )
    limitations.push("PR changed during evidence collection");
  for (const [name, actual, expected] of [
    ["files", files.length, pull.changed_files],
    ["commits", commits.length, pull.commits],
    ["comments", comments.length, pull.comments],
    ["review comments", reviewComments.length, pull.review_comments],
  ] as const)
    if (actual !== expected)
      limitations.push(`Incomplete ${name}: ${actual}/${expected}`);
  // GitHub omits binary and oversized patches. Do not let absent or truncated
  // content turn into a confident low-value recommendation.
  for (const file of [...files, ...(mergeCommitEvidence?.files ?? [])]) {
    const lines = file.patch?.split("\n") ?? [];
    const added = lines.filter((line) => line.startsWith("+")).length;
    const removed = lines.filter((line) => line.startsWith("-")).length;
    if (
      file.patch === undefined ||
      added !== file.additions ||
      removed !== file.deletions
    )
      limitations.push(`Full diff required: ${file.filename}`);
  }
  const evidenceUrls = [
    ...new Set([
      pull.html_url,
      ...files.map((file) => file.blob_url),
      ...(mergeCommitEvidence === null
        ? []
        : [
            mergeCommitEvidence.html_url,
            ...mergeCommitEvidence.files.map((file) => file.blob_url),
          ]),
      ...commits.map((commit) => commit.html_url),
      ...reviews.map((review) => review.html_url),
      ...comments.map((comment) => comment.html_url),
      ...reviewComments.map((comment) => comment.html_url),
    ]),
  ];
  const eligibleReviewIds = reviews
    .filter(
      (review) =>
        review.user !== null &&
        review.user.type !== "Bot" &&
        review.user.node_id !== pull.user.node_id &&
        review.submitted_at !== null &&
        review.state !== "PENDING" &&
        (pull.merged_at === null ||
          Date.parse(review.submitted_at) < Date.parse(pull.merged_at)),
    )
    .map((review) => review.node_id);
  return {
    repository,
    repositoryNodeId: repositoryIdentity.node_id,
    repositoryDatabaseId: repositoryIdentity.id,
    collectedAt: new Date().toISOString(),
    pull,
    files,
    mergeCommitEvidence,
    commits,
    reviews,
    comments,
    reviewComments,
    limitations,
    evidenceUrls,
    eligibleReviewIds,
  };
}
