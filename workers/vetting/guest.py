#!/usr/bin/env python3
"""Trusted fixture collector. Runs only inside the disposable offline guest."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import resource
import signal
import subprocess
import sys
import time

ROOT = Path('/opt/slop/source')
MEDIA = Path('/mnt/slop-input')
MAX_SOURCE = 8 * 1024 * 1024
MAX_TRACE = 1024 * 1024

REQUIRED_GAPS = (
    'fixture-command-only-not-project-workflow',
    'pre-execution-artifact-interception-not-implemented',
    'guest-ptrace-is-not-independent-kernel-telemetry',
    'guest-root-tamper-resistance-not-proven',
    'syscall-string-values-bounded-to-256-bytes',
    'controlled-proxy-and-filesystem-diff-not-implemented',
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def bounded(path, maximum):
    with open(path, 'rb') as stream:
        value = stream.read(maximum + 1)
    if len(value) > maximum:
        raise ValueError('Evidence exceeds bound')
    return value


def safe_path(value):
    if not isinstance(value, str) or not value or len(value.encode()) > 2048:
        raise ValueError('Invalid source path')
    path = PurePosixPath(value)
    if (path.is_absolute() or any(part in ('', '.', '..') for part in value.split('/'))
            or '\\' in value or any(ord(c) < 32 for c in value)):
        raise ValueError('Unsafe source path')
    return path


def inspect_inventory(data, expected):
    if digest(data) != expected:
        raise ValueError('Source inventory changed')
    inventory = json.loads(data)
    if inventory.get('schema') != 'slop-source-inventory-v1' or inventory.get('state') != 'quarantined':
        raise ValueError('Unsupported source inventory')
    records = inventory['records']
    if not isinstance(records, list) or not 1 <= len(records) <= 1000:
        raise ValueError('Invalid source count')
    paths = set()
    total = 0
    for item in records:
        path = str(safe_path(item['path']))
        sha = item['sha256']
        if (item.get('type') != 'blob' or item.get('mode') not in ('100644', '100755')
                or item.get('state') != 'quarantined' or path in paths
                or not isinstance(sha, str) or len(sha) != 64
                or any(c not in '0123456789abcdef' for c in sha)
                or type(item['bytes']) is not int or not 0 <= item['bytes'] <= MAX_SOURCE):
            raise ValueError('Only complete regular-file fixture inputs are supported')
        paths.add(path)
        total += item['bytes']
    if total > MAX_SOURCE:
        raise ValueError('Source exceeds bound')
    for path in paths:
        if any(str(parent) in paths for parent in PurePosixPath(path).parents):
            raise ValueError('Source file conflicts with directory')
    return records


def inspect_profile(data, expected):
    if digest(data) != expected:
        raise ValueError('Operator command profile changed')
    profile = json.loads(data)
    if profile.get('schema') != 'slop-harmless-guest-profile-v1' or profile.get('fixtureOnly') is not True:
        raise ValueError('Arbitrary source execution is disabled until artifact interception exists')
    argv = profile['argv']
    if (not isinstance(argv, list) or not 1 <= len(argv) <= 32
            or any(not isinstance(arg, str) or not arg or '\0' in arg or len(arg) > 4096 for arg in argv)):
        raise ValueError('Invalid approved command')
    if (argv[0] != '/usr/bin/python3' or len(argv) < 2
            or not argv[1].startswith(str(ROOT) + '/')):
        raise ValueError('This fixture profile supports the pinned Python runtime only')
    safe_path(argv[1][len(str(ROOT)) + 1:])
    if set(profile['baseline']) != {'/usr/bin/strace', '/usr/bin/python3', '/usr/bin/setpriv'}:
        raise ValueError('Exact fixture baseline identities required')
    return profile


def bind_command(profile, records):
    entrypoint = profile['argv'][1][len(str(ROOT)) + 1:]
    if entrypoint not in {item['path'] for item in records}:
        raise ValueError('Approved entrypoint is not acquired source')


def child_limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_TRACE, MAX_TRACE))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def main(expected_profile):
    MEDIA.mkdir(mode=0o700, exist_ok=False)
    subprocess.run(['/usr/bin/mount', '-o', 'ro,nosuid,nodev,noexec',
                    '/dev/disk/by-label/cidata', str(MEDIA)], check=True)
    profile_bytes = bounded(MEDIA / 'profile.json', 65536)
    profile = inspect_profile(profile_bytes, expected_profile)
    inventory_bytes = bounded(MEDIA / 'inventory.json', 1024 * 1024)
    records = inspect_inventory(inventory_bytes, profile['sourceInventorySha256'])
    bind_command(profile, records)
    for path, expected in profile['baseline'].items():
        if digest(bounded(path, 32 * 1024 * 1024)) != expected:
            raise ValueError('Guest runtime baseline changed')
    ROOT.mkdir(parents=True, mode=0o755)
    for item in records:
        data = bounded(MEDIA / 'objects' / item['sha256'], MAX_SOURCE)
        if len(data) != item['bytes'] or digest(data) != item['sha256']:
            raise ValueError('Source object changed')
        target = ROOT / str(safe_path(item['path']))
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(data)
        target.chmod(0o444)
    # Bind the entire source tree read-only. Neither the command nor its children
    # receive mount capability. Interpreter input remains readable.
    subprocess.run(['/usr/bin/mount', '--bind', str(ROOT), str(ROOT)], check=True)
    subprocess.run(['/usr/bin/mount', '-o', 'remount,bind,ro,nosuid,nodev,noexec', str(ROOT)], check=True)
    canary = Path('/home/slop-canary')
    canary.mkdir(mode=0o755)
    (canary / 'wallet-test.txt').write_text('SLOP_SYNTHETIC_CANARY_NO_REAL_ACCESS\n')
    (canary / 'wallet-test.txt').chmod(0o444)
    trace_path, output_path = Path('/root/slop-events.log'), Path('/root/slop-output.log')
    started = time.time()
    termination = 'command-exit'
    command = ['/usr/bin/strace', '--kill-on-exit', '-f', '-ttt', '-yy', '-s', '256',
               '-o', str(trace_path), '--', '/usr/bin/setpriv', '--reuid=65534',
               '--regid=65534', '--clear-groups', '--no-new-privs',
               '--bounding-set=-all', '--inh-caps=-all', *profile['argv']]
    with output_path.open('xb') as output:
        process = subprocess.Popen(command, cwd=ROOT, env={'PATH': '/usr/bin:/bin', 'HOME': str(canary)},
                                   stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True, preexec_fn=child_limits)
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            termination = 'command-wall-time-limit'
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    trace = bounded(trace_path, MAX_TRACE)
    output = bounded(output_path, 65536)
    receipt = {
        'schema': 'slop-guest-syscall-evidence-v1', 'state': 'incomplete', 'fixtureOnly': True,
        'sourceInventorySha256': profile['sourceInventorySha256'], 'profileSha256': expected_profile,
        'sourceSha256': sorted({item['sha256'] for item in records}),
        'startedAt': started, 'completedAt': time.time(), 'exitCode': process.returncode,
        'termination': termination, 'traceSha256': digest(trace), 'outputSha256': digest(output),
        'trace': base64.b64encode(trace).decode(), 'output': base64.b64encode(output).decode(),
        'visibilityGaps': list(REQUIRED_GAPS),
    }
    if process.returncode != 0 or termination != 'command-exit':
        receipt['visibilityGaps'].append('fixture-command-did-not-complete')
    if len(trace) >= MAX_TRACE:
        receipt['visibilityGaps'].append('syscall-stream-resource-limit')
    encoded = base64.b64encode(json.dumps(receipt, separators=(',', ':')).encode()).decode()
    with open('/dev/ttyAMA0', 'w') as console:
        console.write('\nSLOP_GUEST_EVIDENCE_V1:' + encoded + '\n')
        console.flush()


if __name__ == '__main__':
    try:
        main(sys.argv[1])
    finally:
        # The fixture never leaves an interactive guest behind after collection.
        subprocess.run(['/usr/bin/sync'], check=False)
        subprocess.run(['/usr/sbin/poweroff', '-f'], check=False)
