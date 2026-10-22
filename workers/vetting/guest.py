#!/usr/bin/env python3
"""Trusted fixture collector. Runs only inside the disposable offline guest."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import resource
import signal
import stat
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
    'controlled-proxy-and-complete-filesystem-diff-not-implemented',
)
KERNEL_GAPS = (
    'materialized-file-gate-only-not-interpreter-jit-or-memory-interception',
    'collector-deliberately-terminated-no-complete-runtime-observation',
    'kernel-policy-observation-is-guest-evidence-not-independent-host-proof',
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
    baseline = {'/usr/bin/strace', '/usr/bin/python3', '/usr/bin/setpriv'}
    if 'kernelPolicySha256' in profile:
        baseline |= {'/usr/sbin/apparmor_parser', '/usr/bin/aa-exec'}
        if len(profile['argv']) != 2:
            raise ValueError('Kernel fixture phases are selected by the trusted collector')
    if set(profile['baseline']) != baseline:
        raise ValueError('Exact fixture baseline identities required')
    return profile


class FilesystemCapture:
    """Bounded descriptor-based observations, never an atomic disk snapshot."""
    MAX_BYTES = 672 * 1024
    MAX_ENTRIES = 256
    MAX_METADATA = 64 * 1024

    def __init__(self, root):
        self.root = str(root)
        self.objects = {}
        self.total = 0
        self.metadata = 0
        self.phases = []
        self.gaps = {'captured-filesystem-artifacts-not-inspected-or-released',
                     'filesystem-observation-not-atomic-or-independent-host-proof',
                     'filesystem-writes-between-observations-may-be-unseen',
                     'filesystem-paths-outside-declared-root-not-observed',
                     'filesystem-hardlinks-may-alias-paths-outside-root'}

    @staticmethod
    def identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
                info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def snapshot(self, phase):
        rows = []
        problems = set()
        started = time.time_ns()
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
        rootfd = None
        try:
            rootfd = os.open(self.root, flags | os.O_DIRECTORY)
            root_stat = os.fstat(rootfd)

            def walk(fd, prefix, depth):
                if depth > 8:
                    problems.add('filesystem-depth-limit')
                    return
                before = os.fstat(fd)
                # Bound enumeration itself; do not first allocate a whole listing.
                names = []
                with os.scandir(fd) as entries:
                    for entry in entries:
                        if len(names) + len(rows) >= self.MAX_ENTRIES:
                            problems.add('filesystem-entry-limit')
                            break
                        names.append(entry.name)
                for name in sorted(names):
                    if len(rows) >= self.MAX_ENTRIES:
                        problems.add('filesystem-entry-limit')
                        break
                    path = prefix + name
                    if '\\' in path or len(path.encode('utf8', errors='surrogatepass')) > 2048 or any(ord(c) < 32 or 0xD800 <= ord(c) <= 0xDFFF for c in path):
                        problems.add('filesystem-path-not-representable')
                        continue
                    try:
                        item = os.stat(name, dir_fd=fd, follow_symlinks=False)
                        row = {'path': path, 'mode': item.st_mode, 'uid': item.st_uid,
                               'gid': item.st_gid, 'size': item.st_size,
                               'mtimeNs': item.st_mtime_ns, 'ctimeNs': item.st_ctime_ns,
                               'device': item.st_dev, 'inode': item.st_ino,
                               'links': item.st_nlink}
                        estimated = len(json.dumps(row, separators=(',', ':')).encode()) + 192
                        if self.metadata + estimated > self.MAX_METADATA:
                            problems.add('filesystem-metadata-limit')
                            break
                        self.metadata += estimated
                        rows.append(row)
                        if stat.S_ISLNK(item.st_mode):
                            row['kind'] = 'symlink'
                            problems.add('filesystem-symlink-target-not-followed')
                        elif stat.S_ISDIR(item.st_mode):
                            row['kind'] = 'directory'
                            if item.st_dev != root_stat.st_dev:
                                problems.add('filesystem-mount-not-traversed')
                                continue
                            child = os.open(name, flags | os.O_DIRECTORY, dir_fd=fd)
                            try:
                                if self.identity(item) != self.identity(os.fstat(child)):
                                    raise ValueError('Changed directory')
                                walk(child, path + '/', depth + 1)
                            finally:
                                os.close(child)
                        elif stat.S_ISREG(item.st_mode):
                            row['kind'] = 'file'
                            if item.st_dev != root_stat.st_dev:
                                problems.add('filesystem-mount-not-traversed')
                                continue
                            if item.st_size > self.MAX_BYTES:
                                problems.add('filesystem-object-size-limit')
                                continue
                            pinned = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                            child = None
                            try:
                                pinned_info = os.fstat(pinned)
                                if not stat.S_ISREG(pinned_info.st_mode) or self.identity(item) != self.identity(pinned_info):
                                    raise ValueError('Changed file')
                                # Open only the already pinned regular inode, never a replaced device path.
                                child = os.open('/proc/self/fd/' + str(pinned), os.O_RDONLY | os.O_CLOEXEC)
                                if self.identity(item) != self.identity(os.fstat(child)):
                                    raise ValueError('Changed file')
                                data = bytearray()
                                while len(data) <= self.MAX_BYTES:
                                    chunk = os.read(child, min(65536, self.MAX_BYTES + 1 - len(data)))
                                    if not chunk:
                                        break
                                    data.extend(chunk)
                                if len(data) > self.MAX_BYTES:
                                    problems.add('filesystem-object-size-limit')
                                    continue
                                sha = digest(data)
                                # Preserve the actual bytes even when the later stability check fails.
                                if sha not in self.objects:
                                    if len(self.objects) >= self.MAX_ENTRIES:
                                        problems.add('filesystem-object-count-limit')
                                        continue
                                    if self.total + len(data) > self.MAX_BYTES:
                                        problems.add('filesystem-total-byte-limit')
                                        continue
                                    self.objects[sha] = base64.b64encode(data).decode()
                                    self.total += len(data)
                                row['sha256'] = sha
                                row['capturedBytes'] = len(data)
                                row['stable'] = (self.identity(item) == self.identity(os.fstat(child))
                                                 == self.identity(os.stat(name, dir_fd=fd, follow_symlinks=False))
                                                 and len(data) == item.st_size)
                                if not row['stable']:
                                    problems.add('filesystem-entry-changed-during-capture')
                            finally:
                                if child is not None:
                                    os.close(child)
                                os.close(pinned)
                        else:
                            row['kind'] = 'special'
                            problems.add('filesystem-special-file-not-opened')
                        if self.identity(item) != self.identity(os.stat(name, dir_fd=fd, follow_symlinks=False)):
                            problems.add('filesystem-entry-changed-during-capture')
                    except (OSError, ValueError):
                        problems.add('filesystem-entry-unreadable-or-changed')
                if self.identity(before) != self.identity(os.fstat(fd)):
                    problems.add('filesystem-directory-changed-during-capture')
            walk(rootfd, '', 0)
            if self.identity(root_stat) != self.identity(os.stat(self.root, follow_symlinks=False)):
                problems.add('filesystem-root-changed-during-capture')
        except OSError:
            problems.add('filesystem-root-unavailable')
        finally:
            if rootfd is not None:
                os.close(rootfd)
        self.gaps.update(problems)
        self.phases.append({'phase': phase, 'startedAtNs': started, 'completedAtNs': time.time_ns(),
                            'entries': rows, 'visibilityGaps': sorted(problems)})

    def result(self):
        changes = []
        metadata = self.metadata
        for before, after in zip(self.phases, self.phases[1:]):
            old = {row['path']: row for row in before['entries']}
            new = {row['path']: row for row in after['entries']}
            # These are observed path differences, never proof of a rename or of absence
            # when either enumeration had gaps. Equal hashes do not establish lineage.
            for path in sorted(old.keys() | new.keys()):
                if old.get(path) != new.get(path):
                    change = {'beforePhase': before['phase'], 'afterPhase': after['phase'],
                              'path': path, 'observed': 'added' if path not in old else 'absent' if path not in new else 'changed'}
                    cost = len(json.dumps(change, separators=(',', ':')).encode())
                    if metadata + cost > self.MAX_METADATA:
                        self.gaps.add('filesystem-metadata-limit')
                        break
                    metadata += cost
                    changes.append(change)
        return {'schema': 'slop-filesystem-capture-v1', 'state': 'incomplete',
                'root': self.root, 'maxCapturedBytes': self.MAX_BYTES,
                'phases': self.phases, 'changes': changes, 'objects': self.objects,
                'executionAuthorized': False, 'visibilityGaps': sorted(self.gaps)}


def enforced_policy():
    expected = 'slop-artifact-fixture (enforce)'
    profiles = bounded('/sys/kernel/security/apparmor/profiles', 1024 * 1024).decode().splitlines()
    if expected not in profiles:
        raise ValueError('Required kernel policy is not enforced; source execution refused')
    return expected


def load_policy(profile):
    data = bounded(MEDIA / 'artifact-policy', 65536)
    if digest(data) != profile['kernelPolicySha256']:
        raise ValueError('Kernel policy changed; source execution refused')
    subprocess.run(['/usr/sbin/apparmor_parser', '--replace', '--skip-cache',
                    str(MEDIA / 'artifact-policy')], check=True, timeout=10)
    return enforced_policy()


def failed_policy_probe():
    """Actual harmless negative fixture; never a fallback for source execution."""
    invalid = Path('/root/slop-invalid-policy')
    invalid.write_text('profile slop-fixture-must-not-load { INVALID_POLICY }\n')
    parsed = subprocess.run(['/usr/sbin/apparmor_parser', '--replace', '--skip-cache', str(invalid)],
                            capture_output=True, timeout=10)
    if parsed.returncode == 0:
        raise ValueError('Invalid policy was unexpectedly accepted')
    marker = Path('/tmp/slop-missing-policy-executed')
    entered = subprocess.run(
        ['/usr/bin/aa-exec', '-p', 'slop-fixture-must-not-load', '--', '/usr/bin/python3',
         '-c', "open('/tmp/slop-missing-policy-executed','w').write('unexpected')"],
        capture_output=True, timeout=10)
    if entered.returncode == 0 or marker.exists():
        raise ValueError('Missing kernel policy did not stop execution')
    return {'invalidPolicyExitCode': parsed.returncode, 'missingPolicyExitCode': entered.returncode,
            'executionMarkerAbsent': True}


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
    kernel = None
    argv = profile['argv']
    if 'kernelPolicySha256' in profile:
        negative = failed_policy_probe()
        kernel = {'policySha256': profile['kernelPolicySha256'], 'before': load_policy(profile),
                  'failedLoadProbe': negative}
        quarantine = Path('/tmp/slop-quarantine')
        quarantine.mkdir(mode=0o700)
        os.chown(quarantine, 65534, 65534)
        argv = ['/usr/bin/aa-exec', '-p', 'slop-artifact-fixture', '--', *argv, 'traced']
    filesystem = FilesystemCapture('/tmp/slop-quarantine') if kernel else None
    if filesystem:
        filesystem.snapshot('before-command')
    trace_path, output_path = Path('/root/slop-events.log'), Path('/root/slop-output.log')
    started = time.time()
    termination = 'command-exit'
    command = ['/usr/bin/strace', '--kill-on-exit', '-f', '-ttt', '-yy', '-s', '256',
               '-o', str(trace_path), '--', '/usr/bin/setpriv', '--reuid=65534',
               '--regid=65534', '--clear-groups', '--no-new-privs',
               '--bounding-set=-all', '--inh-caps=-all', *argv]
    with output_path.open('xb') as output:
        process = subprocess.Popen(command, cwd=ROOT, env={'PATH': '/usr/bin:/bin', 'HOME': str(canary)},
                                   stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True, preexec_fn=child_limits)
        try:
            if kernel:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline and process.poll() is None:
                    if b'"phase": "traced"' in bounded(output_path, 65536):
                        break
                    time.sleep(0.05)
                if process.poll() is not None or b'"phase": "traced"' not in bounded(output_path, 65536):
                    raise ValueError('Traced kernel-denial fixture did not reach its checkpoint')
                # Kill the actual ptrace collector, not a mock. --kill-on-exit
                # kills its tracees; no repository workflow is resumed.
                os.kill(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
                termination = 'fixture-collector-killed'
                kernel['collectorExitCode'] = process.returncode
                kernel['afterCollectorDeath'] = enforced_policy()
            else:
                process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            termination = 'command-wall-time-limit'
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    if filesystem:
        filesystem.snapshot('after-traced-command')
    if kernel:
        after_path = Path('/root/slop-after-collector.log')
        with after_path.open('xb') as output:
            after = subprocess.run(
                ['/usr/bin/setpriv', '--reuid=65534', '--regid=65534', '--clear-groups',
                 '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all',
                 '/usr/bin/aa-exec', '-p', 'slop-artifact-fixture', '--',
                 *profile['argv'], 'after-collector'],
                cwd=ROOT, env={'PATH': '/usr/bin:/bin', 'HOME': str(canary)},
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                timeout=15, preexec_fn=child_limits)
        kernel['postCollectorExitCode'] = after.returncode
        kernel['afterProbe'] = enforced_policy()
        kernel['postCollectorOutput'] = base64.b64encode(bounded(after_path, 65536)).decode()
    if filesystem:
        filesystem.snapshot('after-post-collector-probe')
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
    if filesystem:
        filesystem_bytes = json.dumps(filesystem.result(), separators=(',', ':')).encode()
        Path('/root/slop-filesystem.json').write_bytes(filesystem_bytes)
        receipt['filesystemSha256'] = digest(filesystem_bytes)
        receipt['filesystem'] = filesystem_bytes.decode()
        receipt['filesystemEncoding'] = 'json-utf8'
    if kernel:
        receipt['kernelArtifactGate'] = kernel
        receipt['visibilityGaps'].extend(KERNEL_GAPS)
    if process.returncode != 0 or termination != 'command-exit':
        receipt['visibilityGaps'].append('fixture-command-did-not-complete')
    if len(trace) >= MAX_TRACE:
        receipt['visibilityGaps'].append('syscall-stream-resource-limit')
    encoded = base64.b64encode(json.dumps(receipt, separators=(',', ':')).encode()).decode()
    if len(encoded) > 15 * 1024 * 1024 // 4:
        # The overlay retains the capture even if transport cannot carry all evidence.
        raise ValueError('Complete guest receipt exceeds serial frame bound')
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
