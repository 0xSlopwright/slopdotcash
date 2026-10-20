"""Real isolated CLI workflows. Run as a non-root user on Linux with bubblewrap."""
import hashlib
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

from artifacts import MAX_DEPTH, MAX_EXPANDED, sandbox_command

SCRIPT = Path(__file__).with_name("artifacts.py")


def zipped(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return output.getvalue()


class ArtifactWorkflow(unittest.TestCase):
    def run_input(self, data):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "artifact"
            source.write_bytes(data)
            run = subprocess.run([sys.executable, "-I", str(SCRIPT), str(source)],
                                 capture_output=True, timeout=20, check=True)
            result = json.loads(run.stdout)
            self.assertEqual(result["state"], "quarantined")
            self.assertTrue(all(row["state"] == "quarantined" for row in result["records"]))
            self.assertEqual(result["records"][0]["sha256"], hashlib.sha256(data).hexdigest())
            return result

    def test_nested_inventory_never_runs_or_extracts_code(self):
        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory) / "must-not-exist"
            script = f"#!/bin/sh\ntouch {sentinel}\n".encode()
            nested = zipped([("payload.sh", script), ("module.wasm", b"\x00asm\x01\x00\x00\x00")])
            data = zipped([("nested.zip", nested), ("README.md", b"harmless fixture")])
            result = self.run_input(data)
            self.assertEqual(result["visibilityGaps"], [])
            self.assertEqual(len(result["records"]), 5)
            payload = next(row for row in result["records"] if row["path"] == "payload.sh")
            self.assertEqual(payload["parentSha256"], hashlib.sha256(nested).hexdigest())
            self.assertEqual(payload["sha256"], hashlib.sha256(script).hexdigest())
            self.assertFalse(sentinel.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_archive_escape_links_and_expansion_are_quarantined(self):
        for path in ("../../escape", "/absolute", "C:\\escape"):
            result = self.run_input(zipped([(path, b"fixture")]))
            self.assertIn("unsafe-member-path", result["visibilityGaps"])
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            link = tarfile.TarInfo("link")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            archive.addfile(link)
        self.assertIn("special-member", self.run_input(output.getvalue())["visibilityGaps"])
        bomb = zipped([("expanded", b"0" * (MAX_EXPANDED + 1))])
        self.assertIn("expansion-limit", self.run_input(bomb)["visibilityGaps"])
        nested = b"fixture"
        for _ in range(MAX_DEPTH + 1):
            nested = zipped([("nested", nested)])
        self.assertIn("archive-depth-limit", self.run_input(nested)["visibilityGaps"])

    def test_actual_parser_namespace_cannot_read_host_write_or_reach_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret = root / "private"
            secret.write_text("synthetic secret")
            input_file = root / "input"
            input_file.write_bytes(b"fixture")
            probe = root / "probe.py"
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen()
                port = listener.getsockname()[1]
                probe.write_text(f'''import json, socket
from pathlib import Path
checks = {{}}
try:
    Path({str(secret)!r}).read_bytes()
    checks["hostReadDenied"] = False
except OSError:
    checks["hostReadDenied"] = True
try:
    Path("/input").write_text("changed")
    checks["inputWriteDenied"] = False
except OSError:
    checks["inputWriteDenied"] = True
try:
    socket.create_connection(("127.0.0.1", {port}), timeout=1)
    checks["networkDenied"] = False
except OSError:
    checks["networkDenied"] = True
print(json.dumps(checks))
''')
                run = subprocess.run(sandbox_command(input_file, probe), capture_output=True,
                                     timeout=10, check=True)
            self.assertEqual(json.loads(run.stdout), {
                "hostReadDenied": True, "inputWriteDenied": True, "networkDenied": True})
            self.assertEqual(input_file.read_bytes(), b"fixture")

    def test_missing_isolation_does_not_return_partial_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "fixture"
            source.write_bytes(b"fixture")
            run = subprocess.run([sys.executable, "-I", str(SCRIPT), str(source)],
                                 capture_output=True, env={"PATH": "/nonexistent"}, timeout=20)
            self.assertNotEqual(run.returncode, 0)
            self.assertEqual(json.loads(run.stdout)["state"], "incomplete")
            self.assertNotIn("records", json.loads(run.stdout))


if __name__ == "__main__":
    unittest.main(verbosity=2)
