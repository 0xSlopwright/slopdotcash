/** Separate private vetting evidence. Policy and external controls have no defaults. */

import type { ProjectD1Database } from "../projects/cloudflare-persistence";
import type { WebSession } from "../projects/contracts";
import type { R2Bucket } from "../trace/cloudflare-persistence";
import { isRecord, readJsonObject, sha256Hex } from "../trace/validation";
import type { VettingResult } from "./result";

// A bounded complete object fits the existing Workers memory/read contract.
// Larger objects remain uninspectable; they must never count as retained evidence.
export const MAX_EVIDENCE_OBJECT_BYTES = 8 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/u;
const ID = /^[a-zA-Z0-9_-]{1,100}$/u;
const KINDS = new Set([
  "trace",
  "stdout",
  "stderr",
  "network",
  "artifact",
  "lineage",
  "manifest",
  "disk-diff",
]);
export type EvidencePolicy = {
  version: string;
  policyAuthorityGithubId: string;
  operatorGithubIds: string[];
  accessDurationSeconds: number;
  maxObjectBytes: number;
  maxRunBytes: number;
  maxObjects: number;
  accessPolicyReference: string;
  retentionPolicyReference: string;
  recoveryPolicyReference: string;
  externalControls: {
    evidenceReference: string;
    attestedByGithubId: string;
    attestedAt: string;
    validUntil: string;
  };
};
function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join() !== keys.sort().join())
    fail(400, "invalid_request", "Unexpected evidence fields");
}
function text(value: unknown, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(400, "invalid_request", "Invalid evidence text");
  return value;
}
export function evidencePolicy(
  raw: string | undefined,
  now: Date,
): EvidencePolicy | null {
  try {
    const p = JSON.parse(raw ?? "null");
    if (!isRecord(p)) return null;
    exact(p, [
      "version",
      "policyAuthorityGithubId",
      "operatorGithubIds",
      "accessDurationSeconds",
      "maxObjectBytes",
      "maxRunBytes",
      "maxObjects",
      "accessPolicyReference",
      "retentionPolicyReference",
      "recoveryPolicyReference",
      "externalControls",
    ]);
    text(p.version, 100);
    if (
      typeof p.policyAuthorityGithubId !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(p.policyAuthorityGithubId)
    )
      return null;
    for (const key of [
      "accessPolicyReference",
      "retentionPolicyReference",
      "recoveryPolicyReference",
    ])
      text(p[key]);
    if (
      !Array.isArray(p.operatorGithubIds) ||
      !p.operatorGithubIds.length ||
      p.operatorGithubIds.some(
        (v) => typeof v !== "string" || !/^[1-9][0-9]{0,19}$/u.test(v),
      )
    )
      return null;
    for (const key of [
      "accessDurationSeconds",
      "maxObjectBytes",
      "maxRunBytes",
      "maxObjects",
    ])
      if (!Number.isSafeInteger(p[key]) || Number(p[key]) < 1) return null;
    if (
      Number(p.maxObjectBytes) > MAX_EVIDENCE_OBJECT_BYTES ||
      Number(p.maxRunBytes) > 64 * 1024 * 1024 ||
      Number(p.maxObjects) > 1024 ||
      Number(p.maxRunBytes) < Number(p.maxObjectBytes)
    )
      return null;
    const controls = p.externalControls;
    if (!isRecord(controls)) return null;
    exact(controls, [
      "evidenceReference",
      "attestedByGithubId",
      "attestedAt",
      "validUntil",
    ]);
    text(controls.evidenceReference);
    if (controls.attestedByGithubId !== p.policyAuthorityGithubId) return null;
    const from = Date.parse(String(controls.attestedAt)),
      until = Date.parse(String(controls.validUntil));
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(until) ||
      from > now.getTime() ||
      until <= now.getTime() ||
      until <= from
    )
      return null;
    if (
      !Number.isFinite(
        new Date(
          now.getTime() + Number(p.accessDurationSeconds) * 1000,
        ).getTime(),
      )
    )
      return null;
    return p as EvidencePolicy;
  } catch {
    return null;
  }
}
export type EvidenceDependencies = {
  db: ProjectD1Database;
  bucket: R2Bucket | undefined;
  policy: string | undefined;
  session?: (request: Request) => Promise<WebSession | null>;
  now: () => Date;
  randomId: () => string;
  signed?: (
    request: Request,
    maximum: number,
  ) => Promise<{ body: Uint8Array; keySha256: string }>;
};
type Run = {
  assessment_id: string;
  run_id: string;
  trace_sha256: string;
  manifest_sha256: string;
  manifest: string;
  policy: string;
  created_at: string;
  expires_at: string;
};
type ObjectRow = {
  assessment_id: string;
  run_id: string;
  sha256: string;
  size_bytes: number;
  kind: string;
  label: string;
  content_type: string;
  object_key: string;
};
const headers = {
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers });
export class VettingEvidence {
  constructor(readonly deps: EvidenceDependencies) {}
  private signed(request: Request, maximum: number) {
    if (!this.deps.signed)
      fail(
        503,
        "service_unavailable",
        "Vetting evidence upload is unavailable",
      );
    return this.deps.signed(request, maximum);
  }
  ready() {
    return Boolean(
      this.deps.bucket && evidencePolicy(this.deps.policy, this.deps.now()),
    );
  }
  configuration() {
    const policy = evidencePolicy(this.deps.policy, this.deps.now());
    if (!this.deps.bucket || !policy)
      fail(
        503,
        "evidence_unavailable",
        "Vetting evidence requires a private bucket, explicit policy and current operator attestation of external retention and recovery controls",
      );
    return { policy, bucket: this.deps.bucket };
  }
  async audit(
    actor: string,
    action: string,
    assessment: string,
    run: string | null = null,
    sha: string | null = null,
    reason: string | null = null,
  ) {
    await this.deps.db
      .prepare(
        "INSERT INTO vetting_evidence_audit(id,actor,action,assessment_id,run_id,sha256,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        this.deps.randomId(),
        actor,
        action,
        assessment,
        run,
        sha,
        reason,
        this.deps.now().toISOString(),
      )
      .run();
  }
  async operator(request: Request) {
    const actor = await this.deps.session?.(request);
    if (!actor) fail(401, "unauthorized", "Sign in with GitHub");
    const { policy } = this.configuration();
    if (!policy.operatorGithubIds.includes(actor.githubId))
      fail(403, "forbidden", "Designated vetting operator access is required");
    return actor;
  }
  async run(assessment: string, run: string): Promise<Run> {
    const row = await this.deps.db
      .prepare(
        "SELECT * FROM vetting_evidence_runs WHERE assessment_id=? AND run_id=?",
      )
      .bind(assessment, run)
      .first<Run>();
    if (!row) fail(404, "evidence_missing", "Evidence run is missing");
    return row;
  }
  async object(
    assessment: string,
    run: string,
    sha: string,
  ): Promise<ObjectRow> {
    const row = await this.deps.db
      .prepare(
        "SELECT * FROM vetting_evidence_objects WHERE assessment_id=? AND run_id=? AND sha256=?",
      )
      .bind(assessment, run, sha)
      .first<ObjectRow>();
    if (!row) fail(404, "evidence_missing", "Evidence object is missing");
    return row;
  }
  async bytes(row: ObjectRow, run: Run): Promise<Uint8Array> {
    const { policy, bucket } = this.configuration();
    if (Date.parse(run.expires_at) <= this.deps.now().getTime())
      fail(
        410,
        "evidence_expired",
        "Evidence access expired; physical retention is governed separately",
      );
    if (row.size_bytes > policy.maxObjectBytes)
      fail(
        413,
        "evidence_oversize",
        "Complete evidence exceeds the current inspection limit",
      );
    const value = await bucket.get(row.object_key);
    if (!value)
      fail(404, "evidence_missing", "Declared evidence bytes are missing");
    if (
      value.size !== row.size_bytes ||
      value.customMetadata?.sha256 !== row.sha256
    )
      fail(
        409,
        "evidence_corrupt",
        "Evidence metadata does not match its immutable receipt",
      );
    const reader = value.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > row.size_bytes) {
          await reader.cancel();
          fail(409, "evidence_corrupt", "Evidence length changed");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    if (size !== row.size_bytes || (await sha256Hex(bytes)) !== row.sha256)
      fail(409, "evidence_corrupt", "Evidence digest changed");
    return bytes;
  }
  async complete(result: VettingResult) {
    const assessment = result.assessmentId,
      runId = result.environment.runId,
      traceSha = result.traceSha256;
    try {
      const run = await this.run(assessment, runId);
      if (run.trace_sha256 !== traceSha) return false;
      const objects =
        (
          await this.deps.db
            .prepare(
              "SELECT * FROM vetting_evidence_objects WHERE assessment_id=? AND run_id=?",
            )
            .bind(assessment, runId)
            .all<ObjectRow>()
        ).results ?? [];
      const inventory = new Set(objects.map((object) => object.sha256));
      const required = [
        traceSha,
        result.assessed.inputManifestSha256,
        ...result.modelReviews.map((review) => review.inputManifestSha256),
        ...result.assessed.dependencyLocks.map((lock) => lock.sha256),
        ...result.artifacts.flatMap((artifact) => [
          artifact.sha256,
          ...(artifact.parentSha256 ? [artifact.parentSha256] : []),
        ]),
      ];
      if (required.some((digest) => !inventory.has(digest))) return false;
      for (const row of objects) await this.bytes(row, run);
      return true;
    } catch {
      return false;
    }
  }
  async register(request: Request, assessment: string, runId: string) {
    const { policy } = this.configuration();
    const { body, keySha256 } = await this.signed(request, 1024 * 1024);
    let input: unknown;
    try {
      input = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(body),
      );
    } catch {
      fail(
        400,
        "invalid_request",
        "Evidence manifest must be valid UTF-8 JSON",
      );
    }
    if (!isRecord(input))
      fail(400, "invalid_request", "Evidence manifest must be an object");
    exact(input, ["traceSha256", "objects"]);
    if (
      typeof input.traceSha256 !== "string" ||
      !HEX.test(input.traceSha256) ||
      !Array.isArray(input.objects) ||
      !input.objects.length ||
      input.objects.length > policy.maxObjects
    )
      fail(400, "invalid_request", "Invalid evidence manifest");
    const exists = await this.deps.db
      .prepare("SELECT id FROM vetting_assessments WHERE id=?")
      .bind(assessment)
      .first();
    if (!exists) fail(404, "not_found", "Assessment not found");
    let total = 0;
    const seen = new Set<string>();
    const objects = input.objects
      .map((value) => {
        if (!isRecord(value))
          fail(400, "invalid_request", "Invalid evidence object");
        exact(value, ["sha256", "sizeBytes", "kind", "label", "contentType"]);
        const sha = text(value.sha256, 64),
          kind = text(value.kind, 20),
          label = text(value.label, 200),
          contentType = text(value.contentType, 80);
        if (
          !HEX.test(sha) ||
          seen.has(sha) ||
          !KINDS.has(kind) ||
          ![
            "text/plain",
            "application/x-ndjson",
            "application/json",
            "application/octet-stream",
          ].includes(contentType) ||
          !Number.isSafeInteger(value.sizeBytes) ||
          Number(value.sizeBytes) < 0
        )
          fail(400, "invalid_request", "Invalid or duplicate evidence object");
        if (Number(value.sizeBytes) > policy.maxObjectBytes)
          fail(
            413,
            "evidence_oversize",
            "Complete object exceeds the configured limit; the run is not inspectable",
          );
        total += Number(value.sizeBytes);
        seen.add(sha);
        return {
          sha256: sha,
          sizeBytes: Number(value.sizeBytes),
          kind,
          label,
          contentType,
        };
      })
      .sort((a, b) => a.sha256.localeCompare(b.sha256));
    if (total > policy.maxRunBytes)
      fail(
        413,
        "evidence_oversize",
        "Complete run exceeds the configured limit",
      );
    if (
      !objects.some((o) => o.kind === "trace" && o.sha256 === input.traceSha256)
    )
      fail(400, "invalid_request", "The exact trace object must be declared");
    const manifest = JSON.stringify({
        traceSha256: input.traceSha256,
        objects,
      }),
      digest = await sha256Hex(new TextEncoder().encode(manifest));
    const previous = await this.deps.db
      .prepare(
        "SELECT manifest_sha256 FROM vetting_evidence_runs WHERE assessment_id=? AND run_id=?",
      )
      .bind(assessment, runId)
      .first<{ manifest_sha256: string }>();
    if (previous) {
      if (previous.manifest_sha256 !== digest)
        fail(
          409,
          "evidence_conflict",
          "Evidence run already binds different bytes",
        );
      return json(200, { manifestSha256: digest, replayed: true });
    }
    const at = this.deps.now();
    await this.deps.db.batch([
      this.deps.db
        .prepare(
          "INSERT INTO vetting_evidence_runs(assessment_id,run_id,trace_sha256,manifest_sha256,manifest,policy,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          assessment,
          runId,
          input.traceSha256,
          digest,
          manifest,
          JSON.stringify(policy),
          at.toISOString(),
          new Date(
            at.getTime() + policy.accessDurationSeconds * 1000,
          ).toISOString(),
        ),
      ...objects.map((o) =>
        this.deps.db
          .prepare(
            "INSERT INTO vetting_evidence_objects(assessment_id,run_id,sha256,size_bytes,kind,label,content_type,object_key) VALUES(?,?,?,?,?,?,?,?)",
          )
          .bind(
            assessment,
            runId,
            o.sha256,
            o.sizeBytes,
            o.kind,
            o.label,
            o.contentType,
            `vetting/${assessment}/${runId}/${o.sha256}`,
          ),
      ),
      this.deps.db
        .prepare(
          "INSERT INTO vetting_evidence_audit(id,actor,action,assessment_id,run_id,created_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          this.deps.randomId(),
          `service:${keySha256}`,
          "register",
          assessment,
          runId,
          at.toISOString(),
        ),
    ]);
    return json(201, { manifestSha256: digest });
  }
  async upload(
    request: Request,
    assessment: string,
    runId: string,
    sha: string,
  ) {
    const { policy, bucket } = this.configuration();
    const { body, keySha256 } = await this.signed(
      request,
      policy.maxObjectBytes,
    );
    const run = await this.run(assessment, runId),
      object = await this.object(assessment, runId, sha);
    if (Date.parse(run.expires_at) <= this.deps.now().getTime())
      fail(410, "evidence_expired", "Evidence upload expired");
    if (
      body.byteLength !== object.size_bytes ||
      (await sha256Hex(body)) !== sha
    )
      fail(
        422,
        "digest_mismatch",
        "Upload must match the complete declared bytes",
      );
    await bucket.put(object.object_key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: object.content_type },
      customMetadata: { sha256: sha },
    });
    await this.bytes(object, run);
    await this.audit(`service:${keySha256}`, "upload", assessment, runId, sha);
    return json(200, { sha256: sha, sizeBytes: body.byteLength });
  }
  async overview(request: Request) {
    const actor = await this.operator(request);
    const query = new URL(request.url).searchParams;
    const assessment = query.get("assessmentId"),
      runId = query.get("runId");
    const runs: Run[] = [];
    if (assessment !== null || runId !== null) {
      if (!ID.test(assessment ?? "") || !ID.test(runId ?? ""))
        fail(
          400,
          "invalid_request",
          "Enter the exact assessment and run identity",
        );
      runs.push(await this.run(String(assessment), String(runId)));
    }
    const { bucket, policy } = this.configuration();
    const result = [];
    for (const run of runs) {
      const rows =
        (
          await this.deps.db
            .prepare(
              "SELECT * FROM vetting_evidence_objects WHERE assessment_id=? AND run_id=? ORDER BY kind,sha256",
            )
            .bind(run.assessment_id, run.run_id)
            .all<ObjectRow>()
        ).results ?? [];
      const objects = [];
      for (const row of rows) {
        const head = await bucket.head(row.object_key);
        const state =
          Date.parse(run.expires_at) <= this.deps.now().getTime()
            ? "expired"
            : row.size_bytes > policy.maxObjectBytes
              ? "oversize"
              : !head
                ? "missing"
                : head.size !== row.size_bytes ||
                    head.customMetadata?.sha256 !== row.sha256
                  ? "corrupt"
                  : "stored-unverified";
        objects.push({
          sha256: row.sha256,
          sizeBytes: row.size_bytes,
          kind: row.kind,
          label: row.label,
          contentType: row.content_type,
          state,
        });
      }
      result.push({
        assessmentId: run.assessment_id,
        runId: run.run_id,
        traceSha256: run.trace_sha256,
        manifestSha256: run.manifest_sha256,
        createdAt: run.created_at,
        expiresAt: run.expires_at,
        policy: JSON.parse(run.policy),
        objects,
      });
    }
    await this.audit(
      actor.githubId,
      "list",
      "*",
      null,
      null,
      "Inspect registered vetting evidence",
    );
    return json(200, {
      runs: result,
      policy,
      retentionBoundary:
        "Access expiry is enforced here. Physical retention, legal holds and backups are external, operator-attested controls; this console does not verify or execute them.",
    });
  }
  async grant(
    request: Request,
    assessment: string,
    runId: string,
    sha: string,
  ) {
    const actor = await this.operator(request),
      body = await readJsonObject(request);
    exact(body, ["reason"]);
    const reason = text(body.reason);
    if (reason.trim().length < 8)
      fail(
        400,
        "invalid_request",
        "Explain why access is needed (8 to 500 characters)",
      );
    const run = await this.run(assessment, runId),
      object = await this.object(assessment, runId, sha);
    // Do not grant access to absent, expired, oversized or changed evidence.
    await this.bytes(object, run);
    const token = crypto.randomUUID() + crypto.randomUUID(),
      hash = await sha256Hex(new TextEncoder().encode(token));
    await this.deps.db.batch([
      this.deps.db
        .prepare(
          "INSERT INTO vetting_evidence_grants(token_hash,assessment_id,run_id,sha256,operator_github_id,reason,expires_at) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          hash,
          assessment,
          runId,
          sha,
          actor.githubId,
          reason,
          new Date(this.deps.now().getTime() + 60_000).toISOString(),
        ),
      this.deps.db
        .prepare(
          "INSERT INTO vetting_evidence_audit(id,actor,action,assessment_id,run_id,sha256,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          this.deps.randomId(),
          actor.githubId,
          "grant",
          assessment,
          runId,
          sha,
          reason,
          this.deps.now().toISOString(),
        ),
    ]);
    return json(201, { grant: token, expiresInSeconds: 60 });
  }
  async read(request: Request, assessment: string, runId: string, sha: string) {
    const actor = await this.operator(request),
      token = request.headers.get("x-vetting-read-grant") ?? "";
    if (token.length > 100) fail(403, "grant_invalid", "Invalid read grant");
    const hash = await sha256Hex(new TextEncoder().encode(token)),
      at = this.deps.now().toISOString();
    const grant = await this.deps.db
      .prepare(
        "UPDATE vetting_evidence_grants SET consumed_at=? WHERE token_hash=? AND assessment_id=? AND run_id=? AND sha256=? AND operator_github_id=? AND consumed_at IS NULL AND expires_at>? RETURNING reason",
      )
      .bind(at, hash, assessment, runId, sha, actor.githubId, at)
      .first<{ reason: string }>();
    if (!grant)
      fail(
        403,
        "grant_invalid",
        "Read grant is expired, used or belongs to another operator or object",
      );
    await this.audit(
      actor.githubId,
      "read-attempt",
      assessment,
      runId,
      sha,
      grant.reason,
    );
    const run = await this.run(assessment, runId),
      object = await this.object(assessment, runId, sha),
      bytes = await this.bytes(object, run);
    await this.audit(
      actor.githubId,
      "read",
      assessment,
      runId,
      sha,
      grant.reason,
    );
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        ...headers,
        "content-type": object.content_type,
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="${sha}.bin"`,
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  }
  async handle(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname
      .split("/")
      .filter(Boolean)
      .slice(2);
    const service = path[0] === "vetting" && path[1] === "evidence",
      operator = path[0] === "operator" && path[1] === "vetting-evidence";
    if (!service && !operator) return null;
    try {
      if (
        operator &&
        request.method !== "GET" &&
        (request.headers.get("origin") !== new URL(request.url).origin ||
          request.headers.get("content-type")?.split(";")[0] !==
            "application/json")
      )
        fail(403, "origin_forbidden", "Requests must come from this site");
      if (operator && path.length === 2 && request.method === "GET")
        return await this.overview(request);
      const [, , assessment, run, sha, action] = path;
      if (!ID.test(assessment ?? "") || !ID.test(run ?? ""))
        fail(404, "not_found", "Evidence route not found");
      if (service && path.length === 4 && request.method === "POST")
        return await this.register(request, assessment, run);
      if (!HEX.test(sha ?? ""))
        fail(404, "not_found", "Evidence route not found");
      if (service && path.length === 5 && request.method === "PUT")
        return await this.upload(request, assessment, run, sha);
      if (
        operator &&
        path.length === 6 &&
        action === "grant" &&
        request.method === "POST"
      )
        return await this.grant(request, assessment, run, sha);
      if (
        operator &&
        path.length === 6 &&
        action === "body" &&
        request.method === "GET"
      )
        return await this.read(request, assessment, run, sha);
      return json(404, { error: "not_found" });
    } catch (error) {
      const e = error as { status?: number; code?: string; message?: string };
      const status = e.status ?? 500;
      return json(status, {
        error:
          status === 500 ? "evidence_failure" : (e.code ?? "evidence_failure"),
        message: status === 500 ? "Evidence operation failed" : e.message,
      });
    }
  }
}
