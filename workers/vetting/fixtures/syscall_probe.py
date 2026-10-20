"""Harmless reviewed guest fixture: synthetic canary, child I/O and denied access."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

assert os.getuid() == 65534
if sys.argv[1:] == ['child']:
    child_file = Path('/tmp/slop-child-file')
    child_file.write_text('harmless child')
    assert child_file.read_text() == 'harmless child'
    child_file.rename('/tmp/slop-child-renamed')
    Path('/tmp/slop-child-renamed').unlink()
    sock = socket.socket()
    sock.settimeout(1)
    try:
        sock.connect(('169.254.169.254', 80))
        raise AssertionError('Child reached metadata route')
    except OSError:
        pass
    finally:
        sock.close()
    sys.exit(0)
source = Path(__file__)
try:
    source.write_text('must not write')
    raise AssertionError('Source is writable')
except OSError:
    pass
assert Path('/home/slop-canary/wallet-test.txt').read_text() == 'SLOP_SYNTHETIC_CANARY_NO_REAL_ACCESS\n'
child = subprocess.run([sys.executable, str(source), 'child'], check=True)
try:
    with open('/dev/vda', 'rb') as disk:
        disk.read(1)
    raise AssertionError('Raw device became readable')
except OSError:
    pass
print(json.dumps({'fixture': 'source-child-file-socket', 'state': 'observed',
                  'uid': os.getuid(), 'sourceReadOnly': True, 'childExit': child.returncode}))
