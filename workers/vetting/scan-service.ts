/**
 * The bounded-scan service (PRD section 8; issue #909). One cycle chains
 * every step of `README.md` for each queued assessment:
 *
 *   signed refresh -> signed queue -> exact acquisition -> deterministic
 *   inspection -> primary review -> specialist review (only when the
 *   result is ambiguous or high risk) -> private evidence retention ->
 *   one signed, journaled publication.
 *
 * The service holds the signing key and the Surplus key, so it never
 * executes repository content: inspection reads bytes only. A committed
 * binary, an archive or an install-time download stays quarantined, and its
 * result stays incomplete until an isolated runner or a moderator answers
 * it. A model label never makes a result malicious; only a moderator's
 * confirmation does. Logs carry identifiers and outcomes only.
 */
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseVettingScanResult } from "../../backend/vetting/scan-result";
import {
  composeScanResult,
  inspectRepository,
  readQueuedScanInput,
} from "./bounded-scan";
import { publishResult } from "./publication";
import {
  acquireQueuedAssessment,
  type QueueConnection,
  readPendingAssessments,
} from "./queue";
import { reviewScan, type ScannerProfile } from "./scanners";
import { signedServiceHeaders, type VettingServiceSigner } from "./service";

/** Owner decision D16: the scan models, both bought through Surplus. */
export const SCAN_PRIMARY_MODEL = "claude-opus-5.5";
export const SCAN_SPECIALIST_MODEL = "gpt-6.1-sol";
const SURPLUS_MESSAGES =
  "https://api.surplusintelligence.ai/anthropic/v1/messages";

export type ScanRateCard = ScannerProfile["rateCard"];

/** The primary and specialist profiles. The model has no other default. */
export function surplusScanProfiles(input: {
  apiKey: string;
  maxOutputTokens: number;
  rateCards: { primary: ScanRateCard; specialist: ScanRateCard };
}): { primary: ScannerProfile; specialist: ScannerProfile } {
  const profile = (
    reviewer: "opus" | "sol",
    model: string,
    rateCard: ScanRateCard,
  ): ScannerProfile => ({
    reviewer,
    transport: "surplus-messages",
    endpoint: SURPLUS_MESSAGES,
    model,
    apiKey: input.apiKey,
    maxOutputTokens: input.maxOutputTokens,
    rateCard,
  });
  return {
    primary: profile("opus", SCAN_PRIMARY_MODEL, input.rateCards.primary),
    specialist: profile(
      "sol",
      SCAN_SPECIALIST_MODEL,
      input.rateCards.specialist,
    ),
  };
}

export type ScanServiceDependencies = {
  /** The exact HTTPS origin of the Slop API. */
  origin: string;
  signer: VettingServiceSigner;
  primary: ScannerProfile;
  specialist: ScannerProfile;
  /** The scan policy version every result of this service names. */
  policyVersion: string;
  /** Private, operator-only directories outside every shared mount. */
  workDirectory: string;
  journalDirectory: string;
  fetch?: typeof fetch;
  now?: () => Date;
};

export type ScanOutcome = {
  assessmentId: string;
  /** The stage that stopped the assessment, or "published". */
  stage:
    | "published"
    | "journaled-earlier"
    | "acquisition-failed"
    | "scan-failed"
    | "retention-failed"
    | "publication-failed";
  disposition: "clean" | "incomplete" | null;
  specialistReviewed: boolean;
  /**
   * A clean result is never published without retained evidence. An
   * incomplete result is published even when retention failed, so a
   * quarantine is recorded and the scan is not repeated every cycle.
   */
  evidence: "retained" | "failed" | null;
  publication: "accepted" | "rejected" | "unknown" | null;
};

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

