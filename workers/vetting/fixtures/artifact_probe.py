"""Harmless pinned fixture: generated file denial, never a project runner."""
import ctypes
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path('/tmp/slop-quarantine')
assert os.getuid() == 65534
context = Path('/proc/self/attr/current').read_text().strip()
assert context == 'slop-artifact-fixture (enforce)', context
artifacts = {
    'native': Path('/usr/bin/true').read_bytes(),
    'script': b'print("UNEXPECTED_GENERATED_SCRIPT_EXECUTION")\n',
    'wasm': b'\0asm\x01\0\0\0',
    'library': Path('/usr/lib/aarch64-linux-gnu/libm.so.6').read_bytes(),
}
results = {}
for kind, data in artifacts.items():
    path = root / (sys.argv[1] + '-' + kind)
    with path.open('wb') as stream:
        stream.write(data)
    path.chmod(0o755)
    try:
        path.read_bytes()
        raise AssertionError('Generated artifact was readable')
    except PermissionError as error:
        assert error.errno == errno.EACCES
    results[kind] = {'createdBytes': len(data), 'readErrno': errno.EACCES}
    if kind == 'native':
        try:
            subprocess.run([str(path)], check=True)
            raise AssertionError('Generated native artifact executed')
        except PermissionError as error:
            assert error.errno == errno.EACCES
            results[kind]['executeErrno'] = error.errno
    elif kind == 'script':
        attempt = subprocess.run([sys.executable, str(path)], capture_output=True)
        assert attempt.returncode != 0 and b'Permission denied' in attempt.stderr
        results[kind]['interpreterExit'] = attempt.returncode
    elif kind == 'library':
        try:
            ctypes.CDLL(str(path))
            raise AssertionError('Generated library loaded')
        except OSError as error:
            assert 'Permission denied' in str(error)
            results[kind]['loadDenied'] = True
print(json.dumps({'uid': os.getuid(), 'context': context, 'phase': sys.argv[1],
                  'artifacts': results}), flush=True)
# The controller kills its own tracer here. The post-loss phase is a separate
# trusted probe, never continuation of an unobserved repository workflow.
if sys.argv[1] == 'traced':
    while True:
        time.sleep(1)
