# Isolated artifact inventory

PRD VET-04 and MVP-12 require recursive artifact inspection before execution.
The result API stores supplied records but does not inspect artifact bytes.
`artifacts.py` adds that inspection step. It never executes or releases input.

Run on an unprivileged, dedicated Linux analysis host with Python 3.12 or later
and Bubblewrap 0.9 or later:

```sh
python3 workers/vetting/artifacts.py /private/quarantine/object
python3 workers/vetting/artifacts_workflow_test.py
```

Treat stdout as private evidence. Paths and hashes can identify private source.
Do not publish it. The caller must store the input and result under the approved
private retention and access policy. No network request or assessment update
occurs. A missing sandbox cannot consume a pending assessment.

The launcher copies at most 32 MiB from a regular file without following its
final symlink. The parser receives only that copy, its own source, and the
read-only system runtime. It runs in separate user, process, mount and network
namespaces. It has no home mount, host network, inherited environment, device
passthrough or additional user namespace. Its input is read-only. The host must
keep credentials and private files out of `/usr` and `/lib`.

The parser hashes each file and records its parent hash and member path. It
reads ZIP and TAR members in memory; it never extracts them to disk. It rejects
links, special files, encrypted ZIP members, duplicate paths and path traversal.
It limits recursive depth to 6, records to 1,024 and total expanded bytes to
64 MiB. The parser has a 256 MiB address limit, 10 CPU seconds and no output-file
allowance. The launcher limits wall time to 15 seconds and output to 2 MiB.
Failure returns an `incomplete` result and a nonzero exit, with no partial
inventory. Archive problems appear in `visibilityGaps`; all records remain
`quarantined`, including ordinary text and recognized native, script and WASM
files. Unknown formats cannot receive automatic approval.

Use the distribution's maintained Bubblewrap/AppArmor policy. Ubuntu 24.04
provides `bwrap-userns-restrict` in the `apparmor-profiles` package. A host that
blocks namespace creation fails closed. Do not disable its global security
controls to make a scan pass. The operational host needs a reviewed sandbox
policy and patched runtime. A namespace isolates this parser; it does not meet
the separate hardware VM execution requirement in VET-02.

## Workflow evidence

The test invokes the real CLI and real Bubblewrap process. It uses harmless
nested archives with a shell payload that would create a sentinel if executed,
and a WASM header. It checks the exact hashes and parent links, and that the
sentinel is absent. Other inputs exercise archive traversal, symbolic links,
expansion and recursion limits. A separate probe in the same namespace setup
attempts to read a synthetic host secret, overwrite the input and contact a
real listener outside the namespace. All three attempts must fail. A missing
sandbox must return incomplete without records.

These are component tests. They do not prove interception of package hooks,
native loading or a second-stage download inside a project VM.

## Work still required for issue 909

The current repository still needs the immutable acquisition and queue runner,
a disposable execution VM with host resource confinement, pre-execution
interception, all required guest/host/proxy collectors, network proxy policy,
artifact provenance and release decisions, actual independent Astra and Opus
clients, the trusted result publisher, and the restricted trace console.
Configuration and deployment follow source completion. Do not submit an
incomplete assessment merely because those services are absent: check service
readiness before starting a queued scan.

QEMU was considered for the execution adapter. Its [security
contract](https://www.qemu.org/docs/master/system/security.html) requires a
hardware accelerator and a supported machine. It also requires host privilege
and resource confinement. Software emulation cannot establish guest isolation.
A QEMU command line by itself would not complete this service, so this change
does not add an unverified VM launcher or claim VET-02 acceptance.

The [Bubblewrap project](https://github.com/containers/bubblewrap) explains that
its security depends on the caller's namespace and filesystem configuration.
This component uses separate namespaces and grants only the parser's runtime
and one input file. It must remain separate from signing keys and model clients.
