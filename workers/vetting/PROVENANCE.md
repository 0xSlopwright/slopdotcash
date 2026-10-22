# Private source and release comparison

VET-04 and MVP-12 require comparison of repository source and release artifacts.
The artifact analyzer previously listed hashes but did not compare those inputs.
`provenance.py` compares a captured release archive with a Git source archive whose
file bytes and executable bits match an exact acquired source inventory.

Run on unprivileged Linux with the existing Bubblewrap policy:

```sh
python3 workers/vetting/provenance.py \
  /private/inventory.json INVENTORY_SHA256 \
  /private/source.tar SOURCE_ARCHIVE_SHA256 \
  /private/release.tar RELEASE_ARCHIVE_SHA256 > /private/comparison.json
```

All paths and output are private. Capture and inspect these files through the
approved evidence workflow. Do not publish file names or raw artifacts.

The caller supplies exact SHA-256 digests. The command snapshots bounded regular
files, verifies their digests, and parses both archives through the existing
isolated analyzer. It refuses unsupported source entries, missing or different
source files, incomplete archive inventories, unsafe paths and changed inputs.
The existing 32 MiB archive, 64 MiB expansion and record limits remain in force.

The report binds the source repository, commit and tree from the supplied
acquisition inventory, plus exact input hashes and sizes. It reports added,
removed and changed paths, executable-bit changes, unavailable mode metadata,
and identical bytes with the same executable bit. Tar mode bits are recorded;
ZIP modes are used only when the entry declares Unix metadata. No root directory
is removed, no rename is inferred, and nested members do not become root files.
An install hook is parsed as bytes and never executed.

The selected release is not independently authenticated by this command. An
identity supplied in the source inventory is not a new proof of GitHub authority.
Equal bytes and executable bits do not establish copyright, signatures, version
identity, build equivalence, safety or release approval. Other mode bits and entry
metadata are not compared. Source visibility gaps remain in the report. Matching Git LFS pointer bytes
does not compare the unavailable LFS object; submodule entries are refused. All
inputs remain quarantined and execution and publication authority remain false.

The actual Linux workflow creates a harmless Git commit and archive, changes a
release, and proves the reported differences, mode change, nested-path boundary,
input refusals and lack of execution. Run it with:

```sh
python3 workers/vetting/provenance_workflow_test.py
```

Canonical assembly accepts a private `provenanceEvidence` directory with
`report.json`, `source.tar` and `release.tar`, plus the exact report digest.
The archive names identify transport slots; either archive may use a supported
format. The assembler binds the source side to its existing acquisition inventory,
checks each archive's digest and size, and retains the report and both archives.
The review includes the comparison and all its visibility gaps. Private storage
requires the same report and input roles; an omitted archive invalidates closure.

The existing assembly and storage workflow commands accept an optional final
provenance directory. They exercise missing or changed archive refusal and the
retained console against actual captured comparison outputs. These checks use a
harmless controlled release, not an independently authenticated public release.
The comparison does not complete VET-04 or permit a clean result.
