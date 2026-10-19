/**
 * Server-side GitHub reads for the project setup form. The browser calls the
 * same-origin API with its site session; this module reads public GitHub
 * facts with an optional server token, and the API caches the result briefly.
 * A failed or partial lookup never fills a fact.
 */

import { readBoundedJson } from "../../src/lib/browser-json";
import { sha256Hex } from "../../src/lib/sha256";

export interface OwnedRepository {
  repository: string;
  /** The repository's own GitHub description, or null when it has none. */
  description: string | null;
}

export interface RepositoryLookup {
  repository: string;
  description: string | null;
  numericId: string;
  nodeId: string;
  defaultBranch: string;
  owner: {
    login: string;
    actorId: string;
    nodeId: string;
    kind: "individual" | "organization";
  };
  license:
    | { state: "verified"; spdx: string; commitSha: string; fileSha256: string }
    | { state: "unknown"; reason: string };
}

export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

export class GithubLookupError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const GITHUB_API = "https://api.github.com";
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_PATH = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAX_OWNED_REPOSITORY_PAGES = 20;
const REQUEST_TIMEOUT_MS = 10_000;

export function validRepositoryPath(value: string): boolean {
  return value.length <= 201 && REPOSITORY_PATH.test(value);
}

export function validGithubLogin(value: string): boolean {
  return LOGIN.test(value);
}

function requestInit(token: string | undefined): RequestInit {
  return {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "slop.cash-project-setup",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
}

function limited(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0")
  );
}

async function githubJson(
  fetcher: GithubFetch,
  token: string | undefined,
  path: string,
): Promise<Record<string, unknown> | null> {
  const response = await fetcher(`${GITHUB_API}${path}`, requestInit(token));
  if (response.status === 404) return null;
  if (limited(response))
    throw new GithubLookupError(
      503,
      "github_rate_limited",
      "GitHub limited lookups. Try again later or enter the facts by hand.",
    );
  if (!response.ok)
    throw new GithubLookupError(
      502,
      "github_unavailable",
      `GitHub returned ${response.status}.`,
    );
  const value = await readBoundedJson(response, 512 * 1024, "GitHub lookup");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GithubLookupError(
      502,
      "github_unavailable",
      "GitHub returned an unexpected response.",
    );
  return value as Record<string, unknown>;
}

function repositoryDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > 0 && text.length <= 600 ? text : null;
}

function nextOwnedRepositoryPage(
  response: Response,
  currentPage: number,
): number | null {
  const link = response.headers.get("link");
  if (link === null) return null;
  const next = link
    .split(",")
    .find((part) => /;\s*rel="next"(?:\s*;|\s*$)/u.test(part));
  if (next === undefined) return null;
  const target = /^\s*<([^<>]+)>/u.exec(next)?.[1];
  if (target === undefined)
    throw new GithubLookupError(
      502,
      "github_unavailable",
      "GitHub returned an invalid repository page link.",
    );
  const url = new URL(target);
  const page = Number(url.searchParams.get("page"));
  if (
    url.origin !== GITHUB_API ||
    !Number.isSafeInteger(page) ||
    page !== currentPage + 1
  )
    throw new GithubLookupError(
      502,
      "github_unavailable",
      "GitHub returned an invalid repository page link.",
    );
  return page;
}

/**
 * Lists the public, non-fork, non-archived repositories a GitHub account
 * owns, most recently pushed first.
 */
export async function listOwnedRepositories(
  fetcher: GithubFetch,
  token: string | undefined,
  login: string,
): Promise<OwnedRepository[]> {
  if (!LOGIN.test(login))
    throw new GithubLookupError(
      400,
      "invalid_request",
      "The signed-in GitHub login is not valid.",
    );
  const repositories = new Map<string, OwnedRepository>();
  let page = 1;
  for (;;) {
    const response = await fetcher(
      `${GITHUB_API}/users/${login}/repos?type=owner&sort=pushed&per_page=100&page=${page}`,
      requestInit(token),
    );
    if (limited(response))
      throw new GithubLookupError(
        503,
        "github_rate_limited",
        "GitHub limited lookups. Enter the repository by name.",
      );
    if (!response.ok)
      throw new GithubLookupError(
        502,
        "github_unavailable",
        `GitHub returned ${response.status}.`,
      );
    const value = await readBoundedJson(
      response,
      2 * 1024 * 1024,
      "GitHub repositories",
    );
    if (!Array.isArray(value))
      throw new GithubLookupError(
        502,
        "github_unavailable",
        "GitHub returned an unexpected response.",
      );
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const repo = entry as Record<string, unknown>;
      if (
        repo.private !== false ||
        repo.fork !== false ||
        repo.archived !== false ||
        typeof repo.full_name !== "string" ||
        !validRepositoryPath(repo.full_name)
      )
        continue;
      if (!repositories.has(repo.full_name))
        repositories.set(repo.full_name, {
          repository: repo.full_name,
          description: repositoryDescription(repo.description),
        });
    }
    const nextPage = nextOwnedRepositoryPage(response, page);
    if (nextPage === null) return [...repositories.values()];
    if (page >= MAX_OWNED_REPOSITORY_PAGES)
      throw new GithubLookupError(
        502,
        "github_unavailable",
        "GitHub returned too many repository pages. Enter the repository by name.",
      );
    page = nextPage;
  }
}

