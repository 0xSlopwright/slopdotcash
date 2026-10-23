/**
 * GitHub private vulnerability reporting for automatic private intake (PRD
 * section 8, SEC-07, SEC-17). Every advisory call uses the reporter's own
 * user access token from the dedicated intake App, so GitHub records the
 * reporter as the author; the App never files or reads an advisory with its
 * installation token. Report content is sent, digested and dropped: nothing
 * here logs, and results carry only typed enum values and identifiers.
 */
import { encodeBase64Url, ownedBuffer } from "../../src/lib/byte-encoding";
import { canonicalJson } from "../../src/lib/canonical-json";
import { sha256Hex } from "../../workers/identity/crypto";
import { fail } from "../api-error";

export type FailureCode =
  | "pvr-disabled"
  | "app-not-installed"
  | "forbidden"
  | "invalid"
  | "author-mismatch"
  | "not-found"
  | "grant-expired"
  | "already-recorded";

declare const reporterGrantBrand: unique symbol;
/** A user access token that `/user` proved belongs to `githubId`. */
export type ReporterGrant = {
  readonly token: string;
  readonly githubId: string;
  readonly [reporterGrantBrand]: true;
};

/** Only the grant module and tests mint a grant, after the identity check. */
export function reporterGrant(token: string, githubId: string): ReporterGrant {
  return { token, githubId } as ReporterGrant;
}

export type ReportInput = {
  readonly summary: string;
  readonly description: string;
  readonly severity?: "critical" | "high" | "medium" | "low";
  readonly cvssVectorString?: string;
  readonly cweIds?: readonly string[];
  readonly vulnerabilities?: readonly {
    readonly package: { readonly ecosystem: string; readonly name?: string };
    readonly vulnerableVersionRange?: string;
    readonly patchedVersions?: string;
  }[];
};

/** Report content held in memory for the private analyzer; never stored. */
export type AnalysisInput = {
  readonly summary: string;
  readonly description: string;
  readonly severity?: string;
  readonly cvss?: string;
  readonly cweIds?: string[];
};

export type AdvisoryFacts = {
  ghsa: string;
  repository: string;
  authorId: string | null;
  reporterCreditIds: string[];
  state: string;
  createdAt: string;
  markerFound: boolean;
  evidenceDigest: string;
  /** In memory only, for the private analyzer. Never persisted or logged. */
  analysisInput: AnalysisInput;
};

export interface PrivateAdvisoryClient {
  currentUser(
    grant: ReporterGrant,
  ): Promise<{ ok: true; id: string; login: string } | { ok: false }>;
  createReport(
    grant: ReporterGrant,
    repository: string,
    report: ReportInput,
    marker: string,
  ): Promise<
    | { kind: "created"; facts: AdvisoryFacts }
    | { kind: "rejected"; code: FailureCode }
    | { kind: "uncertain" }
  >;
  getAdvisory(
    grant: ReporterGrant,
    repository: string,
    ghsa: string,
    marker?: string,
  ): Promise<
    | { kind: "found"; facts: AdvisoryFacts }
    | { kind: "not-found" }
    | { kind: "error" }
  >;
  findByMarker(
    grant: ReporterGrant,
    repository: string,
    marker: string,
    since: string,
  ): Promise<
    { kind: "complete"; matches: AdvisoryFacts[] } | { kind: "error" }
  >;
}

export interface IntakeInstallationCheck {
  installed(repository: string): Promise<"yes" | "no" | "unknown">;
}

export const GHSA_PATTERN =
  /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u;
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const CVSS =
  /^CVSS:(?:3\.[01]|4\.0)\/[A-Z]{1,3}:[A-Z](?:\/[A-Z]{1,3}:[A-Z])*$/u;
const CWE = /^CWE-[1-9]\d{0,4}$/u;
const ECOSYSTEMS = [
  "rubygems",
  "npm",
  "pip",
  "maven",
  "nuget",
  "composer",
  "go",
  "rust",
  "erlang",
  "actions",
  "pub",
  "other",
  "swift",
] as const;
const MAX_ADVISORY_BYTES = 1024 * 1024;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_LIST_PAGES = 10;

/** The one line appended to the private GitHub description (OPEN_QUESTION 9). */
export function markerLine(submissionId: string, marker: string): string {
  return `Slop private submission ${submissionId} marker ${marker}`;
}

function bounded(value: unknown, key: string, min: number, max: number) {
  if (typeof value !== "string") fail(400, "invalid_report", `Invalid ${key}`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max)
    fail(400, "invalid_report", `${key} must be ${min} to ${max} characters`);
  return trimmed;
}

/**
 * Validates report fields on the server. Error messages name the field and
 * never echo its content.
 */
