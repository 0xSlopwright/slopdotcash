# Restricted vetting evidence

VET-03 uses a separate private `VETTING_EVIDENCE` R2 binding. It does not use
contributor traces, their permanent storage rule, or contributor read grants.
D1 migrations 0034 and 0035 store immutable object receipts, run policy snapshots,
chunk layouts, completion records, grants and access audit records. Raw bytes remain outside Git and public responses.

The service is inactive without the bucket and `VETTING_EVIDENCE_POLICY` JSON.
The deployment authority must supply all policy fields: `version`,
`policyAuthorityGithubId`, `operatorGithubIds`, `accessDurationSeconds`,
`maxObjectBytes`, `maxRunBytes`, `maxObjects`, `accessPolicyReference`,
`retentionPolicyReference`, `recoveryPolicyReference`, and `externalControls`.
The external-controls record requires `attestedByGithubId` equal to the configured
policy authority, `evidenceReference`, `attestedAt`, and `validUntil`. Its time
window must be current. These values come from trusted deployment configuration,
not from a service upload or browser request. No production policy values or
operator identities are selected by this change.

The attestation is an operator assertion. This application does not automatically
verify or execute physical deletion, legal holds, backup, or recovery. Those
controls remain external or unresolved. Access expiry is enforced independently;
it is not proof of physical retention compliance. VET-03 acceptance stays open
until the responsible humans approve and demonstrate those controls. Policy
references must identify the approved public access and retention terms; private
operational evidence must not be published with those terms.

## Write and inspect exact bytes

The existing signed vetting service registers an immutable object inventory at
`POST /api/v1/vetting/evidence/:assessment/:run`. The body contains `traceSha256`
and `objects`, each with `sha256`, `sizeBytes`, `kind`, `label`, and `contentType`.
The assessment must already exist. The run is the exact `environment.runId` of
the result. Each body is then uploaded to the same path plus `/:sha256` with PUT.
The signed method, path, timestamp and body prevent cross-route replay. Repeating
the same inventory is safe; changing it under the same run identity is refused.
The object write is create-only. The server reads back complete bytes and checks
the digest and length before it records success.

This inventory is a storage receipt, not another scan or assembly format. Retain
the existing `slop-evidence-assembly-v1` manifest and its exact input files without
rewriting them. The service must retain the full packaged source, dependency,
collector, lineage and artifact evidence that its assembly references. Source Git
object identities and captured dependency SHA-256 identities remain distinct.
The current receipt check does not parse the assembly manifest and recursively
prove that all its referenced source, runtime overlay and nested evidence files
are stored. That automatic assembly-closure integration is still missing source
work. A configured store or available service key does not close this gate.
The actual assembly remains incomplete and authorizes no provider calls or result
publication. No private source paths or URLs belong in public result summaries.

A clean result requires the exact trace, input manifests used by the result and
each reviewer, dependency locks, artifacts and named parent artifacts in the
inventory. Every registered object must exist and pass a complete byte check.
This check also runs for continuing project clearance, activation and skill
publication. Historical metadata-only clean results have no exemption. Dynamic
skills, discovery and public clearance responses use no-store, so an old edge
cache entry cannot bypass expiry or missing evidence. Unrelated raw registry
lists and revision caches retain their existing behavior.

Each upload part is at most 8 MiB. A complete object and run are at most 64 MiB,
and a run has at most 1024 objects. Explicit policy can set lower limits; there
are no live policy defaults. The current transport can retain the actual 23.6 MB
fixture overlay. It does not claim support for the assembler's 2 GiB ceiling.
Oversize evidence cannot be shortened or silently omitted to obtain clearance.

Objects above 8 MiB declare `chunks` in their immutable object receipt. Each entry
has `index`, `sha256` and `sizeBytes`. Indices start at zero, parts are exactly
8 MiB except the final remainder, and the total equals the original object size.
This is a transport layout, not a new evidence format. The original whole-file
SHA-256 remains authoritative. Upload each part with a signed PUT to
`/:sha256/chunks/:index`; retrying exact bytes is safe. An existing conflicting
part is never overwritten. POST the signed exact body `{}` to
`/:sha256/finalize`. Finalization reads parts sequentially, verifies each, and
hashes their original bytes in order with the pinned incremental SHA-256 code.
It never substitutes a hash of hashes or an R2 ETag. The completion record and
its audit commit in one D1 transaction. An interrupted upload or a missing,
changed or wrong-whole-digest part cannot produce completion. Retry the same
immutable upload/finalization; a different layout requires a new run.

Verification and download hold at most one 8 MiB part buffer at a time. Download
backpressure controls part reads. Current authorization and access expiry are
checked again as each part is read. Complete clearance rechecks retained bytes;
a completion receipt alone is not evidence that R2 objects still exist.

Only an authenticated WebSession whose immutable GitHub actor ID appears in the
current operator allowlist may inspect `/vetting-evidence`. Admin, applicant and
project-owner roles do not grant access. The admin assessment links to this
separate console. A reason is required for each object read. The server issues a
60-second, single-use grant bound to that actor, assessment, run and object.
Operator authorization, policy currency, expiry and complete bytes are checked
again at read time. Audit rows retain the actor, reason and action. Grants and
bodies use no-store; bodies use attachment, nosniff and a restrictive CSP. Text
is escaped. Binary downloads never execute.

Large downloads use a dedicated JSON POST `/:sha256/download-grant`. It returns
no token in JSON or a URL. The server sets `__Secure-vetting-read-grant` as a
Secure, HttpOnly, SameSite=Strict, host-only cookie with the exact native download
path and a 60-second lifetime. The browser follows `/:sha256/download` as an
attachment. GET requires `Sec-Fetch-Site: same-origin`, current session/operator
policy and the actor/object-bound single-use grant. Duplicate grant cookies,
ranges and HEAD are refused. The cookie is cleared on a native download attempt.
The site's CSP stays unchanged. Small text inspection keeps the existing header
grant and bounded client digest check.

Audit distinguishes download authorization, start, server stream finish,
cancellation and failure. Server finish does not prove the browser saved the
file. Failure to record the final audit errors the stream; it never hangs or
silently succeeds. A cancelled or failed transfer needs a new reason and grant.
The UI reports that a download was requested, not that the browser saved it.

The registration and operator console work with incomplete assessments. Missing,
corrupt, oversize and expired bodies remain explicit failures. Harmless paused
applications and queue registration remain available without storage; signed
queue acquisition fails closed before work starts if storage policy is absent.
Production binding, policy approval, external controls, actual collector/provider
integration and live acceptance are not performed by this source change.
