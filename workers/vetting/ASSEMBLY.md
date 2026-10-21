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

Without a guest receipt, assembly adds `acquired-source-not-executed`. An
optional `guestEvidence` input can bind an actual harmless-source run. Supply
the approved profile path and digest, reviewed collector digest, and retained
guest receipt digest. The assembler checks the queue source inventory, exact
source digest set, profile, collector, VM, seed and serial bindings. It verifies
the retained syscall and output files against both their digests and the actual
serial frame. An optional post-collector probe is bound in the same way.

The raw serial remains in the private manifest. The review input gets the
decoded trace and outputs once, plus the console with that one encoded frame
removed. A missing or ambiguous frame fails. Nothing is shortened to fit.
The receipt replaces the source-not-executed gap with an explicit statement that
only the approved harmless fixture command ran. Complete collector,
interpreter/JIT/memory/proxy and independent-observation gaps remain required
host policy, regardless of guest claims. The manifest stays incomplete and
authorizes neither provider calls nor publication.

General project execution must bind acquired content and approved commands
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
bun scripts/vetting-assembly-workflow.ts ACQUISITION ARTIFACT_REPORTS VM_OUTPUT PRIVATE_OUTPUT_PARENT [APPROVED_GUEST_PROFILE]
```

This workflow consumes those actual component files. It verifies the complete
assembly digests and the retained missing-coverage markers, then rejects missing
artifact inspection and corrupted queue, artifact or VM pins. Failed assembly
must create no completed manifest. No provider or service publication occurs.
Set `SLOP_VETTING_GUEST_FIXTURE=syscall` or `artifact` in the existing queue
workflow to acquire the corresponding checked-in harmless source. Use that
retained inventory digest in the separately approved guest profile, then run
the existing VM workflow. Never construct queue metadata to match a different
VM run. The signed queue and actual acquisition must produce the input bytes.

Operator-console access, general project execution, complete collectors, and
the private evidence retention service remain separate unfinished work.

## Optional controlled dependency evidence

`dependencyEvidence` supplies a private directory, `inventorySha256` and an
independently approved `profileSha256`. The assembler checks the fetch profile
against the same acquired source inventory. Each ordered request must match its
captured URL, digest, byte limit and successful observation. It verifies each
object and isolated artifact report with the same routines used for source
artifacts. Dependency bytes and provenance have separate evidence IDs; they are
never represented as Git blobs. Duplicate byte objects may share one report,
but conflicting report references fail.

The assembler retains every dependency visibility gap and adds explicit markers
that prefetch is not runtime proxy coverage and that dependencies have no
execution permission. A failed fetch manifest cannot substitute for a completed
quarantine inventory. Such failed bytes stay in the separate private failure
record for operator inspection.

For a connected harmless workflow, pass the actual signed queue's source
inventory to `dependencies_workflow_test.py --source-inventory PATH
--retain-directory NEW_DIRECTORY` inside the isolated Linux fixture. It retains
one real successful fetch and one real multi-request failure under `complete`
and `incomplete`. Copy those private outputs without changing them, then run:

```sh
bun scripts/vetting-assembly-workflow.ts ACQUISITION ARTIFACT_REPORTS VM_OUTPUT PRIVATE_OUTPUT_PARENT APPROVED_GUEST_PROFILE DEPENDENCY_COMPLETE DEPENDENCY_INCOMPLETE
```

Use `-` for the guest profile only when no guest receipt is supplied. The
workflow checks dependency profile/inventory pins, actual captured bytes,
missing inspection, source mismatch and refusal of the retained failed fetch.
It uses the real queue, analyzer, guest and network component outputs and makes
no model call or result publication.