async function signedRequest(
  deps: ScanServiceDependencies,
  method: "POST" | "PUT",
  path: string,
  body: Uint8Array,
): Promise<Response> {
  const headers = await signedServiceHeaders({
    signer: deps.signer,
    method,
    pathAndQuery: path,
    body,
    at: deps.now?.(),
  });
  return (deps.fetch ?? fetch)(`${deps.origin}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body as Uint8Array<ArrayBuffer>,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
}

/** Asks Slop to queue the scans that changed content and flag pauses need. */
async function refresh(deps: ScanServiceDependencies): Promise<void> {
  const response = await signedRequest(
    deps,
    "POST",
    "/api/v1/vetting/refresh",
    new TextEncoder().encode("{}"),
  );
  await response.body?.cancel();
  if (response.status !== 200) throw new Error("Scan refresh was refused");
}

type EvidenceObject = {
  sha256: string;
  kind: "trace" | "manifest" | "artifact";
  label: string;
  contentType: "application/json" | "application/octet-stream";
  bytes: Uint8Array;
};

/**
 * Registers and uploads the report, the exact inventory, every dependency
 * lock and every named artifact under the scan run. The store rereads each
 * object; a clean result cannot be recorded without them.
 */
async function retainEvidence(
  deps: ScanServiceDependencies,
  assessmentId: string,
  runId: string,
  objects: EvidenceObject[],
): Promise<void> {
  const unique = [
    ...new Map(objects.map((object) => [object.sha256, object])).values(),
  ];
  const path = `/api/v1/vetting/evidence/${assessmentId}/${runId}`;
  const manifest = {
    traceSha256: unique.find((object) => object.kind === "trace")?.sha256,
    objects: unique.map(({ bytes, ...object }) => ({
      ...object,
      sizeBytes: bytes.byteLength,
    })),
  };
  const registered = await signedRequest(
    deps,
    "POST",
    path,
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  await registered.body?.cancel();
  if (registered.status !== 201 && registered.status !== 200)
    throw new Error("Evidence registration was refused");
  for (const object of unique) {
    const uploaded = await signedRequest(
      deps,
      "PUT",
      `${path}/${object.sha256}`,
      object.bytes,
    );
    await uploaded.body?.cancel();
    if (uploaded.status !== 200) throw new Error("Evidence upload was refused");
  }
}

async function journaled(deps: ScanServiceDependencies, id: string) {
  try {
    await access(join(deps.journalDirectory, id));
    return true;
  } catch {
    return false;
  }
}

/** Scans one queued assessment and publishes its result once. */
export async function scanAssessment(
  deps: ScanServiceDependencies,
  assessmentId: string,
): Promise<ScanOutcome> {
  const outcome: ScanOutcome = {
    assessmentId,
    stage: "acquisition-failed",
    disposition: null,
    specialistReviewed: false,
    evidence: null,
    publication: null,
  };
  // An earlier attempt reserved this publication: an operator reconciles it.
  if (await journaled(deps, assessmentId))
    return { ...outcome, stage: "journaled-earlier" };
  const now = () => deps.now?.() ?? new Date();
  const connection: QueueConnection = {
    origin: deps.origin,
    privateKey: deps.signer.privateKey,
    publicKey: deps.signer.publicKey,
    fetch: deps.fetch,
    now: deps.now,
  };
  const startedAt = now().toISOString();
  let directory: string;
  try {
    directory = (
      await acquireQueuedAssessment(
        connection,
        assessmentId,
        deps.workDirectory,
      )
    ).directory;
  } catch {
    return outcome;
  }
  try {
    outcome.stage = "scan-failed";
    const input = await readQueuedScanInput(directory);
    if (input.queued.assessmentId !== assessmentId)
      throw new Error("Acquisition answered another assessment");
    const inspection = inspectRepository({
      files: input.files,
      acquisitionGaps: input.acquisitionGaps,
    });
    const evidence = new TextDecoder().decode(inspection.inventory);
    const review = (profile: ScannerProfile) =>
      reviewScan({
        evidence,
        inputSha256: inspection.inventorySha256,
        profile,
        fetch: deps.fetch,
      });
    const runId = `scan-${randomUUID()}`;
    const compose = (
      primary: Awaited<ReturnType<typeof review>>,
      specialist: Awaited<ReturnType<typeof review>> | null,
    ) =>
      composeScanResult({
        queued: input.queued,
        inspection,
        policyVersion: deps.policyVersion,
        runId,
        startedAt,
        completedAt: now().toISOString(),
        primary,
        specialist,
      });
    const primary = await review(deps.primary);
    let composed = compose(primary, null);
    if (composed.needsSpecialist) {
      composed = compose(primary, await review(deps.specialist));
      outcome.specialistReviewed = true;
    }
    const body = JSON.stringify(parseVettingScanResult(composed.result));
    const result = JSON.parse(body) as typeof composed.result;
    outcome.disposition =
      result.disposition === "clean" ? "clean" : "incomplete";

    outcome.stage = "retention-failed";
    const object = async (sha: string) => {
      const bytes = new Uint8Array(
        await readFile(join(directory, "objects", sha)),
      );
      if (sha256(bytes) !== sha) throw new Error("Acquired bytes changed");
      return bytes;
    };
    const lockObjects = await Promise.all(
      result.assessed.dependencyLocks.map(async (lock) => ({
        sha256: lock.sha256,
        kind: "artifact" as const,
        label: `dependency lock ${lock.path}`.slice(0, 200),
        contentType: "application/octet-stream" as const,
        bytes: await object(lock.sha256),
      })),
    );
    // Only repository artifacts have acquired bytes; an unretrieved
    // download has none and keeps the result incomplete.
    const artifactObjects = await Promise.all(
      result.artifacts
        .filter((artifact) => artifact.origin === "repository")
        .map(async (artifact) => ({
          sha256: artifact.sha256,
          kind: "artifact" as const,
          label: `quarantined ${artifact.type} ${artifact.path}`.slice(0, 200),
          contentType: "application/octet-stream" as const,
          bytes: await object(artifact.sha256),
        })),
    );
    const retained = retainEvidence(deps, assessmentId, runId, [
      {
        sha256: result.scan.reportSha256,
        kind: "trace",
        label: "bounded scan report",
        contentType: "application/json",
        bytes: composed.report,
      },
      {
        sha256: inspection.inventorySha256,
        kind: "manifest",
        label: "bounded scan inventory",
        contentType: "application/json",
        bytes: inspection.inventory,
      },
      ...lockObjects,
      ...artifactObjects,
    ]).then(
      () => "retained" as const,
      () => "failed" as const,
    );
    outcome.evidence = await retained;
    if (outcome.evidence === "failed" && result.disposition === "clean")
      return outcome;

    outcome.stage = "publication-failed";
    const receipt = await publishResult({
      origin: deps.origin,
      body,
      approvedSha256: sha256(body),
      signer: deps.signer,
      journalDirectory: deps.journalDirectory,
      at: deps.now?.(),
      fetch: deps.fetch,
    });
    outcome.publication = receipt.outcome;
    if (receipt.outcome === "accepted") outcome.stage = "published";
    return outcome;
  } catch {
    // No source, prompt, response or credential leaves through an error.
    return outcome;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** One service cycle: refresh, then every pending assessment in queue order. */
export async function runScanCycle(
  deps: ScanServiceDependencies,
): Promise<ScanOutcome[]> {
  await refresh(deps);
  const pending = await readPendingAssessments({
    origin: deps.origin,
    privateKey: deps.signer.privateKey,
    publicKey: deps.signer.publicKey,
    fetch: deps.fetch,
    now: deps.now,
  });
  const outcomes: ScanOutcome[] = [];
  for (const assessment of pending)
    outcomes.push(await scanAssessment(deps, assessment.assessmentId));
  return outcomes;
}

/** Imports the Ed25519 service key from its PKCS #8 base64 form. */
export async function importServiceSigner(
  pkcs8Base64: string,
): Promise<VettingServiceSigner> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(pkcs8Base64, "base64"),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const { x } = await crypto.subtle.exportKey("jwk", privateKey);
  if (!x) throw new Error("The service key has no public part");
  const publicKey = await crypto.subtle.importKey(
    "raw",
    Buffer.from(x, "base64url"),
    { name: "Ed25519" },
    true,
    ["verify"],
  );
  return { privateKey, publicKey };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  // The operator profile: {"policyVersion","maxOutputTokens","rateCards":
  // {"primary":{...},"specialist":{...}}}. Secrets come only from the
  // environment and never enter a prompt, result, report or log.
  const profile = JSON.parse(required("VETTING_SCAN_PROFILE")) as {
    policyVersion: string;
    maxOutputTokens: number;
    rateCards: { primary: ScanRateCard; specialist: ScanRateCard };
  };
  const models = surplusScanProfiles({
    apiKey: required("SURPLUS_API_KEY"),
    maxOutputTokens: profile.maxOutputTokens,
    rateCards: profile.rateCards,
  });
  const outcomes = await runScanCycle({
    origin: required("VETTING_SERVICE_ORIGIN"),
    signer: await importServiceSigner(required("VETTING_SERVICE_PRIVATE_KEY")),
    ...models,
    policyVersion: profile.policyVersion,
    workDirectory: required("VETTING_WORK_DIRECTORY"),
    journalDirectory: required("VETTING_JOURNAL_DIRECTORY"),
  });
  for (const outcome of outcomes) console.log(JSON.stringify(outcome));
  if (outcomes.some((outcome) => outcome.stage !== "published"))
    process.exitCode = 1;
}
