#!/usr/bin/env python3
"""Bounded offline hardware VM evidence. Never reports security clearance."""
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import selectors
import shutil
import signal
import subprocess
import tempfile
import time

MAX_IMAGE = 8 * 1024**3
MAX_LOG = 4 * 1024**2
MAX_EVENTS = 4096


def sha256(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def copy_pinned(source, expected, target, maximum):
    if len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        raise ValueError("An exact SHA-256 pin is required")
    # Open once, reject symlinks and non-regular files, and hash the copied bytes.
    import stat
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    digest = hashlib.sha256()
    size = 0
    with os.fdopen(descriptor, "rb") as incoming, open(target, "xb") as outgoing:
        if not stat.S_ISREG(os.fstat(incoming.fileno()).st_mode):
            raise ValueError("Pinned input must be a regular file")
        while chunk := incoming.read(1024 * 1024):
            size += len(chunk)
            if size > maximum:
                raise ValueError("Pinned input exceeds limit")
            outgoing.write(chunk)
            digest.update(chunk)
    os.chmod(target, 0o400)
    if digest.hexdigest() != expected:
        raise ValueError("Pinned input digest mismatch")


def confined(command, directory, fixture):
    """Constrain even image inspection tools, which parse guest-controlled bytes."""
    if os.geteuid() == 0:
        raise RuntimeError("Run as an unprivileged operator")
    system = platform.system()
    if system == "Linux":
        bwrap = shutil.which("bwrap")
        if not bwrap or not Path("/dev/kvm").exists():
            raise RuntimeError("KVM and the maintained Bubblewrap policy are required")
        args = [bwrap, "--unshare-all", "--die-with-parent", "--new-session",
                "--cap-drop", "ALL", "--disable-userns", "--clearenv",
                "--ro-bind", "/usr", "/usr"]
        for runtime in ("/lib", "/lib64", "/etc/ld.so.cache"):
            if Path(runtime).exists():
                args += ["--ro-bind", runtime, runtime]
        return args + ["--dev", "/dev", "--dev-bind", "/dev/kvm", "/dev/kvm",
                       "--proc", "/proc", "--bind", str(directory), str(directory),
                       "--ro-bind", str(directory / "base.qcow2"), str(directory / "base.qcow2"),
                       "--ro-bind", str(directory / "firmware.bin"), str(directory / "firmware.bin"),
                       "--ro-bind", str(directory / "seed.iso"), str(directory / "seed.iso"),
                       "--chdir", str(directory), "--", *command]
    if system == "Darwin" and fixture:
        # Darwin is a harmless-fixture adapter, not an approved hostile-workload host.
        sandbox = Path("/usr/bin/sandbox-exec")
        if not sandbox.exists():
            raise RuntimeError("Fixture host confinement unavailable")
        quote = json.dumps
        profile = "\n".join([
            "(version 1)", "(deny default)", "(allow process-exec)",
            "(allow sysctl-read)", "(allow mach-lookup)",
            '(allow file-write* (literal "/dev/null"))',
            "(allow file-read-metadata)", '(allow file-read-data (literal "/"))',
            '(allow file-read* (subpath "/usr") (subpath "/System") '
            '(subpath "/opt/homebrew") (literal "/dev/null") '
            '(literal "/dev/urandom") (literal "/dev/random"))',
            f"(allow file-read* file-write* (subpath {quote(str(directory))}))",
            *(f"(deny file-write* (literal {quote(str(directory / name))}))"
              for name in ("base.qcow2", "firmware.bin", "seed.iso")),
            '(allow iokit-open (iokit-user-client-class "AppleHVClient"))',
        ])
        policy = directory / "host.sb"
        policy.write_text(profile)
        return [str(sandbox), "-f", str(policy), *command]
    raise RuntimeError("Only Linux KVM hosts or explicit Darwin harmless fixtures are supported")


def limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_FSIZE, (2 * 1024**3,) * 2)
    if platform.system() == "Linux":
        resource.setrlimit(resource.RLIMIT_CPU, (300, 300))
        resource.setrlimit(resource.RLIMIT_AS, (4 * 1024**3,) * 2)
        resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))


