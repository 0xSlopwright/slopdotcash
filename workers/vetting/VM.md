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
