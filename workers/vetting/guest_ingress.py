"""Build and collect a content-bound harmless-source guest run. Never approves scans."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile

from guest import MAX_SOURCE, REQUIRED_GAPS, bounded, digest, inspect_inventory, inspect_profile, bind_command
from vm import copy_pinned, sha256


def build_seed(*, acquisition_directory, source_inventory_sha256, profile, profile_sha256,
               output, xorriso, xorriso_sha256):
    """All approval hashes are private operator inputs, never repository instructions."""
    profile_data = bounded(profile, 65536)
    approved = inspect_profile(profile_data, profile_sha256)
    if approved['sourceInventorySha256'] != source_inventory_sha256:
        raise ValueError('Approved command refers to another acquired source')
    acquisition = Path(acquisition_directory)
    inventory = bounded(acquisition / 'inventory.json', 1024 * 1024)
    records = inspect_inventory(inventory, source_inventory_sha256)
    bind_command(approved, records)
    executable = Path(xorriso).resolve(strict=True)
    if sha256(executable) != xorriso_sha256 or not os.access(executable, os.X_OK):
        raise ValueError('Seed builder executable changed')
    destination = Path(output)
    with tempfile.TemporaryDirectory(prefix='slop-guest-input-', dir=destination.parent) as temporary:
        root = Path(temporary)
        (root / 'objects').mkdir()
        for item in records:
            target = root / 'objects' / item['sha256']
            if not target.exists():
                copy_pinned(acquisition / 'objects' / item['sha256'], item['sha256'], target, MAX_SOURCE)
            if target.stat().st_size != item['bytes']:
                raise ValueError('Acquired object size changed')
        (root / 'profile.json').write_bytes(profile_data)
        (root / 'inventory.json').write_bytes(inventory)
        collector = Path(__file__).with_name('guest.py').read_bytes()
        config = {
            'ssh_pwauth': False, 'disable_root': True, 'package_update': False,
            'package_upgrade': False,
            'write_files': [{'path': '/root/slop-guest.py', 'permissions': '0400',
                             'encoding': 'b64', 'content': base64.b64encode(collector).decode()}],
            'runcmd': [['/usr/bin/python3', '/root/slop-guest.py', profile_sha256]],
        }
        (root / 'user-data').write_text('#cloud-config\n' + json.dumps(config))
        (root / 'meta-data').write_text('instance-id: slop-reviewed-source-fixture\nlocal-hostname: slop-fixture\n')
        (root / 'network-config').write_text('version: 2\nethernets: {}\n')
        # Reserve the destination; never let xorriso overwrite unrelated data.
        with destination.open('xb'):
            pass
        try:
            subprocess.run([str(executable), '-as', 'mkisofs', '-quiet', '-volid', 'cidata',
                            '-joliet', '-rock', '-o', str(destination.resolve()), str(root)],
                           check=True, timeout=30, stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={})
            if destination.stat().st_size > 16 * 1024 * 1024:
                raise ValueError('Source seed exceeds VM input bound')
            destination.chmod(0o400)
            return {'seedSha256': sha256(destination), 'collectorSha256': digest(collector),
                    'profileSha256': profile_sha256, 'sourceInventorySha256': source_inventory_sha256,
                    'seedBuilderSha256': xorriso_sha256, 'fixtureOnly': True}
        except BaseException:
            destination.unlink(missing_ok=True)
            raise


def collect_guest(*, directory, profile, profile_sha256, source_inventory_sha256,
                  acquisition_directory, seed_binding):
    """Validate private serial bytes and retain guest evidence without granting authority."""
    directory = Path(directory)
    approved = inspect_profile(bounded(profile, 65536), profile_sha256)
    if approved['sourceInventorySha256'] != source_inventory_sha256:
        raise ValueError('Source/profile mismatch')
    records = inspect_inventory(bounded(Path(acquisition_directory) / 'inventory.json', 1024 * 1024),
                                source_inventory_sha256)
    vm_bytes = bounded(directory / 'evidence.json', 1024 * 1024)
    vm = json.loads(vm_bytes)
    serial = bounded(directory / 'serial.log', 4 * 1024 * 1024)
    if (vm.get('state') != 'incomplete' or vm.get('exitCode') != 0
            or vm.get('network') != 'no-network-device' or digest(serial) != vm['serialSha256']
            or vm.get('seedSha256') != seed_binding['seedSha256']
            or seed_binding['profileSha256'] != profile_sha256
            or seed_binding['sourceInventorySha256'] != source_inventory_sha256):
        raise ValueError('VM run did not complete with bound private serial evidence')
    prefix = b'SLOP_GUEST_EVIDENCE_V1:'
    lines = [line[len(prefix):] for line in serial.splitlines() if line.startswith(prefix)]
    if len(lines) != 1:
        raise ValueError('Missing or ambiguous guest evidence')
    receipt = json.loads(base64.b64decode(lines[0], validate=True))
    if (receipt.get('schema') != 'slop-guest-syscall-evidence-v1'
            or receipt.get('state') != 'incomplete' or receipt.get('fixtureOnly') is not True
            or receipt.get('profileSha256') != profile_sha256
            or receipt.get('sourceInventorySha256') != source_inventory_sha256
            or receipt.get('sourceSha256') != sorted({item['sha256'] for item in records})
            or not isinstance(receipt.get('visibilityGaps'), list)
            or not receipt['visibilityGaps']):
        raise ValueError('Guest evidence does not bind reviewed fixture inputs')
    if any(not isinstance(gap, str) or not gap or len(gap) > 512 for gap in receipt['visibilityGaps']):
        raise ValueError('Invalid guest coverage data')
    # Required coverage is host policy, never authority delegated to guest JSON.
    receipt['visibilityGaps'] = sorted(set(receipt['visibilityGaps']) | set(REQUIRED_GAPS))
    files = {}
    for key, filename, maximum in [('trace', 'guest-events.log', 1024 * 1024),
                                   ('output', 'guest-output.log', 65536)]:
        value = base64.b64decode(receipt.pop(key), validate=True)
        if len(value) > maximum or digest(value) != receipt[key + 'Sha256']:
            raise ValueError('Guest output changed or exceeded bound')
        files[filename] = value
    # Validate everything before writing an authoritative-looking completion file.
    receipt.update(vmEvidenceSha256=digest(vm_bytes), serialSha256=digest(serial),
                   seedSha256=seed_binding['seedSha256'], collectorSha256=seed_binding['collectorSha256'],
                   publicationAuthorized=False, providerCallsAuthorized=False)
    for filename, value in files.items():
        with (directory / filename).open('xb') as stream:
            stream.write(value)
    encoded = json.dumps(receipt, separators=(',', ':')).encode()
    with (directory / 'guest-source-evidence.json').open('xb') as stream:
        stream.write(encoded)
    return {'path': str(directory / 'guest-source-evidence.json'), 'sha256': digest(encoded)}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, help='Private operator-owned JSON keyword arguments')
    parser.add_argument('--collect', action='store_true')
    options = parser.parse_args()
    arguments = json.loads(bounded(options.config, 65536))
    print(json.dumps((collect_guest if options.collect else build_seed)(**arguments)))
