# Controlled dependency capture

This component implements the bounded offline fetch pass in VET-03/MVP-12. It
fetches only an operator-reviewed list of exact HTTPS URLs and SHA-256 digests.
It never resolves a package version, follows a redirect, sends credentials,
opens a guest network device, or grants execution permission.

The operator supplies a private JSON profile with exactly these fields:

- `schema`: `slop-dependency-fetch-profile-v1`.
- `sourceInventorySha256`: digest of the acquired source inventory.
- `caBundleSha256`: digest of the reviewed PEM certificate authority bundle.
- `dependencies`: one to 16 entries, each with `url`, `sha256`, and `maxBytes`.

Each byte limit must be at most 8 MiB. The sum must be at most 32 MiB. URLs must
use HTTPS, a lowercase DNS hostname, the default port, and an explicit path.
User information, queries, fragments, IP literals and alternate numeric hosts
are refused. The expected digest must come from reviewed lock/provenance
information; do not approve a digest merely because this downloader produced it.

Run on the isolated Linux security host with Python 3, Bubblewrap and the
existing artifact analyzer available:

```text
python3 workers/vetting/dependencies.py PROFILE PROFILE_SHA256 SOURCE_INVENTORY CA_BUNDLE NEW_OUTPUT_DIRECTORY
```

The profile digest is an independent operator input. The profile binds the
source inventory and trust bundle. The transport resolves all address answers
once, rejects the complete answer set if any address is not permitted, and
connects to one validated address without a second name lookup. TLS still
checks the original hostname and certificate chain. Private, link-local,
metadata, multicast, reserved and address-translation destinations are refused.
Special-use ranges are also blocked across older Python address classifiers.
Only a fixed GET request is sent. No proxy environment, cookies, authorization,
CONNECT, compressed transfer or custom protocol is used. Redirect responses
are retained as private metadata and refused. A successful response must have
one bounded Content-Length and the exact reviewed digest.

Each transport runs in a separate bounded process with a 30-second wall limit,
5-second socket/DNS limits, memory/CPU limits and an 8 MiB output limit. Captured
bytes pass through the existing isolated `artifacts.py` analyzer. A parser
failure cannot create a completed inventory. The deployment must support the
analyzer's existing unprivileged namespace confinement; do not disable global
security controls to make the workflow pass.

## Private evidence

`inventory.json` has schema `slop-dependency-inventory-v1`, state `quarantined`,
source/profile/CA digests, `executionAuthorized: false`, records and visibility
gaps. Each record binds the exact object and isolated inspection report by
path and digest. It also records the URL, DNS answers, actual destination,
TLS version, HTTP status, byte count and timestamps. Selected response metadata
is limited to 64 KiB. Overflow retains its digest and size with an explicit
missing-header gap, then fails; it never truncates metadata into a successful run. Objects use
`objects/<sha256>`; reports use `inspections/<sha256>.json`. Dependency provenance
is separate from Git blob provenance. These records must not be inserted into
the Git source inventory.

A failed run has no `inventory.json`. It retains `failure.json`, the private
profile, bounded captured objects under their actual hashes, and available
request/response observations. A mismatching digest or partial response is
useful evidence and is not discarded. Its state is `incomplete`, with
`executionAuthorized: false`. Terminal output contains only fixed failure
reasons. Retain this evidence through the private evidence store; do not publish
URLs, response data or artifact contents.

This fetcher is not a transparent runtime proxy. Dynamic package installation,
TLS-pinned/custom/opaque protocols, dependency extraction, release decisions,
and arbitrary guest consumption remain unsupported. The VM must remain offline.
No result can claim full VET-03/VET-04 coverage from this pass. An assembler must
verify manifest/object/report digests and retain every visibility gap before it
uses this evidence. Successful download or static inspection is not clearance.

## Real network workflow

`dependencies_workflow_test.py` runs inside a disposable Linux VM and new network
and mount namespaces. It requires root only to create that isolated fixture;
the actual fetcher and analyzer run as UID 65534. The namespace has no default
route. Its own DNS and HTTPS servers use a locally assigned public-form address,
a short-lived fixture certificate, and a namespace-private resolver file. The
production code has no fixture address, certificate or DNS bypass.

```text
sudo unshare --mount --net --fork python3 workers/vetting/dependencies_workflow_test.py
```

The workflow proves actual TLS fetch plus isolated analysis, changed DNS answers
without a second transport lookup, mixed public/private answers, IPv4/IPv6
special ranges, direct and encoded numeric hosts, metadata destinations,
redirect refusal, TLS hostname mismatch, content changes, size/encoding limits,
timeouts and partial-byte retention. It also proves that unavailable analyzer
confinement produces incomplete evidence. No downloaded dependency executes.

On the disposable Ubuntu fixture, install `bubblewrap apparmor-profiles` and
load the distro-maintained `/usr/share/apparmor/extra-profiles/bwrap-userns-restrict`
profile if needed. Keep `kernel.apparmor_restrict_unprivileged_userns=1`. This is
an executable-scoped fixture prerequisite, not permission to change host policy.
See [Ubuntu's per-application namespace policy](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)
and [Python's HTTPS transport contract](https://docs.python.org/3/library/http.client.html).