export function parseReportInput(value: unknown): ReportInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(400, "invalid_report", "Invalid report");
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "summary",
    "description",
    "severity",
    "cvssVectorString",
    "cweIds",
    "vulnerabilities",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    fail(400, "invalid_report", "Report has unexpected fields");
  const summary = bounded(body.summary, "summary", 8, 1024);
  const description = bounded(body.description, "description", 20, 65_000);
  const report: {
    -readonly [K in keyof ReportInput]: ReportInput[K];
  } = { summary, description };
  if (body.severity !== undefined && body.cvssVectorString !== undefined)
    fail(400, "invalid_report", "Give a severity or a CVSS vector, not both");
  if (body.severity !== undefined) {
    if (!SEVERITIES.includes(body.severity as (typeof SEVERITIES)[number]))
      fail(400, "invalid_report", "Invalid severity");
    report.severity = body.severity as (typeof SEVERITIES)[number];
  }
  if (body.cvssVectorString !== undefined) {
    if (
      typeof body.cvssVectorString !== "string" ||
      body.cvssVectorString.length > 200 ||
      !CVSS.test(body.cvssVectorString)
    )
      fail(400, "invalid_report", "Invalid cvssVectorString");
    report.cvssVectorString = body.cvssVectorString;
  }
  if (body.cweIds !== undefined) {
    if (
      !Array.isArray(body.cweIds) ||
      body.cweIds.length > 10 ||
      body.cweIds.some((id) => typeof id !== "string" || !CWE.test(id))
    )
      fail(400, "invalid_report", "Invalid cweIds");
    report.cweIds = [...new Set(body.cweIds as string[])];
  }
  if (body.vulnerabilities !== undefined) {
    if (
      !Array.isArray(body.vulnerabilities) ||
      body.vulnerabilities.length > 20
    )
      fail(400, "invalid_report", "Invalid vulnerabilities");
    report.vulnerabilities = body.vulnerabilities.map((entry) => {
      if (typeof entry !== "object" || entry === null)
        fail(400, "invalid_report", "Invalid vulnerabilities");
      const item = entry as Record<string, unknown>;
      const pkg = item.package as Record<string, unknown> | undefined;
      if (
        typeof pkg !== "object" ||
        pkg === null ||
        !ECOSYSTEMS.includes(pkg.ecosystem as (typeof ECOSYSTEMS)[number]) ||
        (pkg.name !== undefined &&
          (typeof pkg.name !== "string" ||
            pkg.name.length < 1 ||
            pkg.name.length > 214))
      )
        fail(400, "invalid_report", "Invalid vulnerabilities");
      const optional = (key: string) => {
        if (item[key] === undefined) return undefined;
        if (typeof item[key] !== "string" || (item[key] as string).length > 256)
          fail(400, "invalid_report", "Invalid vulnerabilities");
        return item[key] as string;
      };
      return {
        package: {
          ecosystem: pkg.ecosystem as string,
          ...(pkg.name === undefined ? {} : { name: pkg.name as string }),
        },
        ...(optional("vulnerableVersionRange") === undefined
          ? {}
          : { vulnerableVersionRange: optional("vulnerableVersionRange") }),
        ...(optional("patchedVersions") === undefined
          ? {}
          : { patchedVersions: optional("patchedVersions") }),
      };
    });
  }
  return report;
}

function githubId(value: unknown): string | null {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? String(value)
    : null;
}

/**
 * Reduces a GitHub repository advisory to the facts Slop checks. The body is
 * digested, then dropped; only `analysisInput` stays in memory for the
 * private analyzer. Returns null for anything malformed.
 */
