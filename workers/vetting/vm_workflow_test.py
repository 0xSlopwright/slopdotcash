"""Actual harmless VM boot, offline execution and timeout evidence; no live repository."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
from vm import run_vm, sha256, tool, assert_standalone


def main():
    parser = argparse.ArgumentParser()
    for key in ("qemu", "qemu-sha256", "image-tool", "image-tool-sha256"):
        parser.add_argument("--" + key, required=True)
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
