"""Actual Git archive and isolated release comparison; no artifact is executed."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name("provenance.py")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def archive(entries):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w") as output:
        for name, body, mode in entries:
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode = len(body), mode
            output.addfile(entry, io.BytesIO(body))
    return result.getvalue()


class ProvenanceWorkflow(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        for path, body in (("same.txt", b"same"), ("change.txt", b"old"),
                           ("removed.txt", b"removed"), ("mode.sh", b"#!/bin/sh\nexit 0\n")):
            (self.repo / path).write_bytes(body)
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "harmless source")
        records = []
        for entry in self.git("ls-tree", "-r", "HEAD").decode().splitlines():
            metadata, path = entry.split("\t")
            mode, kind, git_sha = metadata.split()
            body = self.git("cat-file", "blob", git_sha)
            records.append({"path": path, "type": kind, "mode": mode, "gitSha": git_sha,
                            "sha256": sha(body), "bytes": len(body), "state": "quarantined"})
        self.inventory = json.dumps({"schema": "slop-source-inventory-v1",
                                     "repository": "example/fixture",
                                     "commitSha": self.git("rev-parse", "HEAD").decode().strip(),
                                     "treeSha": self.git("rev-parse", "HEAD^{tree}").decode().strip(),
                                     "state": "quarantined", "records": records,
                                     "visibilityGaps": ["runtime-not-observed"]}).encode()
        self.source = self.git("archive", "--format=tar", "HEAD")

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.DEVNULL)

    def compare(self, release, source=None, wrong_sha=False):
        arguments = []
        for name, data in (("inventory", self.inventory), ("source", source or self.source),
                           ("release", release)):
            path = self.root / name
            path.write_bytes(data)
            arguments.extend((str(path), "0" * 64 if wrong_sha and name == "release" else sha(data)))
        result = subprocess.run([sys.executable, str(SCRIPT), *arguments], capture_output=True,
                                timeout=40)
        return result.returncode, json.loads(result.stdout)

    def test_actual_git_source_and_release_differences_remain_quarantined(self):
        sentinel = self.root / "must-not-execute"
        hook = f"#!/bin/sh\ntouch {sentinel}\n".encode()
        release = archive([("same.txt", b"same", 0o644), ("change.txt", b"new", 0o644),
                           ("mode.sh", b"#!/bin/sh\nexit 0\n", 0o755),
                           ("install.sh", hook, 0o755),
                           ("nested.tar", archive([("same.txt", b"different", 0o644)]), 0o644)])
        code, report = self.compare(release)
        self.assertEqual(code, 0)
        self.assertEqual(report["state"], "quarantined")
        self.assertFalse(report["executionAuthorized"])
        self.assertFalse(report["publicationAuthorized"])
        changes = {row["path"]: row["disposition"] for row in report["changes"]}
        self.assertEqual(changes, {"same.txt": "identical-bytes-and-executable-bit",
                                  "change.txt": "changed", "removed.txt": "removed",
                                  "mode.sh": "mode-changed", "install.sh": "added", "nested.tar": "added"})
        self.assertEqual(report["inputs"][2]["sha256"], sha(release))
        self.assertFalse(sentinel.exists())

    def test_lfs_pointer_gap_and_unavailable_zip_mode_remain_visible(self):
        pointer = b"version https://git-lfs.github.com/spec/v1\noid sha256:" + b"a" * 64 + b"\nsize 123\n"
        (self.repo / "same.txt").write_bytes(pointer)
        self.git("add", "same.txt")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "harmless LFS pointer")
        inventory = json.loads(self.inventory)
        inventory["commitSha"] = self.git("rev-parse", "HEAD").decode().strip()
        inventory["treeSha"] = self.git("rev-parse", "HEAD^{tree}").decode().strip()
        inventory["visibilityGaps"].append("lfs-object-not-acquired")
        row = next(row for row in inventory["records"] if row["path"] == "same.txt")
        row.update(sha256=sha(pointer), bytes=len(pointer),
                   gitSha=self.git("rev-parse", "HEAD:same.txt").decode().strip())
        self.inventory = json.dumps(inventory).encode()
        self.source = self.git("archive", "--format=tar", "HEAD")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as zipped:
            entry = zipfile.ZipInfo("same.txt")
            entry.create_system = 0
            zipped.writestr(entry, pointer)
        code, report = self.compare(output.getvalue())
        self.assertEqual(code, 0)
        self.assertIn("lfs-object-not-acquired", report["sourceVisibilityGaps"])
        row = next(row for row in report["changes"] if row["path"] == "same.txt")
        self.assertEqual(row["disposition"], "metadata-unavailable")
        self.assertEqual(row["source"]["sha256"], row["release"]["sha256"])
        self.assertIsNone(row["release"]["executable"])

    def test_root_prefix_is_not_stripped(self):
        code, report = self.compare(archive([("release/same.txt", b"same", 0o644)]))
        self.assertEqual(code, 0)
        changes = {row["path"]: row["disposition"] for row in report["changes"]}
        self.assertEqual(changes["release/same.txt"], "added")
        self.assertEqual(changes["same.txt"], "removed")

    def test_missing_mismatched_and_unsafe_inputs_never_return_partial_comparison(self):
        for release, source, wrong in (
                (archive([("same.txt", b"same", 0o644)]), None, True),
                (archive([("same.txt", b"same", 0o644)]), archive([("same.txt", b"same", 0o644)]), False),
                (archive([("../escape", b"bad", 0o644)]), None, False),
                (b"not an archive", None, False)):
            code, report = self.compare(release, source, wrong)
            self.assertNotEqual(code, 0)
            self.assertEqual(report["state"], "incomplete")
            self.assertNotIn("changes", report)


if __name__ == "__main__":
    unittest.main(verbosity=2)