def tool(command, directory, fixture):
    with subprocess.Popen(confined(command, directory, fixture), cwd=directory,
                          env={}, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, start_new_session=True,
                          preexec_fn=limits) as process:
        output = bytearray()
        deadline = time.monotonic() + 30
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Image tool timed out")
                    if not selector.select(timeout=0.1):
                        continue
                    chunk = os.read(process.stdout.fileno(), 8192)
                    if not chunk:
                        break
                    output.extend(chunk)
                    if len(output) > MAX_LOG:
                        raise RuntimeError("Image tool output limit")
            if process.wait(timeout=max(0.1, deadline - time.monotonic())) != 0:
                raise RuntimeError("Confined image tool failed")
            return bytes(output)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def assert_standalone(info):
    if (info.get("format") != "qcow2" or info.get("backing-filename")
            or info.get("data-file")
            or info.get("format-specific", {}).get("data", {}).get("data-file")
            or not 0 < info["virtual-size"] <= 16 * 1024**3):
        raise ValueError("Base must be a bounded standalone QCOW2 image")


def preflight(*, qemu, qemu_sha256, image_tool, image_tool_sha256, fixture=False):
    """Check operator-pinned host prerequisites; this does not enable full vetting."""
    if os.geteuid() == 0 or platform.machine() not in ("arm64", "aarch64"):
        raise RuntimeError("Unprivileged aarch64 host required")
    if platform.system() == "Linux":
        if not shutil.which("bwrap") or not os.access("/dev/kvm", os.R_OK | os.W_OK):
            raise RuntimeError("Accessible KVM and maintained Bubblewrap policy required")
    elif platform.system() != "Darwin" or not fixture:
        raise RuntimeError("Darwin requires explicit harmless-fixture mode")
    result = {}
    for name, path, expected in (("qemu", qemu, qemu_sha256), ("imageTool", image_tool, image_tool_sha256)):
        resolved = Path(path).resolve(strict=True)
        if not resolved.is_file() or not os.access(resolved, os.X_OK) or sha256(resolved) != expected:
            raise ValueError("Operator-reviewed executable digest mismatch")
        result[name] = {"path": str(resolved), "sha256": expected}
    return result


