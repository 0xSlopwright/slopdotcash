#!/usr/bin/env python3
"""Real Linux HTTPS/DNS/analyzer workflow in a disposable network+mount namespace.
Run as root with: unshare --mount --net --fork python3 dependencies_workflow_test.py
No public network routes, host mounts, public traffic or model calls are used.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time

PUBLIC = '93.184.216.34'
PAYLOAD = b'# harmless captured dependency; never executed\n'
ROOT = Path(__file__).resolve().parent


def call(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    assert sys.platform == 'linux' and os.geteuid() == 0
    # Require a separate namespace before any network or mount mutation.
    assert os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net')
    assert os.readlink('/proc/self/ns/mnt') != os.readlink('/proc/1/ns/mnt')
    call('mount', '--make-rprivate', '/')
    call('ip', 'link', 'set', 'lo', 'up')
    call('ip', 'addr', 'add', PUBLIC + '/32', 'dev', 'lo')
    assert not subprocess.check_output(['ip', 'route', 'show', 'default']).strip()
    with tempfile.TemporaryDirectory(prefix='slop-dependency-workflow-') as temporary:
        root = Path(temporary)
        root.chmod(0o777)
        resolv = root / 'resolv.conf'
        resolv.write_text('nameserver 127.0.0.1\noptions timeout:1 attempts:1\n')
        call('mount', '--bind', str(resolv), '/etc/resolv.conf')
        key, cert = root / 'key.pem', root / 'ca.pem'
        call('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
             '-subj', '/CN=fixture.example', '-addext', 'subjectAltName=DNS:*.fixture.example',
             '-keyout', str(key), '-out', str(cert))
        cert.chmod(0o644)
        calls = {}
        dns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        dns.bind(('127.0.0.1', 53))
        def answer():
            while True:
                try:
                    request, peer = dns.recvfrom(4096)
                except OSError:
                    return
                offset, labels = 12, []
                while request[offset]:
                    size = request[offset]
                    labels.append(request[offset + 1:offset + size + 1].decode())
                    offset += size + 1
                host = '.'.join(labels)
                end = offset + 5
                qtype = struct.unpack('!H', request[offset + 1:offset + 3])[0]
                replies = []
                if qtype == 1:
                    calls[host] = calls.get(host, 0) + 1
                    addresses = {'private.fixture.example': ['10.0.0.1'],
                                 'metadata.fixture.example': ['169.254.169.254'],
                                 'loop.fixture.example': ['127.0.0.1'],
                                 'mixed.fixture.example': [PUBLIC, '192.168.1.1'],
                                 'multicast.fixture.example': ['224.0.0.1'],
                                 'special.fixture.example': ['192.0.0.8']}.get(host, [PUBLIC])
                    if host.startswith('v6'):
                        addresses = []
                    if host == 'rebind.fixture.example' and calls[host] > 1:
                        addresses = ['127.0.0.1']
                    for ip in addresses:
                        replies.append(b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 0, 4) + socket.inet_aton(ip))
                if qtype == 28:
                    ipv6 = {'v6private.fixture.example': 'fd00::1',
                            'v6link.fixture.example': 'fe80::1',
                            'v6mapped.fixture.example': '::ffff:127.0.0.1',
                            'v6relay.fixture.example': '2002:7f00:1::',
                            'v6docs.fixture.example': '3fff::1'}.get(host)
                    if ipv6:
                        replies.append(b'\xc0\x0c' + struct.pack('!HHIH', 28, 1, 0, 16)
                                       + socket.inet_pton(socket.AF_INET6, ipv6))
                header = request[:2] + struct.pack('!HHHHH', 0x8180, 1, len(replies), 0, 0)
                dns.sendto(header + request[12:end] + b''.join(replies), peer)
        threading.Thread(target=answer, daemon=True).start()
        requests = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                requests.append({'path': self.path, 'host': self.headers.get('Host'),
                                 'authorization': self.headers.get('Authorization'),
                                 'cookie': self.headers.get('Cookie')})
                if self.path == '/slow':
                    time.sleep(35)
                    return
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', 'https://169.254.169.254/latest/meta-data/')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                if self.path == '/partial':
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(PAYLOAD)))
                    self.end_headers()
                    self.wfile.write(PAYLOAD[:5])
                    self.wfile.flush()
                    time.sleep(35)
                    return
                data = b'changed dependency' if self.path == '/changed' else PAYLOAD
                self.send_response(200)
                self.send_header('Content-Length', str(9 * 1024 * 1024 if self.path == '/large' else len(data)))
                if self.path == '/chunked':
                    self.send_header('Transfer-Encoding', 'chunked')
                if self.path == '/compressed':
                    self.send_header('Content-Encoding', 'gzip')
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (ssl.SSLError, BrokenPipeError, ConnectionResetError):
                    pass
        server = http.server.ThreadingHTTPServer((PUBLIC, 443), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        source = root / 'source.json'
        source.write_text(json.dumps({'schema': 'slop-source-inventory-v1', 'state': 'quarantined',
                                     'records': []}))
        counter = 0
        def run(url, success=False, *, root_analyzer=False, bad_digest=False, multiple=False):
            nonlocal counter
            counter += 1
            policy = {'schema': 'slop-dependency-fetch-profile-v1',
                      'sourceInventorySha256': sha(source.read_bytes()),
                      'caBundleSha256': sha(cert.read_bytes()),
                      'dependencies': [{'url': url, 'sha256': '0' * 64 if bad_digest else sha(PAYLOAD),
                                        'maxBytes': 1024}]}
            if multiple:
                policy['dependencies'].insert(0, {'url': 'https://good.fixture.example/good',
                                                   'sha256': sha(PAYLOAD), 'maxBytes': 1024})
            profile = root / ('profile-' + str(counter) + '.json')
            profile.write_text(json.dumps(policy))
            output = root / ('run-' + str(counter))
            command = [sys.executable, '-I', str(ROOT / 'dependencies.py'), str(profile),
                       sha(profile.read_bytes()), str(source), str(cert), str(output)]
            if not root_analyzer:
                command = ['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', '--', *command]
            result = subprocess.run(command, capture_output=True, timeout=40, env={})
            if success:
                assert result.returncode == 0, result.stdout.decode()
                inventory = json.loads((output / 'inventory.json').read_text())
                record = inventory['records'][0]
                assert inventory['executionAuthorized'] is False and inventory['state'] == 'quarantined'
                assert record['sha256'] == sha(PAYLOAD) and record['connectedAddress'] == PUBLIC
                assert (output / record['objectPath']).read_bytes() == PAYLOAD
                report = (output / record['inspectionPath']).read_bytes()
                assert sha(report) == record['inspectionSha256']
                assert json.loads(report)['records'][0]['sha256'] == sha(PAYLOAD)
                assert 'offline-fetch-only-no-runtime-proxy' in inventory['visibilityGaps']
            else:
                assert result.returncode != 0, url
                assert not (output / 'inventory.json').exists(), url
                if output.exists():
                    failure = json.loads((output / 'failure.json').read_text())
                    assert failure['state'] == 'incomplete' and failure['executionAuthorized'] is False
                    if '/changed' in url or '/partial' in url or bad_digest or root_analyzer:
                        retained = failure['capturedObjects']
                        assert retained
                        expected = b'changed dependency' if '/changed' in url else PAYLOAD[:5] if '/partial' in url else PAYLOAD
                        assert (output / 'objects' / sha(expected)).read_bytes() == expected
                        assert any(row['sha256'] == sha(expected) for row in retained)
                        assert any(row['dependencyIndex'] == (1 if multiple else 0)
                                   and row['sha256'] == sha(expected) for row in failure['lineage'])
                    if multiple:
                        assert failure['failedIndex'] == 1
                        assert {row['dependencyIndex'] for row in failure['lineage']} == {0, 1}
            print(('PASS capture+isolated-analysis ' if success else 'PASS refused ') + url, flush=True)
        run('https://good.fixture.example/good', True)
        run('https://rebind.fixture.example/good', True)
        assert calls['rebind.fixture.example'] == 1, 'transport performed a second name lookup'
        assert socket.getaddrinfo('rebind.fixture.example', 443, family=socket.AF_INET)[0][4][0] == '127.0.0.1'
        for host in ('private', 'metadata', 'loop', 'mixed', 'multicast', 'special',
                     'v6private', 'v6link', 'v6mapped', 'v6relay', 'v6docs'):
            run('https://' + host + '.fixture.example/good')
        for url in ('https://127.0.0.1/good', 'https://2130706433/good', 'https://[::1]/good',
                    'https://good.fixture.example:443/good', 'http://good.fixture.example/good',
                    'https://user:secret@good.fixture.example/good',
                    'https://good.fixture.example/good?token=secret', 'https://wrong.other.example/good'):
            run(url)
        for path in ('redirect', 'changed', 'large', 'chunked', 'compressed', 'slow', 'partial'):
            run('https://good.fixture.example/' + path)
        run('https://good.fixture.example/changed', multiple=True)
        run('https://good.fixture.example/good', bad_digest=True)
        run('https://good.fixture.example/good', root_analyzer=True)
        assert all(row['authorization'] is None and row['cookie'] is None for row in requests)
        assert all(row['host'] in ('good.fixture.example', 'rebind.fixture.example') for row in requests)
        assert not any(row['path'].startswith('/latest') for row in requests)
        sock = socket.socket()
        sock.settimeout(1)
        try:
            sock.connect(('169.254.169.254', 80))
            raise AssertionError('isolated fixture unexpectedly reached metadata')
        except OSError:
            pass
        finally:
            sock.close()
        server.shutdown()
        dns.close()
        print(f'PASS {counter} real fetch workflows; private DNS/TLS only; no guest execution authorization', flush=True)


if __name__ == '__main__':
    main()
