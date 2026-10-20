# Offline VM evidence

This component runs one operator-reviewed boot image and seed in an offline
hardware VM. It records private evidence. It cannot approve a project or produce
a complete vetting result. Acquired project source is not yet passed into the
VM. Kernel interception, preload interception, controlled dependency fetching,
filesystem comparison, and trusted collector coverage are not implemented.

Use a dedicated unprivileged Linux aarch64 host with KVM and the maintained
Bubblewrap policy for further integration. QEMU runs with the `virt` machine,
no network device, no monitor, no shared host directory, a private writable
QCOW2 layer, and read-only boot inputs. The host namespace has no network.
QEMU image inspection also runs inside that namespace. The runner never mounts
or extracts a guest filesystem on the host. QEMU seccomp and process limits
apply on Linux. This source has not yet been accepted on a deployed Linux host.

The Darwin HVF adapter is for harmless, reviewed fixtures only. It is not an
approved host for hostile project source. It uses a deny-by-default host sandbox
and wall-time limit but has no hard host memory or CPU ceiling. Setting
`RLIMIT_CPU` on the tested macOS host prevented HVF firmware progress, so the
fixture adapter does not use that limit. TCG is never a fallback.

Create a private operator-owned JSON file with the keyword arguments of
`run_vm` in `vm.py`: explicit `qemu` and `image_tool` executable paths and
SHA-256 pins; `base`, `firmware`, `firmware_vars`, and `seed` paths with their
SHA-256 pins; an existing `output` directory; and optional `fixture` and
`timeout` values. Every pin must come from an independent operator review.
Do not derive approval from a file's current digest alone. The timeout is at
most 300 seconds. The seed is a reviewed boot configuration, not user input.

Run `python3 workers/vetting/vm.py --config <private-file> --preflight` to check
host prerequisites and executable identities. A successful prerequisite check
still reports `vettingReady: false`. Run without `--preflight` to collect one
private run. The output gives the owned run directory. It contains pinned
inputs, the writable layer, serial output, a block allocation map, and
`evidence.json`. The evidence is always `incomplete`. Serial output is
untrusted guest text, not trusted kernel telemetry; a block allocation map is
not a filesystem diff. No provider calls or publication occur.

Only a newly created run directory belongs to this process. Failures before
launch remove that directory; failures after launch retain private evidence
and a failure record. Timeout and output limits stop the owned QEMU process
group. No existing VM is inspected, stopped, or deleted. Operators must apply
private retention limits to completed run directories.

`vm_workflow_test.py` boots a static harmless Ubuntu fixture, runs a command as
`nobody`, writes a guest temporary file, reports guest interfaces, and powers
off. A separate run verifies the wall-time cutoff. This is actual fixture
execution evidence, not approval to execute a live repository and not proof of
complete interception.

## Reviewed source fixture and syscall evidence

`guest_ingress.py` adds a private source-to-guest fixture path using the existing
acquisition `inventory.json` and digest-named objects. Its `build_seed` function
requires an independently approved source-inventory digest and command-profile
digest. The profile is operator input; repository instructions cannot supply
approval. It binds the exact Python command and the guest Python, strace and
setpriv executable hashes. Only the explicit harmless-fixture profile is
supported. This is not a general repository execution service.

The builder checks every object and rejects links, submodules, unsafe paths,
file/directory collisions, changed bytes and oversized input. It copies only
regular files into a read-only seed image. The guest repeats input and baseline
checks, writes a root-owned source tree, and mounts that tree read-only with
noexec, nosuid and nodev. A reviewed interpreter can read the approved fixture;
noexec is not a defense against new interpreted payloads. Source execution must
remain disabled for arbitrary projects until the VET-04 interception gate exists.

The root collector runs strace outside the unprivileged command and follows its
children. The command receives no real credentials, no supplementary groups,
no new privileges and no capabilities. It has a synthetic, worthless canary and
no network device. The collector bounds time, output and trace size. It retains
process, file and socket syscall evidence with timestamps. String arguments
are limited to 256 bytes; that limitation is an explicit visibility gap. Guest
ptrace evidence is not an independent kernel monitor, does not prove resistance
to a compromised guest root, and is not complete HTTP or memory-content evidence.

`collect_guest` binds the receipt to the actual source inventory, approved
profile, seed, VM evidence and serial digests. It saves private
`guest-events.log`, `guest-output.log` and `guest-source-evidence.json` alongside
the original VM evidence. Missing, ambiguous, changed or oversized evidence
fails. The receipt always remains incomplete and grants neither model spend nor
publication. The guest's own success report cannot grant security clearance.

Both functions have a JSON CLI: `python3 workers/vetting/guest_ingress.py --config
<private-file>` builds the seed; add `--collect` for receipt collection. The
JSON keys match the named function arguments. Seed builder identity is pinned
too. Keep the approved profile and all generated evidence private.

The existing `vm_workflow_test.py` accepts `--acquisition-directory`,
`--inventory-sha256`, `--profile`, `--profile-sha256`, `--xorriso` and
`--xorriso-sha256` to run the source path instead of the basic boot fixture.
Use acquisition of the checked-in harmless `fixtures/syscall_probe.py` as
`fixture.py`. The real guest proves read-only source, an unprivileged child
creating/reading/renaming/deleting a file, a child metadata connection attempt,
a synthetic canary read and denied raw-device access. It retains the original
VM timeout and external-data image checks. These are tested observations, not
complete VET-03 or VET-08 acceptance.
