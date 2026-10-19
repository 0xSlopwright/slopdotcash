/**
 * Harmless secure-VM vetting results for the API tests and the registry
 * browser lane: one clean baseline, one incomplete run with a quarantined
 * native module and a telemetry gap, and one confirmed-malicious run that
 * read canary secrets. Tests sign them with a throwaway Ed25519 key the way
 * the external vetting service must.
 */

import { vettingSignedMessage } from "../backend/vetting/handler";
import { TELEMETRY_CHANNELS } from "../backend/vetting/result";

export type VettingFixtureTarget = {
  assessmentId: string;
  projectId: string;
  revision: number;
  manifestSha256: string;
  repository: string;
  /** The integration-branch commit the queue assigned. */
  commitSha: string;
  /** The skill template commit the queue assigned. */
  templateCommit: string;
};

const digest = (character: string) => character.repeat(64);

export function vettingResult(
  target: VettingFixtureTarget,
  disposition: "clean" | "incomplete" | "malicious",
) {
  const complete = Object.fromEntries(
    TELEMETRY_CHANNELS.map((channel) => [channel, "complete"]),
  );
  const review = (reviewer: "astra" | "opus") => ({
    reviewer,
    provider: reviewer === "astra" ? "astra-security" : "anthropic",
    model: reviewer === "astra" ? "astra-2026-09" : "claude-opus-5-5",
    promptPolicyRevision: "vet-prompt-1",
    inputManifestSha256: digest("c"),
    runId: `${reviewer}-run-${target.revision}`,
    status: "completed",
    verdict:
      disposition === "malicious" ? "malicious-suspected" : "no-findings",
    findingCount: disposition === "malicious" ? 1 : 0,
  });
  return {
    schemaVersion: "slop-vetting-result-v1",
    assessmentId: target.assessmentId,
    projectId: target.projectId,
    revision: target.revision,
    manifestSha256: target.manifestSha256,
    disposition,
    policyVersion: "vet-policy-1",
    assessed: {
      repository: target.repository,
      commitSha: target.commitSha,
      templateCommit: target.templateCommit,
      inputManifestSha256: digest("c"),
      dependencyLocks: [{ path: "bun.lock", sha256: digest("d") }],
    },
    environment: {
      vmProvider: "fixture-microvm",
      isolation: "microvm",
      imageSha256: digest("e"),
      collectorId: "fixture-collector",
      runId: `vm-run-${target.revision}`,
      startedAt: "2026-10-18T11:00:00.000Z",
      completedAt: "2026-10-18T11:30:00.000Z",
    },
    telemetry: {
      coverage:
        disposition === "incomplete"
          ? { ...complete, http: "partial" }
          : complete,
      visibilityGaps:
        disposition === "incomplete"
          ? ["A pinned TLS client hid HTTP bodies"]
          : [],
      tamperDetected: false,
      canaryAccessAttempts: disposition === "malicious" ? 2 : 0,
      egress: "default-deny",
    },
    traceSha256: digest("f"),
    modelReviews: [review("astra"), review("opus")],
    artifacts:
      disposition === "clean"
        ? [
            {
              sha256: digest("1"),
              parentSha256: null,
              origin: "registry.npmjs.org/esbuild",
              path: "node_modules/esbuild/bin/esbuild",
              type: "binary",
              state: "released",
              analysis: "static-clean",
              requestedExecution: true,
            },
          ]
        : [
            {
              sha256: digest("2"),
              parentSha256: digest("3"),
              origin: "postinstall download",
              path: "vendor/addon.node",
              type: "native-module",
              state: disposition === "malicious" ? "blocked" : "quarantined",
              analysis: disposition === "malicious" ? "malicious" : "pending",
              requestedExecution: true,
            },
          ],
    findings:
      disposition === "malicious"
        ? [
            {
              severity: "critical",
              category: "credential-exfiltration",
              summary:
                "A postinstall child process read the canary wallet file",
              evidence: "trace event 4182",
            },
          ]
        : [],
    confirmation:
      disposition === "malicious"
        ? {
            basis: "reproducible-behavior",
            rule: "standing-rule-credential-theft",
            evidence: ["trace event 4182", "proxy log 77"],
          }
        : null,
  };
}

export async function vettingKeyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    privateKey: pair.privateKey,
    publicKey: btoa(String.fromCharCode(...raw)),
    raw,
  };
}

async function hex(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The headers the vetting service sends with a signed request. */
export async function signedVettingHeaders(
  privateKey: CryptoKey,
  publicKeyRaw: Uint8Array,
  method: string,
  pathAndQuery: string,
  body: string,
  at = new Date(),
): Promise<Record<string, string>> {
  const timestamp = at.toISOString();
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      vettingSignedMessage(
        method,
        pathAndQuery,
        timestamp,
        await hex(new TextEncoder().encode(body)),
      ) as Uint8Array<ArrayBuffer>,
    ),
  );
  return {
    "x-slop-vetting-key": await hex(publicKeyRaw),
    "x-slop-vetting-timestamp": timestamp,
    "x-slop-vetting-signature": btoa(String.fromCharCode(...signature)),
  };
}
