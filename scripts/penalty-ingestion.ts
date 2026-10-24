/**
 * Reads the published-table debits that Slopbot recorded (PRD section 7)
 * and binds each unreversed debit to its live GitHub item and author. Read
 * only: this module records, reverses and decides no penalty.
 */
import { canonicalActorAvatarUrl } from "../src/lib/leaderboard";
import type { PenaltyDebitRecord } from "../src/lib/leaderboard-types";
import { findRegisteredRepository } from "../src/lib/repositories.mjs";
import type { PenaltyRecord } from "../workers/slopbot/penalties";
import { ValueFeedUnavailableError } from "./value-ingestion";

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;

/** The same fixed publication authority as the value feed. */
const PENALTY_HISTORY_URL = "https://slopbot.slop.cash/v1/penalties";
const MAX_PAGES = 1000;
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
    (row.itemKind !== "issue" && row.itemKind !== "pull_request") ||
    !Number.isSafeInteger(row.itemNumber) ||
    (row.itemNumber as number) < 1 ||
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
      // A release generates the leaderboard before it deploys Slopbot, so
      // the first release with this reader finds no route yet (404). That
      // run keeps the last published snapshot; the next run reads the route.
      if (
        response.status === 404 ||
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

type GitHubItem = {
  node_id: string;
  number: number;
  title: string;
  html_url: string;
  pull_request?: unknown;
  user: {
    id: number;
    node_id: string;
    login: string;
    avatar_url: string;
    html_url: string;
    type: string;
  } | null;
};

/**
 * Binds each unreversed debit to its live item through GitHub REST, by the
 * immutable repository ID and the item number that Slopbot recorded. The
 * item and its author must still match the recorded node and author IDs;
 * anything else stops the publication. A deleted item or account, or a
 * repository that is no longer registered, has no public score to debit.
 */
export async function loadPenaltyDebits(
  github: { get<T>(path: string): Promise<T | null> },
  transport: Fetch = fetch,
  onSkipped: (itemNodeId: string) => void = () => undefined,
): Promise<PenaltyDebitRecord[]> {
  const active = (await fetchPenaltyHistory(transport)).filter(
    (row) => row.reversedAt === null,
  );
  const debits: PenaltyDebitRecord[] = [];
  for (const row of active) {
    const item = await github.get<GitHubItem>(
      `/repositories/${row.repositoryId}/issues/${row.itemNumber}`,
    );
    const path =
      item &&
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9][0-9]*)$/u.exec(
        item.html_url,
      );
    const registered = path && findRegisteredRepository(path[1], path[2]);
    if (!item || !registered || !item.user || item.user.login === "ghost") {
      onSkipped(row.itemNodeId);
      continue;
    }
    const user = item.user;
    if (
      item.node_id !== row.itemNodeId ||
      item.number !== row.itemNumber ||
      (row.itemKind === "pull_request") !== (item.pull_request !== undefined) ||
      path?.[3] !== (row.itemKind === "pull_request" ? "pull" : "issues") ||
      typeof item.title !== "string" ||
      registered.projectId !== row.projectId ||
      user.type !== "User" ||
      String(user.id) !== row.authorGithubId ||
      typeof user.node_id !== "string" ||
      typeof user.login !== "string"
    )
      throw new Error(
        `Penalty ${row.itemNodeId} does not match its recorded item or author`,
      );
    debits.push({
      itemNodeId: row.itemNodeId,
      actor: {
        id: user.node_id,
        login: user.login,
        avatarUrl: canonicalActorAvatarUrl(user.avatar_url),
        url: user.html_url,
        kind: "User",
      },
      repository: registered.id,
      item: {
        kind: row.itemKind === "pull_request" ? "pull-request" : "issue",
        number: item.number,
        title: item.title,
        url: `https://github.com/${registered.id}/${path[3]}/${item.number}`,
      },
      category: row.category,
      tableVersion: row.tableVersion,
      debitThirds: row.debitThirds,
      period: row.period,
      recordedAt: row.recordedAt,
    });
  }
  return debits;
}
