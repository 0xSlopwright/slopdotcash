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

The source now includes signed queue acquisition, immutable Git and template
inputs, this isolated analyzer, an offline VM fixture, and private evidence
assembly. These components do not establish a
ready vetting service. General project execution, complete pre-execution and
guest/host/proxy observation, artifact release decisions, actual configured
provider acceptance, trusted publication and operational access still need
their own evidence. Check service readiness before starting a queued scan.
Do not consume a pending assessment merely because some components can run.

The remaining work is not only configuration:

| Requirement | Remaining source or acceptance work | Required operator decision |
| --- | --- | --- |
| VET-02 host | The Linux KVM adapter needs actual acceptance on the intended isolated host. Darwin evidence covers harmless fixtures only. | Designate a patched, dedicated Linux host, unprivileged account, reviewed executable/image pins, resource limits and private retention location. |
| VET-02 project commands | General install, build, test and skill execution is disabled. The present profile runs a fixed harmless command. | Approve the immutable command/runtime profile and adequate resource and coverage limits for each assessed revision. Repository instructions cannot grant that approval. |
| VET-03 observation | Complete structured event collection, loss/tamper detection, independent host/proxy evidence, controlled runtime DNS/HTTP/TLS routing, complete filesystem differences beyond the bounded workspace capture, environment/wallet canaries and full captured-evidence integration remain source gaps. | Select the reviewed Linux collector, network, storage, operator-access and retention contracts. A dependency prefetch is not a runtime proxy. |
| VET-04 artifact review | Format-aware static analysis, provenance/upstream comparison, full artifact lineage and durable release decisions remain source gaps. Existing inspection and denial do not release an artifact. | Name the release authority and exact-digest baseline/review policy. A model label cannot supply authority. |
| VET-04 runtime coverage | The materialized-file gate does not establish complete native, interpreter, bytecode, WASM, JIT or memory-only interception. | Approve supported runtime coverage and the policy for unsupported behavior. Missing coverage must stay incomplete; do not enable arbitrary source on that basis. |

The [restricted store and console](../../backend/vetting/EVIDENCE.md) verify
bounded retained objects. They do not prove complete assembly retention or
external deletion, legal-hold and backup controls. Configuration and live
acceptance remain required.

QEMU was considered for the execution adapter. Its [security
contract](https://www.qemu.org/docs/master/system/security.html) requires a
hardware accelerator and a supported machine. It also requires host privilege
and resource confinement. Software emulation cannot establish guest isolation.
The bounded [offline VM component](VM.md) records actual private boot and
timeout evidence. Its optional profile executes only a privately approved,
content-bound harmless acquired fixture. Its materialized-file gate is not
complete interpreter, JIT or memory interception, and it does not claim VET-02
acceptance on Darwin.

The [assembler](ASSEMBLY.md) can bind that guest receipt to the same signed queue,
source inventory, approved command profile, collector, VM and serial bytes. It
supplies decoded syscall and output bytes once, while retaining the complete raw
serial digest. It keeps trusted coverage gaps even if guest JSON claims success.
It neither invokes providers nor publishes a decision.

The [Bubblewrap project](https://github.com/containers/bubblewrap) explains that
its security depends on the caller's namespace and filesystem configuration.
This component uses separate namespaces and grants only the parser's runtime
and one input file. It must remain separate from signing keys and model clients.
