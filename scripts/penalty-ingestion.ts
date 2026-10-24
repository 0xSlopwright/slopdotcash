/**
 * Reads the published-table debits that Slopbot recorded (PRD section 7)
 * and binds each unreversed debit to its live GitHub item and author. Read
 * only: this module records, reverses and decides no penalty.
 */
import { canonicalActorAvatarUrl } from "../src/lib/leaderboard";
import type { PenaltyDebitRecord } from "../src/lib/leaderboard-types";
import { findRegisteredRepositoryById } from "../src/lib/repositories.mjs";
import type { PenaltyRecord } from "../workers/slopbot/penalties";
import { ValueFeedUnavailableError } from "./value-ingestion";

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;
type Graphql = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** The same fixed publication authority as the value feed. */
const PENALTY_HISTORY_URL = "https://slopbot.slop.cash/v1/penalties";
const MAX_PAGES = 1000;
const NODE_BATCH = 50;
const CATEGORIES = new Set([
  "spam",
  "scam",
  "low_quality",
  "duplicate",
  "out_of_scope",
  "busywork",
  "gaming",
  "empty",
  "missing_evidence",
]);

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${what}`);
  return value as Record<string, unknown>;
}

function penaltyRecord(value: unknown): PenaltyRecord {
  const row = record(value, "penalty record");
  const timestamp = (field: unknown) =>
    typeof field === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u.test(field) &&
    Number.isFinite(Date.parse(field));
  if (
    typeof row.itemNodeId !== "string" ||
    !/^[A-Za-z0-9_=-]{1,128}$/u.test(row.itemNodeId) ||
    !Number.isSafeInteger(row.repositoryId) ||
    (row.repositoryId as number) < 1 ||
    typeof row.projectId !== "string" ||
    typeof row.authorGithubId !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(row.authorGithubId) ||
    typeof row.category !== "string" ||
    !CATEGORIES.has(row.category) ||
    typeof row.tableVersion !== "string" ||
    !Number.isSafeInteger(row.debitThirds) ||
    (row.debitThirds as number) < 1 ||
    typeof row.period !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/u.test(row.period) ||
    !timestamp(row.recordedAt) ||
    !(row.reversedAt === null || timestamp(row.reversedAt)) ||
    !(
      (row.reversedAt === null && row.reversal === null) ||
      (row.reversedAt !== null &&
        (row.reversal === "appeal_upheld" ||
          row.reversal === "maintainer_reopen"))
    )
  )
    throw new Error("Penalty history has an invalid record");
  return row as unknown as PenaltyRecord;
}

/**
 * Every recorded debit. A transport failure, a timeout or a retryable
 * status is a feed outage (owner decision D2): the release keeps the last
 * published snapshot. Any other failure stops the publication, because a
 * missing debit is not a zero debit.
 */
export async function fetchPenaltyHistory(
  transport: Fetch = fetch,
): Promise<PenaltyRecord[]> {
  const records: PenaltyRecord[] = [];
  let after = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(PENALTY_HISTORY_URL);
    url.searchParams.set("after", after);
    let response: Response;
    let text: string;
    try {
      response = await transport(url, {
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      )
        throw new ValueFeedUnavailableError(`HTTP ${response.status}`);
      text = await response.text();
    } catch (error) {
      if (error instanceof ValueFeedUnavailableError) throw error;
      throw new ValueFeedUnavailableError(error);
    }
    if (response.status !== 200 || text.length > 4 * 1024 * 1024)
      throw new Error("Authoritative penalty history is unavailable");
    const body = record(JSON.parse(text), "penalty history page");
    if (
      body.schemaVersion !== "slop-penalty-history:v1" ||
      body.after !== after ||
      !Array.isArray(body.records) ||
      body.records.length > 100 ||
      !(
        body.nextAfter === null ||
        (typeof body.nextAfter === "string" && body.nextAfter > after)
      )
    )
      throw new Error("Penalty history page has invalid pagination");
    for (const value of body.records) {
      const row = penaltyRecord(value);
      if (
        row.itemNodeId <= after ||
        records.at(-1)?.itemNodeId === row.itemNodeId
      )
        throw new Error("Penalty history is out of order");
      after = row.itemNodeId;
      records.push(row);
    }
    if (body.nextAfter === null) return records;
    if (body.nextAfter !== after)
      throw new Error("Penalty history cursor does not match its last record");
  }
  throw new Error("Penalty history exceeds its page bound");
}

const ITEM_FIELDS = `
  id number title url
  repository { databaseId nameWithOwner }
  author {
    __typename login avatarUrl url
    ... on User { id databaseId }
  }