export async function advisoryFacts(
  value: unknown,
  marker?: string,
): Promise<AdvisoryFacts | null> {
  if (typeof value !== "object" || value === null) return null;
  const advisory = value as Record<string, unknown>;
  const ghsa = advisory.ghsa_id;
  if (typeof ghsa !== "string" || !GHSA_PATTERN.test(ghsa)) return null;
  let repository: string;
  try {
    const url = new URL(String(advisory.html_url));
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:" ||
      parts.length !== 5 ||
      parts[2] !== "security" ||
      parts[3] !== "advisories" ||
      parts[4] !== ghsa
    )
      return null;
    repository = `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
  const createdAt = advisory.created_at;
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)))
    return null;
  const summary = typeof advisory.summary === "string" ? advisory.summary : "";
  const description =
    typeof advisory.description === "string" ? advisory.description : "";
  const severity =
    typeof advisory.severity === "string" ? advisory.severity : undefined;
  const cvssVector = (advisory.cvss as { vector_string?: unknown } | null)
    ?.vector_string;
  const cvss = typeof cvssVector === "string" ? cvssVector : undefined;
  const cweIds = Array.isArray(advisory.cwe_ids)
    ? advisory.cwe_ids.filter((id): id is string => typeof id === "string")
    : [];
  const credits = Array.isArray(advisory.credits_detailed)
    ? advisory.credits_detailed
    : [];
  const reporterCreditIds = credits
    .filter(
      (credit) =>
        typeof credit === "object" &&
        credit !== null &&
        (credit as { type?: unknown }).type === "reporter",
    )
    .map((credit) => githubId((credit as { user?: { id?: unknown } }).user?.id))
    .filter((id): id is string => id !== null);
  return {
    ghsa,
    repository,
    authorId: githubId((advisory.author as { id?: unknown } | null)?.id),
    reporterCreditIds,
    state: typeof advisory.state === "string" ? advisory.state : "unknown",
    createdAt: new Date(Date.parse(createdAt)).toISOString(),
    markerFound:
      marker !== undefined &&
      description.split(/\r?\n/u).some((line) => line.trim() === marker),
    evidenceDigest: await sha256Hex(
      canonicalJson({
        summary,
        description,
        severity: severity ?? null,
        cvss: cvss ?? null,
        cwe_ids: cweIds,
        vulnerabilities: advisory.vulnerabilities ?? null,
      }),
    ),
    analysisInput: { summary, description, severity, cvss, cweIds },
  };
}

/** Reads at most `limit` bytes of JSON; throws past it. */
export async function readBoundedJson(
  response: Pick<Response, "headers" | "body">,
  limit: number,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > limit)
  )
    throw new RangeError("response too large");
  if (!response.body) throw new TypeError("no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new RangeError("response too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function headers(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "slop.cash-private-intake",
    "x-github-api-version": "2022-11-28",
  };
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function repositoryPath(repository: string): string {
  const [owner, name] = repository.split("/");
  return `${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
}

/**
 * The real GitHub client. Its exact response shapes are not yet qualified
 * against GitHub (OPEN_QUESTION 2), so anything outside the mapped statuses
 * is treated as uncertain and reconciled before any retry.
 */
export function githubAdvisoryClient(options: {
  fetch: Fetch;
  apiOrigin: string;
  installation: IntakeInstallationCheck;
}): PrivateAdvisoryClient {
  const request = (url: string, token: string, init: RequestInit = {}) =>
    options.fetch(url, {
      ...init,
      headers: {
        ...headers(token),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  return {
    async currentUser(grant) {
      try {
        const response = await request(
          `${options.apiOrigin}/user`,
          grant.token,
        );
        if (response.status !== 200) return { ok: false };
        const user = (await readBoundedJson(response, 64 * 1024)) as {
          id?: unknown;
          login?: unknown;
        };
        const id = githubId(user?.id);
        if (
          id === null ||
          typeof user.login !== "string" ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(user.login)
        )
          return { ok: false };
        return { ok: true, id, login: user.login };
      } catch {
        return { ok: false };
      }
    },
    async createReport(grant, repository, report, marker) {
      const body = {
        summary: report.summary,
        description: `${report.description}\n\n${marker}`,
        ...(report.severity ? { severity: report.severity } : {}),
        ...(report.cvssVectorString
          ? { cvss_vector_string: report.cvssVectorString }
          : {}),
        ...(report.cweIds ? { cwe_ids: report.cweIds } : {}),
        ...(report.vulnerabilities
          ? {
              vulnerabilities: report.vulnerabilities.map((entry) => ({
                package: entry.package,
                ...(entry.vulnerableVersionRange
                  ? { vulnerable_version_range: entry.vulnerableVersionRange }
                  : {}),
                ...(entry.patchedVersions
                  ? { patched_versions: entry.patchedVersions }
                  : {}),
              })),
            }
          : {}),
        start_private_fork: false,
      };
      let response: Response;
      try {
        response = await request(
          `${options.apiOrigin}/repos/${repositoryPath(repository)}/security-advisories/reports`,
          grant.token,
          { method: "POST", body: JSON.stringify(body) },
        );
      } catch {
        return { kind: "uncertain" };
      }
      if (response.status === 201) {
        try {
          const facts = await advisoryFacts(
            await readBoundedJson(response, MAX_ADVISORY_BYTES),
            marker,
          );
          // A 201 counts only when it names this repository and this author.
          if (
            facts === null ||
            !sameRepository(facts.repository, repository) ||
            facts.authorId !== grant.githubId
          )
            return { kind: "uncertain" };
          return { kind: "created", facts };
        } catch {
          return { kind: "uncertain" };
        }
      }
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401)
        return { kind: "rejected", code: "grant-expired" };
      if (response.status === 403)
        return { kind: "rejected", code: "forbidden" };
      if (response.status === 422) return { kind: "rejected", code: "invalid" };
      if (response.status === 404)
        return {
          kind: "rejected",
          code:
            (await options.installation.installed(repository)) === "no"
              ? "app-not-installed"
              : "pvr-disabled",
        };
      return { kind: "uncertain" };
    },
    async getAdvisory(grant, repository, ghsa, marker) {
      if (!GHSA_PATTERN.test(ghsa)) return { kind: "not-found" };
      try {
        const response = await request(
          `${options.apiOrigin}/repos/${repositoryPath(repository)}/security-advisories/${ghsa}`,
          grant.token,
        );
        if (response.status === 404) {
          await response.body?.cancel().catch(() => undefined);
          return { kind: "not-found" };
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return { kind: "error" };
        }
        const facts = await advisoryFacts(
          await readBoundedJson(response, MAX_ADVISORY_BYTES),
          marker,
        );
        if (facts === null || facts.ghsa !== ghsa) return { kind: "error" };
        return { kind: "found", facts };
      } catch {
        return { kind: "error" };
      }
    },
    async findByMarker(grant, repository, marker, since) {
      const sinceTime = Date.parse(since);
      const first = new URL(
        `${options.apiOrigin}/repos/${repositoryPath(repository)}/security-advisories`,
      );
      first.searchParams.set("sort", "created");
      first.searchParams.set("direction", "desc");
      first.searchParams.set("per_page", "100");
      let next: URL | null = first;
      const matches: AdvisoryFacts[] = [];
      try {
        for (let page = 0; next !== null; page += 1) {
          if (page >= MAX_LIST_PAGES) return { kind: "error" };
          const response = await request(next.href, grant.token);
          if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            return { kind: "error" };
          }
          const link = response.headers.get("link");
          const items = await readBoundedJson(response, MAX_LIST_BYTES);
          if (!Array.isArray(items)) return { kind: "error" };
          let reachedSince = false;
          for (const item of items) {
            const facts = await advisoryFacts(item, marker);
            if (facts === null) return { kind: "error" };
            if (Date.parse(facts.createdAt) < sinceTime) {
              reachedSince = true;
              continue;
            }
            if (
              facts.markerFound &&
              facts.authorId === grant.githubId &&
              sameRepository(facts.repository, repository)
            )
              matches.push(facts);
          }
          if (reachedSince) break;
          next = nextPage(link, first);
        }
      } catch {
        return { kind: "error" };
      }
      return { kind: "complete", matches };
    },
  };
}

/** The `rel="next"` page of the same listing, or null. */
function nextPage(link: string | null, first: URL): URL | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/u.exec(part);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      return url.origin === first.origin && url.pathname === first.pathname
        ? url
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/** Wraps a PKCS#1 RSA key, which GitHub issues, as PKCS#8 for WebCrypto. */
function pkcs8FromPem(pem: string): Uint8Array {
  const pkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const body = pem
    .replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/gu, "")
    .replace(/\s+/gu, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!pkcs1) return der;
  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ];
  const octet = [0x04, ...derLength(der.length)];
  const inner = [0x02, 0x01, 0x00, ...algorithm, ...octet];
  const total = inner.length + der.length;
  const out = new Uint8Array([0x30, ...derLength(total), ...inner, ...der]);
  return out;
}

