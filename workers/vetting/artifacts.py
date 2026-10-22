#!/usr/bin/env python3
"""Private VET-04 inventory. Parse in a Linux namespace; never release or run input."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import resource
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile

MAX_INPUT = 32 * 1024 * 1024
MAX_EXPANDED = 64 * 1024 * 1024
MAX_RECORDS = 1024
MAX_DEPTH = 6
MAX_OUTPUT = 2 * 1024 * 1024


class Inventory:
    def __init__(self):
        self.records = []
        self.gaps = set()
        self.expanded = 0

    def member(self, stream, size):
        if size < 0 or size > MAX_EXPANDED - self.expanded:
            raise ValueError("expansion-limit")
        data = stream.read(size + 1)
        self.expanded += len(data)
        if len(data) != size or self.expanded > MAX_EXPANDED:
            raise ValueError("member-size-mismatch")
        return data

    def path(self, name):
        # Backslashes can become separators on a later Windows consumer.
        if (not name or len(name) > 1024 or "\\" in name or "\x00" in name
                or any(ord(c) < 32 for c in name) or ":" in name
                or PurePosixPath(name).is_absolute()
                or ".." in PurePosixPath(name).parts):
            raise ValueError("unsafe-member-path")
        return name

    def visit(self, data, path, parent=None, depth=0):
        if len(self.records) >= MAX_RECORDS:
            raise ValueError("record-limit")
        digest = hashlib.sha256(data).hexdigest()
        kind = "opaque"
        if data.startswith(b"\x7fELF"):
            kind = "native"
        elif data.startswith(b"\x00asm"):
            kind = "wasm"
        elif data.startswith(b"#!"):
            kind = "script"
        elif data.startswith(b"MZ") or data[:4] in (
                b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe"):
            kind = "native"
        record = {"sha256": digest, "parentSha256": parent, "path": path,
                  "bytes": len(data), "kind": kind, "state": "quarantined"}
        self.records.append(record)
        archive = None
        try:
            if data.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
                record["kind"] = "zip"
                if depth >= MAX_DEPTH:
                    raise ValueError("archive-depth-limit")
                archive = zipfile.ZipFile(io.BytesIO(data))
                names = set()
                for info in archive.infolist():
                    name = self.path(info.filename)
                    if name in names:
                        raise ValueError("duplicate-member-path")
                    names.add(name)
                    mode = info.external_attr >> 16
                    if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) and not (
                            stat.S_ISREG(mode) or stat.S_ISDIR(mode))):
                        raise ValueError("special-member")
                    if info.flag_bits & 1:
                        raise ValueError("encrypted-member")
                    if info.is_dir():
                        continue
                    if len(self.records) >= MAX_RECORDS:
                        raise ValueError("record-limit")
                    with archive.open(info) as stream:
                        payload = self.member(stream, info.file_size)
                    self.visit(payload, name, digest, depth + 1)
            else:
                # Only recognized containers are unpacked. Unknown bytes stay quarantined.
                try:
                    archive = tarfile.open(fileobj=io.BytesIO(data), mode="r:*")
                except tarfile.ReadError:
                    if data.startswith((b"\x1f\x8b", b"BZh", b"\xfd7zXZ")):
                        self.gaps.add("unsupported-or-invalid-compressed-container")
                    return
                record["kind"] = "tar"
                if depth >= MAX_DEPTH:
                    raise ValueError("archive-depth-limit")
                names = set()
                for info in archive:
                    name = self.path(info.name)
                    if name in names:
                        raise ValueError("duplicate-member-path")
                    names.add(name)
                    if info.isdir():
                        continue
                    if not info.isfile():
                        raise ValueError("special-member")
                    if len(self.records) >= MAX_RECORDS:
                        raise ValueError("record-limit")
                    stream = archive.extractfile(info)
                    with stream:
                        payload = self.member(stream, info.size)
                    self.visit(payload, name, digest, depth + 1)
        except (ValueError, OSError, EOFError, RuntimeError, zipfile.BadZipFile,
                tarfile.TarError, NotImplementedError) as error:
            # Exceptions can contain artifact content. Emit only fixed reason identifiers.
            reason = str(error) if type(error) is ValueError else "invalid-container"
            allowed = {"expansion-limit", "member-size-mismatch", "unsafe-member-path",
                       "archive-depth-limit", "duplicate-member-path", "special-member",
                       "encrypted-member", "record-limit"}
            self.gaps.add(reason if reason in allowed else "invalid-container")
        finally:
            if archive is not None:
                archive.close()


def child():
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
    inventory = Inventory()
    with open("/input", "rb") as stream:
        data = stream.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        raise ValueError("input-limit")
    inventory.visit(data, "input")
    print(json.dumps({"schema": "slop-artifact-inventory-v1", "state": "quarantined",
                      "records": inventory.records, "visibilityGaps": sorted(inventory.gaps)},
                     separators=(",", ":")))


def sandbox_command(input_path, script_path):
    if sys.platform != "linux" or os.geteuid() == 0:
        raise RuntimeError("requires-unprivileged-linux")
    executable = shutil.which("bwrap")
    if not executable:
        raise RuntimeError("bubblewrap-unavailable")
    command = [executable, "--unshare-all", "--unshare-user", "--die-with-parent", "--new-session",
               "--cap-drop", "ALL", "--disable-userns", "--clearenv", "--ro-bind", "/usr", "/usr"]
    for path in ("/lib", "/lib64"):
        if os.path.exists(path):
            command += ["--ro-bind", path, path]
    if os.path.exists("/etc/ld.so.cache"):
        command += ["--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"]
    command += ["--dev", "/dev", "--proc", "/proc", "--ro-bind", str(input_path), "/input",
                "--ro-bind", str(script_path), "/analyzer.py", "--chdir", "/",
                "/usr/bin/python3", "-I", "-B", "/analyzer.py", "--child"]
    return command


def analyze(source):
    # Copy bytes before parsing so changing the source cannot change the scanned object.
    with tempfile.TemporaryDirectory(prefix="slop-artifact-") as temporary:
        path = Path(temporary) / "input"
        descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise RuntimeError("input-not-regular")
            data = stream.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            raise RuntimeError("input-limit")
        path.write_bytes(data)
        command = sandbox_command(path, Path(__file__).resolve())
        with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL,
                              env={}, start_new_session=True) as process:
            output = bytearray()
            deadline = time.monotonic() + 15
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while True:
                        if time.monotonic() >= deadline:
                            raise RuntimeError("analyzer-timeout")
                        if not selector.select(timeout=0.1):
                            continue
                        chunk = os.read(process.stdout.fileno(), 8192)
                        if not chunk:
                            break
                        output.extend(chunk)
                        if len(output) > MAX_OUTPUT:
                            raise RuntimeError("analyzer-output-limit")
                if process.wait(timeout=max(0.1, deadline - time.monotonic())) != 0:
                    raise RuntimeError("analyzer-failed")
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        result = json.loads(output)
        if (result.get("state") != "quarantined" or not result.get("records")
                or result["records"][0]["sha256"] != hashlib.sha256(data).hexdigest()
                or any(row["state"] != "quarantined" for row in result["records"])):
            raise RuntimeError("invalid-analyzer-result")
        return result


if __name__ == "__main__":
    if sys.argv[1:] == ["--child"]:
        child()
    elif len(sys.argv) == 2:
        try:
            print(json.dumps(analyze(sys.argv[1]), separators=(",", ":")))
        except Exception:
            # No partial inventory may be interpreted as completion after a failed parser.
            print(json.dumps({"schema": "slop-artifact-inventory-v1", "state": "incomplete",
                              "reason": "isolated-analysis-unavailable-or-failed"}))
            sys.exit(1)
    else:
        sys.exit("usage: python3 artifacts.py PATH (private output; never publish)")
