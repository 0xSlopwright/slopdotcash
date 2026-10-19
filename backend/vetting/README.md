# Community project security vetting

PRD VET-01 to VET-08 and MVP-12. Slop serves no generated skill, lists no
project in `/.well-known/slop/projects.json`, and activates no revision unless
a secure-VM scan cleared that exact revision content. The VM, its collectors
and the two model scanners are external services. This module stores their
signed results and enforces the gate. It fails closed when the service is
absent.

## Tables

`migrations/0025_community_security_vetting.sql` creates:

- `vetting_assessments`: one scan of one exact project revision (project id,
  revision, manifest SHA-256, content SHA-256). States are `pending`,
  `incomplete`, `clean` and `malicious`. A trigger allows exactly one update,
  from `pending` to a result. Rows are never deleted.
- `vetting_artifacts`: the artifact quarantine records of a result (VET-04):
  content hash, parent hash, origin, path, type, quarantine state, analysis
  and requested execution. Rows are immutable. A row is `released` only with
  a clean analysis.

## Clearance

The content SHA-256 is the key-sorted canonical JSON of the manifest with
`status` set to `paused`. A revision is cleared when the newest finished scan
of the unbroken run of revisions with the same content is `clean`. So an
activation revision that changes only the status of a cleared revision keeps
its clearance; any other change needs a new scan (VET-07).

| State | Meaning | Skills, discovery, activation |
|---|---|---|
| `unscanned` | No scan of this content | Blocked |
| `queued` | A scan waits for a result | Blocked |
| `quarantined` | The newest finished scan is `incomplete` | Blocked |
| `cleared` | The newest finished scan is `clean` | Allowed |
| `banned` | Any scan of the project is `malicious` | Blocked; a new scan or commit cannot lift it |

A queued rescan keeps the last finished decision until its result lands.
Reinstatement after a ban belongs to the ADM-06 path (issue #911) and is not
in this module.

## Routes

| Route | Access | Purpose |
|---|---|---|
| `GET /api/v1/admin/vetting` | admin | Service state, clearance of every project, full results |
| `POST /api/v1/admin/vetting/assessments` | admin | Queues a scan of the current revision (`projectId`, `revision`, `reason`) |
| `GET /api/v1/vetting/requests` | signed service | Queued scans with the revision URL and template index URL |
| `POST /api/v1/vetting/results` | signed service | Records one `slop-vetting-result-v1` result |
| `GET /api/v1/projects/:id` | public | Adds the safe `vetting` summary; `skillsPublished` needs `cleared` |

## Service signature

Each service request carries:

- `x-slop-vetting-key`: lowercase SHA-256 of the raw 32-byte Ed25519 public key;
- `x-slop-vetting-timestamp`: ISO UTC time within 5 minutes of the server;
- `x-slop-vetting-signature`: base64 Ed25519 signature of the UTF-8 text
  `slop-vetting:v1\n<METHOD>\n<path and query>\n<timestamp>\n<SHA-256 hex of the body>`.

The Pages variable `VETTING_RESULT_PUBLIC_KEYS` lists the accepted public keys
as comma-separated base64. Slop holds only public keys. A malformed list is
treated as absent. Without a key, the service routes and the queue action
return HTTP 503 `vetting_unavailable`, and `/admin` shows the service as
unavailable.

## Result contract

`backend/vetting/result.ts` parses the result exactly. Unknown, missing or
malformed fields refuse it. The result binds the assessment id, project id,
revision, manifest SHA-256 and repository of the queued scan, the assessed
commit, template commit, input inventory digest, dependency lock digests, VM
provider, isolation, image digest, collector and run ids, the eleven
telemetry channels, visibility gaps, tamper and canary signals, the trace
digest, exactly one Astra and one Opus review with provider, model, prompt
policy, input digest and run id, the artifact quarantine list, findings and
an optional confirmation.

The API never upgrades a result:

- `clean` needs every telemetry channel complete, no visibility gap, no
  tampering, no canary access, both reviews completed on the assessed
  inventory without a malice verdict, every artifact released, and no high or
  critical finding.
- `malicious` needs a `confirmation` with basis `reproducible-behavior` or
  `verified-source-evidence`, a rule id and evidence references. A model
  label alone is refused (VET-06).
- `incomplete` records anything else, without a confirmation.

## What the operator must provide

The repository cannot provide these. Until they exist, no community project
can be cleared, so no project skill is served.

1. A hardware-isolated VM or microVM service that meets VET-02 and VET-03:
   fresh disposable guest, no host mounts or credentials, default-deny egress
   through an instrumented proxy, the eleven telemetry channels, canary
   files, and host and proxy evidence collected outside the guest.
2. Recursive artifact quarantine and analysis outside the guest (VET-04).
3. Pinned Astra-class and Opus-class scanner runs with their own provider
   credentials (VET-05).
4. A trusted policy service, outside the guest and model context, that holds
   the Ed25519 private key, decides the disposition, and signs the result.
5. The public key in the Pages variable `VETTING_RESULT_PUBLIC_KEYS` for each
   environment.
6. A restricted operator console for the full traces, stdout and network
   evidence, with published retention, access and size limits (VET-03).
7. The VET-08 acceptance run of the harmless fixture classes on that
   infrastructure, with its coverage and blind-spot report.