function unknownLicense(
  facts: Omit<RepositoryLookup, "license">,
  reason: string,
): RepositoryLookup {
  return { ...facts, license: { state: "unknown", reason } };
}

/**
 * Reads public repository facts. Unknown license terms stay unknown.
 */
export async function lookupGitHubRepository(
  fetcher: GithubFetch,
  token: string | undefined,
  repository: string,
): Promise<RepositoryLookup> {
  if (!validRepositoryPath(repository))
    throw new GithubLookupError(
      400,
      "invalid_request",
      "Enter the repository as owner/name.",
    );
  const repo = await githubJson(fetcher, token, `/repos/${repository}`);
  if (!repo)
    throw new GithubLookupError(
      404,
      "not_found",
      "GitHub has no public repository with that name.",
    );
  const owner = repo.owner as Record<string, unknown> | undefined;
  if (
    repo.private !== false ||
    !Number.isSafeInteger(repo.id) ||
    typeof repo.node_id !== "string" ||
    !/^[A-Za-z0-9_=-]{1,100}$/u.test(repo.node_id) ||
    typeof repo.full_name !== "string" ||
    !validRepositoryPath(repo.full_name) ||
    typeof repo.default_branch !== "string" ||
    !owner ||
    !Number.isSafeInteger(owner.id) ||
    typeof owner.login !== "string" ||
    typeof owner.node_id !== "string" ||
    (owner.type !== "User" && owner.type !== "Organization")
  )
    throw new GithubLookupError(
      502,
      "github_unavailable",
      "GitHub returned incomplete repository facts.",
    );
  const facts: Omit<RepositoryLookup, "license"> = {
    repository: repo.full_name,
    description: repositoryDescription(repo.description),
    numericId: String(repo.id),
    nodeId: repo.node_id,
    defaultBranch: repo.default_branch,
    owner: {
      login: owner.login,
      actorId: String(owner.id),
      nodeId: owner.node_id,
      kind: owner.type === "User" ? "individual" : "organization",
    },
  };
  try {
    const branch = await githubJson(
      fetcher,
      token,
      `/repos/${repo.full_name}/branches/${encodeURIComponent(repo.default_branch)}`,
    );
    const commitSha = (branch?.commit as Record<string, unknown> | undefined)
      ?.sha;
    if (typeof commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(commitSha))
      return unknownLicense(facts, "The default branch could not be read.");
    const license = await githubJson(
      fetcher,
      token,
      `/repos/${repo.full_name}/license?ref=${commitSha}`,
    );
    if (!license) return unknownLicense(facts, "GitHub found no license file.");
    if (license.path !== "LICENSE")
      return unknownLicense(
        facts,
        `The license file is ${String(license.path)}. A manifest records only a root LICENSE file.`,
      );
    const spdx = (license.license as Record<string, unknown> | undefined)
      ?.spdx_id;
    if (
      typeof spdx !== "string" ||
      spdx === "NOASSERTION" ||
      !/^[A-Za-z0-9-.+]{1,80}$/u.test(spdx)
    )
      return unknownLicense(facts, "GitHub could not identify the license.");
    if (license.encoding !== "base64" || typeof license.content !== "string")
      return unknownLicense(facts, "GitHub did not return the license bytes.");
    const binary = atob(license.content.replace(/\s/gu, ""));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return {
      ...facts,
      license: {
        state: "verified",
        spdx,
        commitSha,
        fileSha256: sha256Hex(bytes),
      },
    };
  } catch (error: unknown) {
    return unknownLicense(
      facts,
      `License facts could not be read. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }
}