`;

/**
 * Binds each unreversed debit to its live item. The item and its author
 * must still match the immutable repository and author IDs that Slopbot
 * recorded; anything else stops the publication. A deleted item has no
 * public source to cite, so its debit waits until a person reconciles it.
 */
export async function loadPenaltyDebits(
  graphql: Graphql,
  transport: Fetch = fetch,
  onSkipped: (itemNodeId: string) => void = () => undefined,
): Promise<PenaltyDebitRecord[]> {
  const active = (await fetchPenaltyHistory(transport)).filter(
    (row) => row.reversedAt === null,
  );
  const debits: PenaltyDebitRecord[] = [];
  for (let start = 0; start < active.length; start += NODE_BATCH) {
    const batch = active.slice(start, start + NODE_BATCH);
    const data = await graphql(
      `query PenaltyItems($ids: [ID!]!) {
        nodes(ids: $ids) {
          __typename
          ... on PullRequest { ${ITEM_FIELDS} }
          ... on Issue { ${ITEM_FIELDS} }
        }
      }`,
      { ids: batch.map((row) => row.itemNodeId) },
    );
    const nodes = data.nodes;
    if (!Array.isArray(nodes) || nodes.length !== batch.length)
      throw new Error("GitHub returned an incomplete penalty item batch");
    batch.forEach((row, index) => {
      const value = nodes[index];
      const node = value === null ? null : record(value, "penalty item");
      const repository = node && record(node.repository, "penalty repository");
      const registered = findRegisteredRepositoryById(
        String(repository?.nameWithOwner),
      );
      // A deleted item or account, or a project no longer registered, has
      // no public score to debit.
      if (!node || !repository || !registered || node.author === null) {
        onSkipped(row.itemNodeId);
        return;
      }
      const author = record(node.author, "penalty author");
      if (
        node.id !== row.itemNodeId ||
        (node.__typename !== "PullRequest" && node.__typename !== "Issue") ||
        !Number.isSafeInteger(node.number) ||
        typeof node.title !== "string" ||
        typeof node.url !== "string" ||
        repository.databaseId !== row.repositoryId ||
        !registered ||
        registered.projectId !== row.projectId ||
        author.__typename !== "User" ||
        String(author.databaseId) !== row.authorGithubId ||
        typeof author.id !== "string" ||
        typeof author.login !== "string" ||
        typeof author.avatarUrl !== "string" ||
        typeof author.url !== "string"
      )
        throw new Error(
          `Penalty ${row.itemNodeId} does not match its recorded item or author`,
        );
      debits.push({
        itemNodeId: row.itemNodeId,
        actor: {
          id: author.id,
          login: author.login,
          avatarUrl: canonicalActorAvatarUrl(author.avatarUrl),
          url: author.url,
          kind: "User",
        },
        repository: registered.id,
        item: {
          kind: node.__typename === "Issue" ? "issue" : "pull-request",
          number: node.number as number,
          title: node.title,
          url: node.url,
        },
        category: row.category,
        tableVersion: row.tableVersion,
        debitThirds: row.debitThirds,
        period: row.period,
        recordedAt: row.recordedAt,
      });
    });
  }
  return debits;
}
