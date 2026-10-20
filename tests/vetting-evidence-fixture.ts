/** Real local workerd R2 for the connected vetting workflows; no live policy. */
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { ProjectD1Database } from "../backend/projects/cloudflare-persistence";
import type { R2Bucket } from "../backend/trace/cloudflare-persistence";
import {
  type EvidencePolicy,
  VettingEvidence,
} from "../backend/vetting/evidence";
import { signedVettingRequest } from "../backend/vetting/handler";
import {
  signedVettingHeaders,
  VETTING_EVIDENCE_OBJECTS,
  VETTING_TRACE_SHA,
  vettingKeyPair,
} from "./vetting-fixtures";

export function localEvidencePolicy(now: Date): EvidencePolicy {
  return {
    version: "isolated-fixture-only",
    policyAuthorityGithubId: "900000003",
    operatorGithubIds: ["900000003"],
    accessDurationSeconds: 3600,
    maxObjectBytes: 8 * 1024 * 1024,
    maxRunBytes: 64 * 1024 * 1024,
    maxObjects: 1024,
    accessPolicyReference: "fixture:restricted-access",
    retentionPolicyReference: "fixture:external-retention",
    recoveryPolicyReference: "fixture:external-recovery",
    externalControls: {
      evidenceReference: "fixture:authority-attestation",
      attestedByGithubId: "900000003",
      attestedAt: new Date(now.getTime() - 1000).toISOString(),
      validUntil: new Date(now.getTime() + 7200_000).toISOString(),
    },
  };
}
export async function localVettingEvidence(
  db: ProjectD1Database,
  now: () => Date,
) {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: "evidence",
      modules: true,
      script: "export default {fetch(){return new Response()}}",
      compatibilityDate: "2026-07-30",
      r2Buckets: ["E"],
    }),
  );
  const bucket = (await runtime.getR2Bucket(
    "E",
    "evidence",
  )) as unknown as Omit<R2Bucket, "get"> & {
    get(key: string): Promise<{
      size: number;
      customMetadata?: Record<string, string>;
      arrayBuffer(): Promise<ArrayBuffer>;
    } | null>;
    delete(key: string): Promise<void>;
  };
  const keys = await vettingKeyPair();
  const evidence = new VettingEvidence({
    db,
    bucket: {
      head: (key) => bucket.head(key),
      put: (key, bytes, options) => bucket.put(key, bytes, options),
      // Miniflare's RPC stream proxy cannot transfer getReader() through Bun.
      // Read the actual workerd object bytes, then expose a native stream.
      get: async (key) => {
        const value = await bucket.get(key);
        return value
          ? {
              size: value.size,
              customMetadata: value.customMetadata,
              body: new Response(await value.arrayBuffer()).body!,
            }
          : null;
      },
    } as R2Bucket,
    policy: JSON.stringify(localEvidencePolicy(now())),
    now,
    randomId: () => crypto.randomUUID(),
    session: async (request) => {
      const id = request.headers.get("x-test-operator");
      return id ? { githubId: id, githubLogin: "fixture", admin: false } : null;
    },
    signed: (request, maximum) =>
      signedVettingRequest(
        request,
        { resultPublicKeys: keys.publicKey, now },
        maximum,
      ),
  });
  async function request(method: string, path: string, body: string) {
    return new Request(`https://slop.cash${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(await signedVettingHeaders(
          keys.privateKey,
          keys.raw,
          method,
          path,
          body,
          now(),
        )),
      },
      body,
    });
  }
  async function retain(assessmentId: string, runId: string) {
    const path = `/api/v1/vetting/evidence/${assessmentId}/${runId}`;
    const manifest = {
      traceSha256: VETTING_TRACE_SHA,
      objects: VETTING_EVIDENCE_OBJECTS.map(
        ({ body: _body, ...object }) => object,
      ),
    };
    const requests = [await request("POST", path, JSON.stringify(manifest))];
    for (const object of VETTING_EVIDENCE_OBJECTS)
      requests.push(
        await request("PUT", `${path}/${object.sha256}`, object.body),
      );
    for (const req of requests) {
      const response = await evidence.handle(req);
      if (!response?.ok)
        throw new Error(
          `Evidence fixture failed ${response?.status}: ${await response?.text()}`,
        );
    }
  }
  return {
    evidence,
    bucket,
    request,
    retain,
    dispose: () => runtime.dispose(),
  };
}
