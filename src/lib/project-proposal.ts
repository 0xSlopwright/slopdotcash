import type {
  OwnedRepository,
  RepositoryLookup,
} from "../../backend/projects/github-lookup";
import { fetchWithDeadline, readBoundedJson } from "./browser-json";
import {
  formatMonthlyCapDisplay,
  MAX_MONTHLY_CAP_MINOR,
} from "./project-schema.mjs";

export function safeProposalHttpsUrl(value: string): boolean {
  if (value.length === 0 || value.length > 500) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

export function immutableProposalTermsUrl(
  value: string,
  repository: string,
  commit: string,
): boolean {
  if (!safeProposalHttpsUrl(value)) return false;
  const parsed = new URL(value);
  const prefix = `/${repository}/blob/${commit}/`;
  return (
    parsed.origin === "https://github.com" &&
    !parsed.search &&
    parsed.pathname.startsWith(prefix) &&
    parsed.pathname.length > prefix.length
  );
}

const GITHUB_REPOSITORY_LINK =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?(?:\/[^\s]*)?(?:[?#][^\s]*)?$/iu;
const GITHUB_REPOSITORY_SSH =
  /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu;
const REPOSITORY_PATH = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/**
 * Turns a pasted github.com link (https, bare host, ssh, with .git, a
 * trailing slash, a deeper path, a query or a hash) into the owner/name form
 * the project manifest requires. Anything that is not a github.com link is
 * only trimmed, so a wrong value stays visible instead of being guessed.
 */
export function normalizeRepositoryInput(value: string): string {
  const trimmed = value.trim();
  const match =
    GITHUB_REPOSITORY_LINK.exec(trimmed) ?? GITHUB_REPOSITORY_SSH.exec(trimmed);
  return match ? `${match[1]}/${match[2]}` : trimmed;
}

export function validRepositoryPath(value: string): boolean {
  return value.length <= 201 && REPOSITORY_PATH.test(value);
}

export function boundedText(
  value: string,
  minimum: number,
  maximum: number,
): boolean {
  const length = value.trim().length;
  return length >= minimum && length <= maximum;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);
}

export function monthlyPoolValue(value: string): {
  display: string;
  minor: string;
  valid: boolean;
} {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(value)) {
    return { display: "$0", minor: "0", valid: false };
  }
  const [whole, fraction = ""] = value.split(".");
  const minor = (
    BigInt(whole) * 1_000_000n +
    BigInt(fraction.padEnd(2, "0")) * 10_000n
  ).toString();
  if (BigInt(minor) > MAX_MONTHLY_CAP_MINOR) {
    return { display: "$0", minor: "0", valid: false };
  }
  return {
    display: formatMonthlyCapDisplay(minor),
    minor,
    valid: true,
  };
}

export type {
  OwnedRepository,
  RepositoryLookup,
} from "../../backend/projects/github-lookup";

async function projectGithubRequest<T>(
  path: string,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetchWithDeadline(`/api/v1/project-github/${path}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  let value: unknown;
  try {
    value = await readBoundedJson(response, 2 * 1024 * 1024, "GitHub lookup");
  } catch {
    throw new Error(`The GitHub lookup returned HTTP ${response.status}.`);
  }
  if (!response.ok) {
    const message = (value as { message?: unknown } | null)?.message;
    throw new Error(
      response.status === 401
        ? "Sign in with GitHub to look up repositories."
        : typeof message === "string"
          ? message
          : `The GitHub lookup returned HTTP ${response.status}.`,
    );
  }
  return value as T;
}

/**
 * Lists the signed-in maintainer's public, non-fork, non-archived
 * repositories. The site server reads GitHub with the site session; the
 * browser never calls api.github.com.
 */
export async function listOwnedRepositories(
  signal: AbortSignal,
): Promise<OwnedRepository[]> {
  const body = await projectGithubRequest<{ repositories?: unknown }>(
    "owned-repositories",
    signal,
  );
  if (!Array.isArray(body.repositories))
    throw new Error("The GitHub lookup returned an unexpected response.");
  return body.repositories as OwnedRepository[];
}

/** Reads public repository facts through the site server. */
export async function lookupGitHubRepository(
  repository: string,
  signal: AbortSignal,
): Promise<RepositoryLookup> {
  if (!validRepositoryPath(repository))
    throw new Error("Enter the repository as owner/name first.");
  const [owner, name] = repository.split("/");
  const body = await projectGithubRequest<{ repository?: unknown }>(
    `repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    signal,
  );
  if (!body.repository || typeof body.repository !== "object")
    throw new Error("The GitHub lookup returned an unexpected response.");
  return body.repository as RepositoryLookup;
}
