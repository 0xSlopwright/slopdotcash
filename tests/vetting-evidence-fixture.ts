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
      script: `export default { async fetch(request, env) {
        const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
        if (request.method === "PUT") {
          const options = JSON.parse(request.headers.get("x-r2-options"));
          const value = await env.E.put(key, await request.arrayBuffer(), options);
          return Response.json({ stored: value !== null });
        }
        if (request.method === "DELETE") {
          await env.E.delete(key);
          return new Response(null, { status: 204 });
        }
        const value = request.method === "HEAD"
          ? await env.E.head(key) : await env.E.get(key);
        if (!value) return new Response(null, { status: 404 });
        return new Response(request.method === "HEAD" ? null : value.body, {
          headers: {
            "x-r2-size": String(value.size),
            "x-r2-metadata": JSON.stringify(value.customMetadata ?? {}),
          },
        });
      }} `,
      compatibilityDate: "2026-07-30",
      r2Buckets: ["E"],
    }),
  );
  await runtime.ready;
  // Use asynchronous HTTP to real workerd R2. Miniflare's synchronous RPC
  // property getters can fail under Bun before object metadata is returned.
  const url = (key: string) => `http://evidence/${encodeURIComponent(key)}`;
  async function read(key: string, method: "GET" | "HEAD") {
    const response = await runtime.dispatchFetch(url(key), { method });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`Local R2 read failed: ${response.status}`);
    return {
      size: Number(response.headers.get("x-r2-size")),
      customMetadata: JSON.parse(response.headers.get("x-r2-metadata")!),
      body: response.body,
      arrayBuffer: () => response.arrayBuffer(),
    };
  }
  const bucket = {
    head: (key: string) => read(key, "HEAD"),
    get: (key: string) => read(key, "GET"),
    put: async (...[key, bytes, options]: Parameters<R2Bucket["put"]>) => {
      const response = await runtime.dispatchFetch(url(key), {
        method: "PUT",
        headers: { "x-r2-options": JSON.stringify(options) },
        body: new Uint8Array(bytes),
      });
      if (!response.ok)
        throw new Error(`Local R2 write failed: ${response.status}`);
      const result = (await response.json()) as { stored: boolean };
      return result.stored ? {} : null;
    },
    delete: async (key: string) => {
      const response = await runtime.dispatchFetch(url(key), {
        method: "DELETE",
      });
      if (response.status !== 204)
        throw new Error(`Local R2 delete failed: ${response.status}`);
    },
  };
  const keys = await vettingKeyPair();
  const evidence = new VettingEvidence({
    db,
    bucket: {
      head: (key) => bucket.head(key),
      put: (key, bytes, options) => bucket.put(key, bytes, options),
      // Forward the asynchronous workerd HTTP response stream directly.
      get: async (key) => {
        const value = await bucket.get(key);
        return value
          ? {
              size: value.size,
              customMetadata: value.customMetadata,
              body: value.body!,
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
