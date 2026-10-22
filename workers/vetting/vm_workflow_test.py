"""Actual harmless VM boot, offline execution and timeout evidence; no live repository."""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import shutil
import tempfile
from vm import run_vm, sha256, tool, assert_standalone


def main():
    parser = argparse.ArgumentParser()
    for key in ("qemu", "qemu-sha256", "image-tool", "image-tool-sha256"):
        parser.add_argument("--" + key, required=True)
    for key in ("acquisition-directory", "inventory-sha256", "profile", "profile-sha256", "xorriso", "xorriso-sha256"):
        parser.add_argument("--" + key)
    parser.add_argument("--base", required=True)
    parser.add_argument("--base-sha256", required=True)
    parser.add_argument("--firmware", required=True)
    parser.add_argument("--firmware-sha256", required=True)
    parser.add_argument("--firmware-vars", required=True)
    parser.add_argument("--firmware-vars-sha256", required=True)
    parser.add_argument("--evidence-directory", required=True)
    parser.add_argument("--darwin-harmless-fixture", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="slop-vm-fixture-") as name:
        root = Path(name)
        (root / "meta-data").write_text("instance-id: slop-harmless-fixture-909\nlocal-hostname: slop-fixture\n")
        (root / "network-config").write_text("version: 2\nethernets: {}\n")
        # All commands are static reviewed fixture data, never interpolated source.
        (root / "user-data").write_text('''#cloud-config
ssh_pwauth: false
disable_root: true
package_update: false
package_upgrade: false
runcmd:
  - [sh, -c, 'printf "SLOP_FIXTURE_STARTED\\n" > /dev/ttyAMA0; runuser -u nobody -- sh -c "id; printf harmless-fixture > /tmp/slop-fixture; cat /tmp/slop-fixture" > /dev/ttyAMA0 2>&1; ip -brief link > /dev/ttyAMA0; printf "SLOP_FIXTURE_DONE\\n" > /dev/ttyAMA0; poweroff']
''')
        seed = root / "seed.iso"
        subprocess.run(["xorriso", "-as", "mkisofs", "-quiet", "-volid", "cidata",
                        "-joliet", "-rock", "-o", str(seed),
                        str(root / "user-data"), str(root / "meta-data"),
                        str(root / "network-config")], check=True)
        binding = None
        if args.acquisition_directory:
            from guest_ingress import build_seed
            seed.unlink()
            binding = build_seed(acquisition_directory=args.acquisition_directory,
                                 source_inventory_sha256=args.inventory_sha256,
                                 profile=args.profile, profile_sha256=args.profile_sha256,
                                 output=seed, xorriso=args.xorriso, xorriso_sha256=args.xorriso_sha256)
        inputs = dict(qemu=args.qemu, qemu_sha256=args.qemu_sha256,
                      image_tool=args.image_tool, image_tool_sha256=args.image_tool_sha256, base=args.base, base_sha256=args.base_sha256,
                      firmware=args.firmware, firmware_sha256=args.firmware_sha256,
                      firmware_vars=args.firmware_vars, firmware_vars_sha256=args.firmware_vars_sha256,
                      seed=seed, seed_sha256=sha256(seed),
                      output=args.evidence_directory, fixture=args.darwin_harmless_fixture)
        completed = run_vm(**inputs)
        result = json.loads((completed / "evidence.json").read_text())
        serial = (completed / "serial.log").read_text(errors="replace")
        assert result["exitCode"] == 0, "Guest failed; inspect private evidence"
        if binding:
            from guest_ingress import collect_guest
            collected = collect_guest(directory=completed, profile=args.profile,
                                      profile_sha256=args.profile_sha256,
                                      source_inventory_sha256=args.inventory_sha256,
                                      acquisition_directory=args.acquisition_directory, seed_binding=binding)
            receipt = json.loads(Path(collected["path"]).read_text())
            kernel = receipt.get("kernelArtifactGate")
            assert receipt["state"] == "incomplete"
            output = json.loads((completed / "guest-output.log").read_text())
            if kernel:
                assert receipt["exitCode"] == -9 and kernel["postCollectorExitCode"] == 0
                after = json.loads((completed / "guest-after-collector.log").read_text())
                for observed, phase in [(output, "traced"), (after, "after-collector")]:
                    assert observed["uid"] == 65534 and observed["phase"] == phase
                    assert observed["context"] == "slop-artifact-fixture (enforce)"
                    for kind in ("native", "script", "wasm", "library"):
                        assert observed["artifacts"][kind]["readErrno"] == 13
                    assert observed["artifacts"]["native"]["executeErrno"] == 13
                    assert observed["artifacts"]["library"]["loadDenied"] is True
                    assert observed["artifacts"]["script"]["interpreterExit"] != 0
                capture = json.loads((completed / "guest-filesystem.json").read_text())
                assert capture["state"] == "incomplete" and capture["executionAuthorized"] is False
                assert [phase["phase"] for phase in capture["phases"]] == ["before-command", "after-traced-command", "after-post-collector-probe"]
                assert capture["phases"][0]["entries"] == []
                assert len(capture["phases"][1]["entries"]) == 4
                assert len(capture["phases"][2]["entries"]) == 8
                assert len(capture["objects"]) == 4  # phase copies share bytes, not rename authority
                for phase in capture["phases"][1:]:
                    assert not phase["visibilityGaps"]
                    for entry in phase["entries"]:
                        assert entry["stable"] is True
                        saved = completed / ("filesystem-object-" + entry["sha256"])
                        assert saved.stat().st_size == entry["capturedBytes"]
                        assert sha256(saved) == entry["sha256"]
                        assert saved.read_bytes() == base64.b64decode(capture["objects"][entry["sha256"]])
                assert all(change["observed"] == "added" for change in capture["changes"])
                wrong_policy = json.loads(Path(args.profile).read_text())
                wrong_policy["kernelPolicySha256"] = "0" * 64
                wrong_profile = root / "wrong-policy-profile.json"
                wrong_profile.write_text(json.dumps(wrong_policy))
                try:
                    build_seed(acquisition_directory=args.acquisition_directory,
                               source_inventory_sha256=args.inventory_sha256,
                               profile=wrong_profile, profile_sha256=sha256(wrong_profile),
                               output=root / "must-not-build-policy.iso",
                               xorriso=args.xorriso, xorriso_sha256=args.xorriso_sha256)
                    raise AssertionError("Changed policy pin accepted")
                except ValueError:
                    assert not (root / "must-not-build-policy.iso").exists()
            else:
                assert receipt["exitCode"] == 0
                assert output["uid"] == 65534 and output["sourceReadOnly"] is True and output["childExit"] == 0
            # Alter the actual captured serial bytes: collection must fail before
            # a completion receipt is written, even when the guest previously succeeded.
            changed = root / "changed-vm"
            changed.mkdir()
            (changed / "evidence.json").write_bytes((completed / "evidence.json").read_bytes())
            (changed / "serial.log").write_bytes((completed / "serial.log").read_bytes() + b"changed")
            try:
                collect_guest(directory=changed, profile=args.profile,
                              profile_sha256=args.profile_sha256,
                              source_inventory_sha256=args.inventory_sha256,
                              acquisition_directory=args.acquisition_directory, seed_binding=binding)
                raise AssertionError("Changed VM evidence accepted")
            except ValueError:
                assert not (changed / "guest-source-evidence.json").exists()
            # A guest can lie about coverage. Keep required gaps even when its
            # otherwise content-bound receipt claims a different coverage list.
            from guest import REQUIRED_GAPS, KERNEL_GAPS
            forged = root / "guest-coverage-claim"
            forged.mkdir()
            captured = (completed / "serial.log").read_bytes()
            prefix = b"SLOP_GUEST_EVIDENCE_V1:"
            frame = next(line for line in captured.splitlines() if line.startswith(prefix))
            claim = json.loads(base64.b64decode(frame[len(prefix):]))
            claim["visibilityGaps"] = ["guest-claims-coverage"]
            replacement = prefix + base64.b64encode(json.dumps(claim).encode())
            (forged / "serial.log").write_bytes(captured.replace(frame, replacement))
            altered_vm = json.loads((completed / "evidence.json").read_text())
            altered_vm["serialSha256"] = sha256(forged / "serial.log")
            (forged / "evidence.json").write_text(json.dumps(altered_vm))
            collected_claim = collect_guest(directory=forged, profile=args.profile,
                                           profile_sha256=args.profile_sha256,
                                           source_inventory_sha256=args.inventory_sha256,
                                           acquisition_directory=args.acquisition_directory, seed_binding=binding)
            retained = json.loads(Path(collected_claim["path"]).read_text())
            assert set(REQUIRED_GAPS).issubset(retained["visibilityGaps"])
            if kernel:
                assert set(KERNEL_GAPS).issubset(retained["visibilityGaps"])
            altered_profile = root / "changed-profile.json"
            altered_profile.write_bytes(Path(args.profile).read_bytes() + b" ")
            try:
                build_seed(acquisition_directory=args.acquisition_directory,
                           source_inventory_sha256=args.inventory_sha256,
                           profile=altered_profile, profile_sha256=args.profile_sha256,
                           output=root / "must-not-build.iso", xorriso=args.xorriso,
                           xorriso_sha256=args.xorriso_sha256)
                raise AssertionError("Changed approved command accepted")
            except ValueError:
                assert not (root / "must-not-build.iso").exists()
            altered_source = root / "changed-source"
            shutil.copytree(args.acquisition_directory, altered_source)
            # A signed queue bundle also stores template objects. Change an
            # actual Git source object, not an arbitrary directory entry.
            source_inventory = json.loads((altered_source / "inventory.json").read_text())
            object_path = altered_source / "objects" / source_inventory["records"][0]["sha256"]
            object_path.chmod(0o600)
            object_path.write_bytes(object_path.read_bytes() + b"changed")
            try:
                build_seed(acquisition_directory=altered_source,
                           source_inventory_sha256=args.inventory_sha256,
                           profile=args.profile, profile_sha256=args.profile_sha256,
                           output=root / "must-not-build-source.iso", xorriso=args.xorriso,
                           xorriso_sha256=args.xorriso_sha256)
                raise AssertionError("Changed acquired source accepted")
            except ValueError:
                assert not (root / "must-not-build-source.iso").exists()
            trace = (completed / "guest-events.log").read_text()
            observations = ("execve(", "openat(", "slop-quarantine", "EACCES") if kernel else (
                "execve(", "clone", "openat(", "renameat(", "unlinkat(", "connect(",
                "wallet-test.txt", "slop-child-file", "169.254.169.254", "/dev/vda", "EROFS", "EACCES")
            for observed in observations:
                assert observed in trace, "Missing actual syscall observation: " + observed
        else:
            assert "SLOP_FIXTURE_DONE" in serial, "Guest fixture did not complete"
            assert "uid=65534(nobody)" in serial, "Unprivileged guest command was not observed"
            assert "harmless-fixture" in serial
        assert result["network"] == "no-network-device"
        assert result["state"] == "incomplete", "A boot cannot clear a repository"
        assert sha256(args.base) == args.base_sha256
        timed = run_vm(**inputs, timeout=1)
        timeout = json.loads((timed / "evidence.json").read_text())
        assert timeout["termination"] == "wall-time-limit"
        assert timeout["exitCode"] != 0
        assert timeout["state"] == "incomplete"
        # Exercise actual QCOW2 external data metadata, not an invented JSON shape.
        tool([args.image_tool, "create", "-q", "-f", "qcow2", "-o",
              "data_file=" + str(completed / "external.raw"),
              str(completed / "external.qcow2"), "1M"], completed, args.darwin_harmless_fixture)
        external = json.loads(tool([args.image_tool, "info", "--output=json", "-f", "qcow2",
                                    str(completed / "external.qcow2")], completed, args.darwin_harmless_fixture))
        assert external["format-specific"]["data"]["data-file"]
        try:
            assert_standalone(external)
            raise AssertionError("External data image accepted")
        except ValueError:
            pass
        print(json.dumps({"bootEvidence": str(completed), "timeoutEvidence": str(timed),
                          "externalDataImageRejected": True}))


if __name__ == "__main__":
    main()