def run_vm(*, qemu, qemu_sha256, image_tool, image_tool_sha256, base, base_sha256, firmware, firmware_sha256, firmware_vars, firmware_vars_sha256, seed, seed_sha256,
           output, fixture=False, timeout=240):
    """Input seed/image must be operator-reviewed; no arbitrary commands or host mounts."""
    if not 1 <= timeout <= 300:
        raise ValueError("VM wall-time bound must be 1 to 300 seconds")
    architecture = platform.machine()
    if architecture not in ("arm64", "aarch64"):
        raise RuntimeError("This reviewed profile supports aarch64 virt only")
    binaries = preflight(qemu=qemu, qemu_sha256=qemu_sha256, image_tool=image_tool,
                         image_tool_sha256=image_tool_sha256, fixture=fixture)
    qemu, image_tool = binaries["qemu"]["path"], binaries["imageTool"]["path"]
    output = Path(output).resolve()
    # Caller supplies a private existing parent. This run owns only its unique directory.
    directory = Path(tempfile.mkdtemp(prefix="slop-vm-", dir=output)).resolve()
    guest_started = False
    try:
        copy_pinned(base, base_sha256, directory / "base.qcow2", MAX_IMAGE)
        copy_pinned(firmware, firmware_sha256, directory / "firmware.bin", 64 * 1024**2)
        copy_pinned(seed, seed_sha256, directory / "seed.iso", 16 * 1024**2)
        copy_pinned(firmware_vars, firmware_vars_sha256, directory / "vars.fd", 64 * 1024**2)
        os.chmod(directory / "vars.fd", 0o600)
        for label, executable in (("qemu", qemu), ("imageTool", image_tool)):
            binaries[label]["version"] = tool([executable, "--version"], directory, fixture).decode("utf-8").splitlines()[0]
        info = json.loads(tool([image_tool, "info", "--output=json", "-f", "qcow2",
                                str(directory / "base.qcow2")], directory, fixture))
        assert_standalone(info)
        tool([image_tool, "create", "-q", "-f", "qcow2", "-F", "qcow2", "-b",
              str(directory / "base.qcow2"), str(directory / "overlay.qcow2")], directory, fixture)
        accelerator = "kvm" if platform.system() == "Linux" else "hvf"
        # Fixed local paths have no commas; JSON blockdev avoids QEMU option injection.
        args = [qemu, "-no-user-config", "-nodefaults", "-machine", "virt,virtualization=off",
                "-accel", accelerator, "-cpu", "host", "-m", "1024", "-smp", "2",
                "-display", "none", "-monitor", "none", "-serial", "stdio", "-nic", "none",
                "-no-reboot",
                "-blockdev", json.dumps({"driver": "raw", "node-name": "firmware", "read-only": True, "file": {"driver": "file", "filename": str(directory / "firmware.bin")}}),
                "-blockdev", json.dumps({"driver": "raw", "node-name": "variables", "file": {"driver": "file", "filename": str(directory / "vars.fd")}}),
                "-machine", "pflash0=firmware,pflash1=variables"]
        for name, filename, fmt, readonly in [("root", "overlay.qcow2", "qcow2", False),
                                              ("seed", "seed.iso", "raw", True)]:
            args += ["-blockdev", json.dumps({"driver": fmt, "node-name": name,
                      "read-only": readonly, "file": {"driver": "file", "filename": str(directory / filename)}}),
                     "-device", f"virtio-blk-pci,drive={name}"]
        if accelerator == "kvm":
            args += ["-sandbox", "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny"]
        started = time.time()
        events = []
        total = 0
        termination = "guest-exit"
        with subprocess.Popen(confined(args, directory, fixture), cwd=directory, env={},
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, start_new_session=True,
                              preexec_fn=limits) as process, open(directory / "serial.log", "xb") as log:
            guest_started = True
            deadline = time.monotonic() + timeout
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while True:
                        if time.monotonic() >= deadline:
                            termination = "wall-time-limit"
                            break
                        if not selector.select(timeout=0.1):
                            continue
                        chunk = os.read(process.stdout.fileno(), 8192)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_LOG:
                            termination = "output-limit"
                            break
                        log.write(chunk)
                        log.flush()
                        observed = time.time()
                        if events and observed - events[-1]["observedAt"] < 0.1:
                            events[-1]["bytes"] += len(chunk)
                        else:
                            events.append({"observedAt": observed, "bytes": len(chunk)})
                        if len(events) >= MAX_EVENTS:
                            termination = "event-count-limit"
                            break
            finally:
                if termination == "guest-exit":
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        termination = "exit-timeout"
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                returncode = process.wait()
        # Never mount or extract the guest filesystem on the host.
        disk_map = tool([image_tool, "map", "--output=json", "-f", "qcow2",
                         str(directory / "overlay.qcow2")], directory, fixture)
        (directory / "disk-map.json").write_bytes(disk_map)
        if sha256(directory / "base.qcow2") != base_sha256:
            raise RuntimeError("Read-only base changed")
        evidence = {
            "schema": "slop-offline-vm-evidence-v1", "state": "incomplete",
            "accelerator": accelerator, "machine": "aarch64-virt", "fixtureOnly": fixture,
            "executables": binaries,
            "baseSha256": base_sha256, "seedSha256": seed_sha256,
            "firmwareSha256": firmware_sha256, "firmwareVarsSha256": firmware_vars_sha256,
            "startedAt": started, "completedAt": time.time(), "termination": termination,
            "exitCode": returncode, "serialSha256": sha256(directory / "serial.log"),
            "overlaySha256": sha256(directory / "overlay.qcow2"),
            "diskMapSha256": hashlib.sha256(disk_map).hexdigest(), "serialChunks": events,
            "network": "no-network-device", "visibilityGaps": [
                "guest-kernel-and-preload-interception-not-implemented",
                "serial-is-untrusted-guest-output-not-complete-telemetry",
                "block-allocation-map-is-not-filesystem-diff",
                "controlled-dependency-fetch-pass-not-implemented",
                "acquired-source-not-executed",
                "model-reviews-not-attached",
            ] + (["fixture-host-not-approved-for-hostile-projects",
                  "darwin-fixture-has-no-hard-host-memory-or-cpu-ceiling"] if fixture else []),
        }
        (directory / "evidence.json").write_text(json.dumps(evidence, separators=(",", ":")))
        return directory
    except BaseException:
        if guest_started:
            (directory / "failure.json").write_text(json.dumps({
                "state": "incomplete", "reason": "host-evidence-collection-failed",
            }))
        else:
            shutil.rmtree(directory)
        raise


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="Private operator-owned JSON run arguments")
    parser.add_argument("--preflight", action="store_true")
    arguments = parser.parse_args()
    config_path = Path(arguments.config)
    if config_path.stat().st_size > 65536:
        raise ValueError("Configuration exceeds limit")
    config = json.loads(config_path.read_text())
    if arguments.preflight:
        names = ("qemu", "qemu_sha256", "image_tool", "image_tool_sha256", "fixture")
        print(json.dumps({"executables": preflight(**{k: v for k, v in config.items() if k in names}),
                          "vettingReady": False, "visibilityGaps": ["acquired-source-not-executed", "required-collectors-not-implemented"]}))
    else:
        print(json.dumps({"directory": str(run_vm(**config)), "state": "incomplete"}))
