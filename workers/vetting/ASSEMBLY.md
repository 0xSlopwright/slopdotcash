# Private evidence assembly

VET-04 and VET-05 require both reviewers to inspect the same retained evidence.
`assembleEvidence` joins the signed queue acquisition, isolated artifact reports,
and offline VM output. It verifies file bytes against their SHA-256 digests
before it creates `review-input.json` and `manifest.json` in a new private
subdirectory. The review input uses the scanner transport contract. The manifest
binds that exact input, the queue assignment, and the inspected files.

The caller supplies the acquisition directory and digest, one isolated analyzer
report per distinct acquired object, the actual VM evidence directory and digest,
and an existing private output parent. Run `artifacts.py` in its required Linux
namespace for each acquired object. Do not manufacture analyzer reports from
file extensions or parse hostile archives in the scheduler. Keep the acquisition,
artifact and runtime directories with the output; the manifest does not replace
those private evidence stores. The runtime overlay is verified as a stream and
retained in its original runtime directory. Never publish this evidence.

The assembly rejects a changed object, mismatched report, missing inspection,
symlink input, invalid serial encoding, or input too large for the bounded review.
It does not shorten source or silently omit text. Binary bytes and nested archive
contents are not converted to source text; their absence from model input is an
explicit visibility gap. Artifact records remain quarantined. All acquisition,
artifact and VM gaps remain in the review input.

The current VM profile boots a pinned operator seed. It does not execute the
acquired project. Assembly therefore adds `acquired-source-not-executed` and
`complete-collector-not-attached` regardless of the supplied VM metadata. Its
manifest is always incomplete and authorizes neither provider calls nor
publication. It cannot turn a harmless fixture boot into a security scan.

The next runtime integration must bind the acquired content and approved commands
to execution and collect the required telemetry before a reviewed scheduler may
authorize provider spend or publication. The trusted reconciliation module can
consume the resulting review input once actual model records and collector
observations exist; this assembly does not invent either. Missing runtime
readiness must leave the pending assessment unchanged.

## Actual component workflow

The optional `SLOP_VETTING_ACQUISITION_EVIDENCE` path in the signed queue
workflow retains only the acquired fixture files. It does not copy the signing
key or database. The destination must not already exist. Run the real isolated
analyzer for each retained object and save each JSON report as
`<source-sha256>.json` in a private report directory. Obtain a real `vm.py`
output directory. A failed or timed-out VM run is valid incomplete evidence;
it is not proof that the guest or project ran.

```sh
bun scripts/vetting-assembly-workflow.ts ACQUISITION ARTIFACT_REPORTS VM_OUTPUT PRIVATE_OUTPUT_PARENT
```

This workflow consumes those actual component files. It verifies the complete
assembly digests and the retained missing-coverage markers, then rejects missing
artifact inspection and corrupted queue, artifact or VM pins. Failed assembly
must create no completed manifest. No provider or service publication occurs.
Operator-console access, approved content-bound execution, complete collectors,
and the private evidence retention service remain separate unfinished work.