async function appJwt(
  appId: string,
  privateKey: string,
  now: Date,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    ownedBuffer(pkcs8FromPem(privateKey)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoder = new TextEncoder();
  const seconds = Math.floor(now.getTime() / 1000);
  const segment = (value: unknown) =>
    encodeBase64Url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({
    iat: seconds - 60,
    exp: seconds + 540,
    iss: appId,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * Whether the intake App is installed on the program repository. Uses the
 * App JWT for repository installation metadata only; it never reads an
 * advisory.
 */
export function githubInstallationCheck(options: {
  fetch: Fetch;
  apiOrigin: string;
  appId: string;
  privateKey: string;
  now: () => Date;
}): IntakeInstallationCheck {
  return {
    async installed(repository) {
      try {
        const jwt = await appJwt(
          options.appId,
          options.privateKey,
          options.now(),
        );
        const response = await options.fetch(
          `${options.apiOrigin}/repos/${repositoryPath(repository)}/installation`,
          {
            headers: headers(jwt),
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (response.status === 404) {
          await response.body?.cancel().catch(() => undefined);
          return "no";
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return "unknown";
        }
        const body = (await readBoundedJson(response, 64 * 1024)) as {
          id?: unknown;
        };
        return githubId(body?.id) === null ? "unknown" : "yes";
      } catch {
        return "unknown";
      }
    },
  };
}
