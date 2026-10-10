import { canonicalActorAvatarUrl } from "../src/lib/leaderboard";
/** Read only: no model calls, score publication or payment authority. */
import type {
  GitHubActor,
  LeaderboardInput,
  MergedPullRequestOutcome,
} from "../src/lib/leaderboard-types";
import { findRegisteredRepositoryById } from "../src/lib/repositories.mjs";
import type { GitHubClient } from "../workers/slopbot/github";
import { loadPolicy } from "../workers/slopbot/review";
import { readValueDecisionFromHistory } from "../workers/slopbot/value-consumption";
import { collectValueEvidence } from "../workers/slopbot/value-evidence";
import type { valueHistory } from "../workers/slopbot/value-journal";

const HISTORY_URL = "https://slopbot.slop.cash/v1/value-assessments";
type Page = Awaited<ReturnType<typeof valueHistory>>;
type Fetch = typeof fetch;

/** The fixed HTTPS origin, not a digest supplied by an arbitrary URL, is the
 * publication authority. Test callers can inject a transport, never a new URL.
 */
export async function fetchValueHistoryPage(
  repository: string,
  pull: number,
  after: number,
  transport: Fetch = fetch,
): Promise<Page> {
  const registered = findRegisteredRepositoryById(repository);
  if (
    !registered ||
    !Number.isSafeInteger(pull) ||
    pull < 1 ||
    !Number.isSafeInteger(after) ||
    after < 0
  )
    throw new Error("Invalid value-history source query");
  const url = new URL(HISTORY_URL);
  url.searchParams.set("repository", registered.id);
  url.searchParams.set("pull", String(pull));
  url.searchParams.set("after", String(after));
  const response = await transport(url, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200 || response.redirected || !response.body)
    throw new Error("Authoritative value history is unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > 8 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Value history response exceeds its page bound");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const body = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    body?.schemaVersion !== "slop-value-history:v1" ||
    body.repository !== registered.id ||
    body.pullRequestNumber !== pull ||
    !Array.isArray(body.records) ||
    body.records.length > 100 ||
    !(
      body.nextAfter === null ||
      (Number.isSafeInteger(body.nextAfter) && body.nextAfter > after)
    )
  )
    throw new Error("Value history page has invalid identity or pagination");
  return { records: body.records, nextAfter: body.nextAfter };
}

export async function loadValueInputs(
  github: Pick<GitHubClient, "get" | "graphql" | "fileText">,
  outcomes: readonly MergedPullRequestOutcome[],
  transport: Fetch = fetch,
) {
  const valueDecisions = new Map<
    string,
    NonNullable<LeaderboardInput["valueDecisions"]> extends ReadonlyMap<
      string,
      infer V
    >
      ? V
      : never
  >();
  const valueActors = new Map<string, GitHubActor>();
  const publicRepositories = new Map<string, { id: number; node_id: string }>();
  for (const outcome of outcomes) {
    const [owner, repo] = new URL(outcome.url).pathname
      .split("/")
      .filter(Boolean);
    const repository = findRegisteredRepositoryById(`${owner}/${repo}`);
    if (!repository)
      throw new Error("Value outcome repository is not registered");
    if (!publicRepositories.has(repository.id)) {
      const identity = await github.get<{
        id: number;
        node_id: string;
        private: boolean;
      }>(`/repos/${repository.owner}/${repository.name}`);
      if (
        identity?.private !== false ||
        (repository.expectedNodeId !== null &&
          identity.node_id !== repository.expectedNodeId)
      )
        throw new Error(
          "Value ingestion requires the registered public repository",
        );
      publicRepositories.set(repository.id, identity);
    }
    const first = await fetchValueHistoryPage(
      repository.id,
      outcome.number,
      0,
      transport,
    );
    if (first.records.length === 0 && first.nextAfter === null) {
      valueDecisions.set(outcome.id, {
        status: "missing",
        history: [],
        latestDigest: null,
        implementationActorNodeIds: [],
      });
      continue;
    }
    const evidence = await collectValueEvidence(
      github,
      repository.id,
      outcome.number,
    );
    if (
      evidence.repositoryNodeId !==
        publicRepositories.get(repository.id)?.node_id ||
      evidence.repositoryDatabaseId !==
        publicRepositories.get(repository.id)?.id ||
      evidence.pull.node_id !== outcome.id ||
      evidence.pull.head.sha !== outcome.headRefOid ||
      evidence.pull.merged_at !== outcome.mergedAt ||
      Date.parse(evidence.pull.updated_at) !== Date.parse(outcome.updatedAt)
    )
      throw new Error("Value source changed after the outcome census");
    const files = await loadPolicy(github, owner, repo, evidence.pull.base.sha);
    const policy = {
      sha: evidence.pull.base.sha,
      text: files.some((file) => file.truncated)
        ? ""
        : files.map((file) => `${file.path}\n${file.text}`).join("\n\n"),
    };
    const decision = await readValueDecisionFromHistory(
      (after) =>
        after === 0
          ? Promise.resolve(first)
          : fetchValueHistoryPage(
              repository.id,
              outcome.number,
              after,
              transport,
            ),
      evidence,
      policy,
    );
    valueDecisions.set(outcome.id, decision);
    if (decision.status !== "assessed") continue;
    const missing = decision.implementationActorNodeIds.filter(
      (id) => !valueActors.has(id),
    );
    for (let offset = 0; offset < missing.length; offset += 100) {
      const ids = missing.slice(offset, offset + 100);
      const result = await github.graphql<{
        nodes: ({
          __typename: string;
          id: string;
          login: string;
          avatarUrl: string;
          url: string;
        } | null)[];
      }>(
        "query($ids:[ID!]!){nodes(ids:$ids){__typename ... on User{id login avatarUrl url} ... on Bot{id login avatarUrl url}} rateLimit{cost limit remaining resetAt}}",
        { ids },
      );
      if (!Array.isArray(result.nodes) || result.nodes.length !== ids.length)
        throw new Error("Value coauthor identities are incomplete");
      for (const [index, actor] of result.nodes.entries()) {
        if (!actor || actor.id !== ids[index] || actor.__typename !== "User")
          throw new Error(
            "Value coauthor is not a resolved GitHub User identity",
          );
        valueActors.set(actor.id, {
          id: actor.id,
          login: actor.login,
          avatarUrl: canonicalActorAvatarUrl(actor.avatarUrl),
          url: actor.url,
          kind: "User",
        });
      }
    }
  }
  return { valueDecisions, valueActors };
}
