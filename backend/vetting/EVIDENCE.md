# Restricted vetting evidence

VET-03 uses a separate private `VETTING_EVIDENCE` R2 binding. It does not use
contributor traces, their permanent storage rule, or contributor read grants.
D1 migration 0034 stores immutable object receipts, run policy snapshots, grants
and access audit records. Raw bytes remain outside Git and public responses.

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
No private source paths or URLs belong in public result summaries.

A clean result requires the exact trace, input manifests used by the result and
each reviewer, dependency locks, artifacts and named parent artifacts in the
inventory. Every registered object must exist and pass a complete byte check.
This check also runs for continuing project clearance, activation and skill
publication. Historical metadata-only clean results have no exemption. Dynamic
skills, discovery and public clearance responses use no-store, so an old edge
cache entry cannot bypass expiry or missing evidence. Unrelated raw registry
lists and revision caches retain their existing behavior.

Each complete object is at most 8 MiB; policy may set a lower limit. A run is at
most 64 MiB and 1024 objects. These are bounded inspection limits, not retention
policy defaults. Oversize evidence cannot be shortened or silently omitted to
obtain a clean result. Large VM disk overlays exceed this first console contract;
their complete remote retention remains a separate integration requirement.

Only an authenticated WebSession whose immutable GitHub actor ID appears in the
current operator allowlist may inspect `/vetting-evidence`. Admin, applicant and
project-owner roles do not grant access. The admin assessment links to this
separate console. A reason is required for each object read. The server issues a
60-second, single-use grant bound to that actor, assessment, run and object.
Operator authorization, policy currency, expiry and complete bytes are checked
again at read time. Audit rows retain the actor, reason and action. Grants and
bodies use no-store; bodies use attachment, nosniff and a restrictive CSP. Text
is escaped. Binary downloads never execute.

The registration and operator console work with incomplete assessments. Missing,
corrupt, oversize and expired bodies remain explicit failures. Harmless paused
applications and queue registration remain available without storage; signed
queue acquisition fails closed before work starts if storage policy is absent.
Production binding, policy approval, external controls, actual collector/provider
integration and live acceptance are not performed by this source change.
