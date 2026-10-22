#!/usr/bin/env python3
"""Private exact-path source/release comparison. Never approve or execute input."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile

from artifacts import MAX_INPUT, MAX_OUTPUT, MAX_RECORDS, analyze


def digest(data):
    return hashlib.sha256(data).hexdigest()


def captured(path, expected, limit):
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("invalid-digest")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("input-not-regular")
        data = stream.read(limit + 1)
    if len(data) > limit or digest(data) != expected:
        raise ValueError("input-size-or-digest-mismatch")
    return data


def exact_path(value):
    if (not isinstance(value, str) or not value or len(value) > 1024
            or value == "." or str(PurePosixPath(value)) != value or value.startswith("/")
            or ".." in PurePosixPath(value).parts or "\\" in value or ":" in value
            or any(ord(char) < 32 for char in value)):
        raise ValueError("noncanonical-path")
    return value


def root_files(inventory):
    root = inventory["records"][0]
    if root["kind"] not in ("tar", "zip") or inventory["visibilityGaps"]:
        raise ValueError("archive-inventory-incomplete")
    files = {}
    for row in inventory["records"][1:]:
        if row["parentSha256"] != root["sha256"]:
            continue
        path = exact_path(row["path"])
        if path in files:
            raise ValueError("duplicate-path")
        files[path] = {"sha256": row["sha256"], "bytes": row["bytes"],
                       "executable": row["executable"]}
    return files


def compare(source_inventory, inventory_sha, source_archive, source_sha,
            release_archive, release_sha):
    raw_inventory = captured(source_inventory, inventory_sha, MAX_OUTPUT)
    source = json.loads(raw_inventory)
    if (source.get("schema") != "slop-source-inventory-v1"
            or source.get("state") != "quarantined"
            or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source.get("repository", ""))
            or any(not re.fullmatch(r"[a-f0-9]{40}", source.get(key, ""))
                   for key in ("commitSha", "treeSha"))
            or not isinstance(source.get("visibilityGaps"), list)
            or len(source["visibilityGaps"]) > MAX_RECORDS
            or any(not isinstance(gap, str) or len(gap) > 256 for gap in source["visibilityGaps"])
            or not isinstance(source.get("records"), list)
            or not 1 <= len(source["records"]) <= MAX_RECORDS):
        raise ValueError("invalid-source-inventory")
    expected = {}
    for row in source["records"]:
        path = exact_path(row["path"])
        if (path in expected or row.get("type") != "blob"
                or row.get("mode") not in ("100644", "100755")
                or row.get("state") != "quarantined"
                or not re.fullmatch(r"[a-f0-9]{64}", row.get("sha256", ""))
                or type(row.get("bytes")) is not int or row["bytes"] < 0):
            raise ValueError("unsupported-source-record")
        expected[path] = {"sha256": row["sha256"], "bytes": row["bytes"],
                          "executable": row["mode"] == "100755"}
    # Snapshot before analysis; compare the exact bytes whose digests were supplied.
    with tempfile.TemporaryDirectory(prefix="slop-provenance-") as directory:
        root = Path(directory)
        source_bytes = captured(source_archive, source_sha, MAX_INPUT)
        release_bytes = captured(release_archive, release_sha, MAX_INPUT)
        (root / "source").write_bytes(source_bytes)
        (root / "release").write_bytes(release_bytes)
        left = root_files(analyze(root / "source"))
        right = root_files(analyze(root / "release"))
    if left != expected:
        raise ValueError("source-archive-does-not-match-acquisition")
    changes = []
    for path in sorted(left.keys() | right.keys()):
        before, after = left.get(path), right.get(path)
        disposition = ("added" if before is None else "removed" if after is None
                       else "changed" if before["sha256"] != after["sha256"]
                       else "metadata-unavailable" if after["executable"] is None
                       else "mode-changed" if before["executable"] != after["executable"]
                       else "identical-bytes-and-executable-bit")
        changes.append({"path": path, "disposition": disposition,
                        "source": before, "release": after})
    report = {"schema": "slop-provenance-comparison-v1", "state": "quarantined",
              "executionAuthorized": False, "publicationAuthorized": False,
              "source": {key: source[key] for key in ("repository", "commitSha", "treeSha")},
              "inputs": [{"role": role, "sha256": sha, "bytes": len(data)}
                         for role, sha, data in (
                             ("source-inventory", inventory_sha, raw_inventory),
                             ("source-archive", source_sha, source_bytes),
                             ("release-archive", release_sha, release_bytes))],
              "changes": changes, "sourceVisibilityGaps": source["visibilityGaps"],
              "visibilityGaps": ["caller-selected-release-not-authority-verified",
                                 "other-file-modes-signatures-and-build-equivalence-not-compared",
                                 "nested-members-not-root-paths",
                                 "runtime-and-model-review-not-performed"]}
    if len(json.dumps(report).encode()) > MAX_OUTPUT:
        raise ValueError("report-limit")
    return report


if __name__ == "__main__":
    if len(sys.argv) != 7:
        sys.exit("usage: provenance.py INVENTORY SHA SOURCE_ARCHIVE SHA RELEASE_ARCHIVE SHA (private output)")
    try:
        print(json.dumps(compare(*sys.argv[1:]), separators=(",", ":")))
    except Exception:
        # Parser errors and paths can contain private content. No partial comparison.
        print(json.dumps({"schema": "slop-provenance-comparison-v1", "state": "incomplete",
                          "reason": "exact-source-release-comparison-unavailable-or-failed"}))
        sys.exit(1)
