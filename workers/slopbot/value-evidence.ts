// Shared by the installation worker and the historical reviewer. Missing or
// moving evidence prevents assessment; pagination limits never imply coverage.
export interface EvidenceClient {
  get<T>(path: string): Promise<T | null>;
  graphql?<T>(query: string, variables: Record<string, unknown>): Promise<T>;
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
  closed_at: string | null;
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
interface CommitChangeEvidence {
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
/** The commit endpoint has a separate file pagination contract and cap. */
async function collectCommitChanges(
  client: EvidenceClient,
  root: string,
  sha: string,
  label: string,
) {
  let commit: CommitChangeEvidence | null = null;
  const limitations: string[] = [];
  for (let page = 1; ; page++) {
    const batch = await client.get<CommitChangeEvidence>(
      `${root}/commits/${sha}?per_page=100&page=${page}`,
    );
    if (!batch || batch.sha !== sha) {
      limitations.push(`${label} evidence is unavailable`);
      break;
    }
    if (commit === null) {
      commit = {
        sha: batch.sha,
        html_url: batch.html_url,
        parents: batch.parents.map(({ sha }) => ({ sha })),
        stats: { ...batch.stats },
        files: [],
      };
    }
    commit.files.push(...batch.files.map(fileChange));
    if (commit.files.length >= 3000) {
      limitations.push(`${label} file limit reached; Git evidence required`);
      break;
    }
    if (batch.files.length < 100) break;
  }
  if (commit !== null) {
    if (
      new Set(commit.files.map((file) => file.filename)).size !==
      commit.files.length
    )
      limitations.push(`${label} contains repeated file paths`);
    for (const kind of ["additions", "deletions"] as const)
      if (
        commit.files.reduce((sum, file) => sum + file[kind], 0) !==
        commit.stats[kind]
      )
        limitations.push(`Incomplete ${label.toLowerCase()} ${kind}`);
  }
  return { commit, limitations };
}
export interface CommitAttribution {
  sha: string;
  actorNodeIds: string[];
  changedPaths: string[] | null;
  limitations: string[];
}
interface RelatedPullRequest {
  id: string;
  number: number;
  url: string;
  repository: string;
}
async function relatedPullRequests(
  client: EvidenceClient,
  repository: string,
  number: number,
  pullId: string,
) {
  const references = new Map<string, RelatedPullRequest>();
  const limitations: string[] = [];
  if (!client.graphql)
    return {
      references: [],
      limitations: ["Related PR evidence is unavailable"],
    };
  const [owner, name] = repository.split("/");
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const result: {
      repository: {
        pullRequest: {
          id: string;
          timelineItems: {
            nodes: {
              source: {
                __typename: string;
                id?: string;
                number?: number;
                url?: string;
                repository?: { nameWithOwner: string; isPrivate: boolean };
              };
            }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      } | null;
    } = await client.graphql(
      `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){id timelineItems(first:100,after:$cursor,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{__typename ... on PullRequest{id number url repository{nameWithOwner isPrivate}}}}}pageInfo{hasNextPage endCursor}}}} rateLimit{cost limit remaining resetAt}}`,
      { owner, name, number, cursor },
    );
    const pull = result.repository?.pullRequest;
    if (!pull || pull.id !== pullId) {
      limitations.push("Related PR evidence is unavailable");
      break;
    }
    for (const { source } of pull.timelineItems.nodes) {
      if (source.__typename !== "PullRequest") continue;
      if (source.repository?.isPrivate !== false) {
        limitations.push("Related private PR evidence is withheld");
        continue;
      }
      if (
        !source.id ||
        typeof source.number !== "number" ||
        !Number.isSafeInteger(source.number) ||
        source.number <= 0 ||
        source.url !==
          `https://github.com/${source.repository.nameWithOwner}/pull/${source.number}`
      )
        throw new Error("Invalid related PR identity");
      references.set(source.id, {
        id: source.id,
        number: source.number,
        url: source.url,
        repository: source.repository.nameWithOwner,
      });
    }
    const page = pull.timelineItems.pageInfo;
    if (!page.hasNextPage) break;
    if (!page.endCursor || cursors.has(page.endCursor))
      throw new Error("Related PR pagination did not advance");
    cursors.add(page.endCursor);
    cursor = page.endCursor;
  }
  return {
    references: [...references.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    limitations: [...new Set(limitations)],
  };
}
export interface ValueEvidence {
  repository: string;
  repositoryNodeId: string;
  repositoryDatabaseId: number;
  collectedAt: string;
  pull: Pull;
  files: FileChange[];
  mergeCommitEvidence: CommitChangeEvidence | null;
  commits: Commit[];
  reviews: Review[];
  comments: Comment[];
  reviewComments: Comment[];
  limitations: string[];
  evidenceUrls: string[];
  eligibleReviewIds: string[];
  implementationActorNodeIds: string[];
  commitAttribution: CommitAttribution[];
  relatedPullRequests: RelatedPullRequest[];
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
    closed_at,
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
    closed_at,
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
  let mergeCommitEvidence: CommitChangeEvidence | null = null;
  if (pull.merged_at !== null) {
    if (!pull.merge_commit_sha) {
      limitations.push("Reported merge commit is unavailable");
    } else {
      // A PR diff can include work already brought in by another merge. Retain
      // both views; an empty accepted diff is not proof its author did no work.
      const accepted = await collectCommitChanges(
        client,
        root,
        pull.merge_commit_sha,
        "Reported merge commit",
      );
      mergeCommitEvidence = accepted.commit;
      limitations.push(...accepted.limitations);
      if (mergeCommitEvidence !== null) {
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
  const related = await relatedPullRequests(
    client,
    repository,
    number,
    pull.node_id,
  );
  limitations.push(...related.limitations);
  const evidenceUrls = [
    ...new Set([
      pull.html_url,
      ...related.references.map((reference) => reference.url),
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
  // Resolve co-authors from GitHub's commit identity mapping, never from a
  // display name or a guessed bot identity. Keep email addresses out of exports.
  const commitAttribution: CommitAttribution[] = [];
  for (const commit of commits.filter((entry) => entry.parents.length <= 1)) {
    const changes = await collectCommitChanges(
      client,
      root,
      commit.sha,
      `Commit ${commit.sha}`,
    );
    const attribution: CommitAttribution = {
      sha: commit.sha,
      actorNodeIds: commit.author ? [commit.author.node_id] : [],
      changedPaths:
        changes.commit !== null && changes.limitations.length === 0
          ? [
              ...new Set(
                changes.commit.files.flatMap((file) => [
                  file.filename,
                  ...(file.previous_filename ? [file.previous_filename] : []),
                ]),
              ),
            ].sort()
          : null,
      limitations: changes.limitations,
    };
    commitAttribution.push(attribution);
    if (commit.author === null)
      attribution.limitations.push(
        `Unresolved commit author identity: ${commit.sha}`,
      );
    const trailers = [
      ...commit.commit.message.matchAll(
        /^co-authored-by:\s*[^\r\n]*<([^<>\r\n]+)>\s*$/gimu,
      ),
    ];
    if (!/^co-authored-by:/imu.test(commit.commit.message)) continue;
    const trailerCount = [
      ...commit.commit.message.matchAll(/^co-authored-by:/gimu),
    ].length;
    if (!client.graphql || trailers.length !== trailerCount) {
      attribution.limitations.push(
        `Unresolved co-author identities: ${commit.sha}`,
      );
      continue;
    }
    const [owner, name] = repository.split("/");
    const result = await client.graphql<{
      repository: {
        object: {
          oid: string;
          authors: {
            nodes: { email: string; user: { id: string } | null }[];
            pageInfo: { hasNextPage: boolean };
          };
        } | null;
      } | null;
    }>(
      `query($owner:String!,$name:String!,$sha:String!){repository(owner:$owner,name:$name){object(expression:$sha){... on Commit{oid authors(first:100){nodes{email user{id}} pageInfo{hasNextPage}}}}} rateLimit{cost limit remaining resetAt}}`,
      { owner, name, sha: commit.sha },
    );
    const evidence = result.repository?.object;
    if (
      !evidence ||
      evidence.oid !== commit.sha ||
      evidence.authors.pageInfo.hasNextPage
    ) {
      attribution.limitations.push(
        `Incomplete co-author identity evidence: ${commit.sha}`,
      );
      continue;
    }
    for (const trailer of trailers) {
      const matches = evidence.authors.nodes.filter(
        (entry) =>
          entry.email.toLowerCase() === trailer[1].trim().toLowerCase(),
      );
      const ids = new Set(
        matches.flatMap((entry) => (entry.user ? [entry.user.id] : [])),
      );
      if (ids.size !== 1)
        attribution.limitations.push(
          `Unresolved co-author identity: ${commit.sha}`,
        );
      else
        for (const id of ids)
          if (!attribution.actorNodeIds.includes(id))
            attribution.actorNodeIds.push(id);
    }
  }
  const implementationActors = new Set([pull.user.node_id]);
  for (const attribution of commitAttribution) {
    attribution.actorNodeIds.sort();
    for (const id of attribution.actorNodeIds) implementationActors.add(id);
    limitations.push(...attribution.limitations);
  }
  const after = await client.get<Pull>(path);
  if (
    !after ||
    after.updated_at !== pull.updated_at ||
    after.head.sha !== pull.head.sha ||
    after.base.sha !== pull.base.sha ||
    after.state !== pull.state ||
    after.closed_at !== pull.closed_at ||
    after.merged_at !== pull.merged_at ||
    after.merge_commit_sha !== pull.merge_commit_sha
  )
    limitations.push("PR changed during evidence collection");
  const outcomeAt = pull.merged_at ?? pull.closed_at;
  const eligibleReviewIds = reviews
    .filter(
      (review) =>
        review.user !== null &&
        review.user.type !== "Bot" &&
        !implementationActors.has(review.user.node_id) &&
        review.submitted_at !== null &&
        review.state !== "PENDING" &&
        (outcomeAt === null ||
          Date.parse(review.submitted_at) < Date.parse(outcomeAt)),
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
    implementationActorNodeIds: [...implementationActors].sort(),
    commitAttribution,
    relatedPullRequests: related.references,
  };
}
