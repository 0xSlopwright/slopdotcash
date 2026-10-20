#!/usr/bin/env python3
"""Pinned, private dependency capture. No guest networking or execution grant."""
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import resource
import socket
import ssl
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from artifacts import analyze

MAX_OBJECT = 8 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
GAPS = ['offline-fetch-only-no-runtime-proxy', 'dynamic-package-resolution-not-supported',
        'custom-pinned-or-opaque-protocols-not-inspected', 'dependencies-not-authorized-for-execution']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('not-regular')
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError('input-limit')
    return data


def digest(value):
    if not isinstance(value, str) or re.fullmatch('[0-9a-f]{64}', value) is None:
        raise ValueError('invalid-digest')
    return value


def address(value):
    ip = ipaddress.ip_address(value)
    special = ('192.0.0.0/24', '192.88.99.0/24') if ip.version == 4 else ('2001::/23', '3fff::/20')
    if (any(ip in ipaddress.ip_network(network) for network in special) or not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_loopback
            or ip.is_link_local or ip.is_unspecified
            or (ip.version == 6 and (ip not in ipaddress.ip_network('2000::/3')
                                    or ip.sixtofour is not None or ip.teredo is not None))):
        raise ValueError('non-public-address')
    return ip


def destination(url):
    if (not isinstance(url, str) or len(url) > 2048 or not url.isascii()
            or any(ord(c) <= 32 or ord(c) == 127 for c in url) or '\\' in url):
        raise ValueError('invalid-url')
    parsed = urlsplit(url)
    host = parsed.hostname or ''
    if (parsed.scheme != 'https' or parsed.netloc != host or parsed.query or parsed.fragment
            or not parsed.path.startswith('/') or len(host) > 253
            or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', host)
            or len(host.split('.')) < 2 or not host.split('.')[-1].isalpha()
            or any(not part or len(part) > 63 or part.startswith('-') or part.endswith('-')
                   for part in host.split('.'))):
        raise ValueError('unapproved-url-form')
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return host, parsed.path
    raise ValueError('ip-literal')


def resolve(host):
    # Bound libc DNS work separately; the transport never resolves the name again.
    result = subprocess.run([sys.executable, '-I', str(Path(__file__).resolve()), '--resolve', host],
                            capture_output=True, timeout=5, check=True, env={})
    values = json.loads(result.stdout)
    if not isinstance(values, list) or not 1 <= len(values) <= 64:
        raise ValueError('dns-answer-limit')
    return [address(value) for value in values]


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, ip, context):
        super().__init__(host, port=443, timeout=5, context=context)
        self.ip = ip

    def connect(self):
        family = socket.AF_INET if self.ip.version == 4 else socket.AF_INET6
        raw = socket.socket(family, socket.SOCK_STREAM)
        raw.settimeout(self.timeout)
        try:
            raw.connect((str(self.ip), 443))
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def download(request):
    # Fixed worker request comes only from the validated parent profile.
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OBJECT, MAX_OBJECT))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    host, path = destination(request['url'])
    addresses = resolve(host)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_verify_locations(cadata=read(request['ca'], 1024 * 1024).decode('ascii'))
    connection = PinnedHTTPS(host, addresses[0], context)
    started = time.time()
    observation = {'resolvedAddresses': [str(ip) for ip in addresses],
                   'connectedAddress': str(addresses[0]), 'startedAt': started}
    observation_path = Path(request['observation'])
    observation_path.write_text(json.dumps(observation))
    try:
        connection.request('GET', path, headers={'Accept-Encoding': 'identity', 'Connection': 'close'})
        tls_version = connection.sock.version()
        response = connection.getresponse()
        observation.update(status=response.status, tlsVersion=tls_version, responseAt=time.time(),
                           contentLength=response.headers.get_all('Content-Length', []),
                           contentEncoding=response.headers.get_all('Content-Encoding', []),
                           transferEncoding=response.headers.get_all('Transfer-Encoding', []),
                           redirects=response.headers.get_all('Location', []))
        observation_path.write_text(json.dumps(observation))
        if (response.status != 200 or response.getheader('Location') is not None
                or response.getheader('Content-Encoding', 'identity') != 'identity'
                or response.getheader('Transfer-Encoding') is not None):
            raise ValueError('unsupported-response')
        lengths = response.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or not re.fullmatch('[0-9]{1,8}', lengths[0]):
            raise ValueError('exact-content-length-required')
        length = int(lengths[0])
        if length > request['maxBytes']:
            raise ValueError('response-limit')
        total = 0
        checksum = hashlib.sha256()
        with open(request['target'], 'xb') as output:
            while True:
                chunk = response.read1(min(65536, length - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > length:
                    raise ValueError('response-limit')
                output.write(chunk)
                checksum.update(chunk)
        if total != length or checksum.hexdigest() != request['sha256']:
            raise ValueError('content-mismatch')
        return {'sha256': checksum.hexdigest(), 'bytes': total, 'status': 200,
                'resolvedAddresses': [str(ip) for ip in addresses], 'connectedAddress': str(addresses[0]),
                'tlsVersion': tls_version, 'startedAt': started, 'finishedAt': time.time()}
    finally:
        connection.close()


def capture(*, profile, profile_sha256, source_inventory, ca_bundle, output):
    data = read(profile, 65536)
    if sha(data) != digest(profile_sha256):
        raise ValueError('profile-changed')
    policy = json.loads(data)
    if set(policy) != {'schema', 'sourceInventorySha256', 'caBundleSha256', 'dependencies'}:
        raise ValueError('invalid-profile')
    if policy['schema'] != 'slop-dependency-fetch-profile-v1':
        raise ValueError('unsupported-profile')
    source = read(source_inventory, 1024 * 1024)
    if (sha(source) != digest(policy['sourceInventorySha256'])
            or json.loads(source).get('schema') != 'slop-source-inventory-v1'
            or json.loads(source).get('state') != 'quarantined'):
        raise ValueError('source-changed')
    ca = read(ca_bundle, 1024 * 1024)
    if sha(ca) != digest(policy['caBundleSha256']):
        raise ValueError('ca-changed')
    entries = policy['dependencies']
    if not isinstance(entries, list) or not 1 <= len(entries) <= 16:
        raise ValueError('dependency-count')
    urls = set()
    budget = 0
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'url', 'sha256', 'maxBytes'}:
            raise ValueError('invalid-dependency')
        destination(entry['url'])
        digest(entry['sha256'])
        if entry['url'] in urls or type(entry['maxBytes']) is not int or not 1 <= entry['maxBytes'] <= MAX_OBJECT:
            raise ValueError('invalid-dependency-bound')
        urls.add(entry['url'])
        budget += entry['maxBytes']
    if budget > MAX_TOTAL:
        raise ValueError('run-limit')
    root = Path(output)
    root.mkdir(mode=0o700)
    index = -1
    records = []
    lineage = []
    try:
        objects, reports = root / 'objects', root / 'inspections'
        objects.mkdir(mode=0o700)
        reports.mkdir(mode=0o700)
        gaps = set(GAPS)
        staging = root / 'staging'
        staging.mkdir(mode=0o700)
        authority = root / 'ca.pem'
        authority.write_bytes(ca)
        (root / 'profile.json').write_bytes(data)
        for index, entry in enumerate(entries):
            target = staging / (str(index) + '.part')
            request = dict(entry, ca=str(authority.resolve()), target=str(target.resolve()),
                           observation=str((staging / (str(index) + '.json')).resolve()))
            result = subprocess.run([sys.executable, '-I', str(Path(__file__).resolve()), '--download'],
                                    input=json.dumps(request).encode(), capture_output=True,
                                    timeout=30, env={})
            observation = json.loads(result.stdout)
            if result.returncode != 0:
                raise ValueError(observation.get('reason', 'transport-failed'))
            captured = read(target, MAX_OBJECT)
            if sha(captured) != entry['sha256'] or len(captured) != observation['bytes']:
                raise ValueError('captured-object-changed')
            lineage.append({'dependencyIndex': index, 'sha256': entry['sha256'],
                            'expectedSha256': entry['sha256']})
            obj = objects / entry['sha256']
            if not obj.exists():
                target.rename(obj)
                obj.chmod(0o400)
            # Same isolated parser used by source artifacts. Failure prevents completion.
            report = analyze(obj)
            report_data = json.dumps(report, separators=(',', ':')).encode()
            report_path = reports / (entry['sha256'] + '.json')
            if not report_path.exists():
                report_path.write_bytes(report_data)
                report_path.chmod(0o400)
            gaps.update(report['visibilityGaps'])
            records.append(dict(observation, dependencyIndex=index, url=entry['url'], state='quarantined',
                                objectPath='objects/' + entry['sha256'],
                                inspectionPath='inspections/' + report_path.name,
                                inspectionSha256=sha(report_data)))
        inventory = {'schema': 'slop-dependency-inventory-v1', 'state': 'quarantined',
                     'sourceInventorySha256': policy['sourceInventorySha256'],
                     'profileSha256': profile_sha256, 'caBundleSha256': policy['caBundleSha256'],
                     'executionAuthorized': False, 'records': records, 'visibilityGaps': sorted(gaps)}
        manifest = json.dumps(inventory, separators=(',', ':')).encode()
        (root / 'inventory.json').write_bytes(manifest)
        (root / 'inventory.json').chmod(0o400)
        authority.unlink()
        return {'directory': str(root), 'inventorySha256': sha(manifest), 'state': 'quarantined'}
    except BaseException as error:
        # Preserve suspicious/partial bytes. Incomplete evidence is never an ingress inventory.
        (root / 'inventory.json').unlink(missing_ok=True)
        (root / 'ca.pem').unlink(missing_ok=True)
        captured = []
        for candidate in sorted((root / 'staging').glob('*.part')):
            payload = read(candidate, MAX_OBJECT)
            checksum = sha(payload)
            dependency_index = int(candidate.stem)
            lineage.append({'dependencyIndex': dependency_index, 'sha256': checksum,
                            'expectedSha256': entries[dependency_index]['sha256']})
            obj = root / 'objects' / checksum
            if not obj.exists():
                candidate.rename(obj)
                obj.chmod(0o400)
        for obj in sorted((root / 'objects').glob('*')):
            payload = read(obj, MAX_OBJECT)
            captured.append({'sha256': sha(payload), 'bytes': len(payload),
                             'objectPath': 'objects/' + obj.name, 'state': 'quarantined'})
        failure = {'schema': 'slop-dependency-fetch-failure-v1', 'state': 'incomplete',
                   'executionAuthorized': False, 'sourceInventorySha256': policy['sourceInventorySha256'],
                   'profileSha256': profile_sha256, 'failedIndex': index, 'reason': failure_reason(error),
                   'lineage': lineage,
                   'observations': [dict(json.loads(read(item, 1024 * 1024)), dependencyIndex=int(item.stem))
                                    for item in sorted((root / 'staging').glob('*.json'))],
                   'capturedObjects': captured, 'visibilityGaps': GAPS + ['dependency-fetch-incomplete']}
        (root / 'failure.json').write_text(json.dumps(failure, separators=(',', ':')))
        (root / 'failure.json').chmod(0o400)
        raise


def failure_reason(error):
    if isinstance(error, subprocess.TimeoutExpired):
        return 'download-timeout'
    if isinstance(error, TimeoutError):
        return 'network-timeout'
    if isinstance(error, ssl.SSLCertVerificationError):
        return 'tls-authentication-failed'
    allowed = {'non-public-address', 'dns-answer-limit', 'unsupported-response',
               'exact-content-length-required', 'response-limit', 'content-mismatch',
               'captured-object-changed', 'tls-authentication-failed', 'transport-failed', 'network-timeout'}
    if type(error) is ValueError and str(error) in allowed:
        return str(error)
    return 'analysis-or-transport-failed'


if __name__ == '__main__':
    try:
        if sys.argv[1:2] == ['--resolve'] and len(sys.argv) == 3:
            answers = sorted({row[4][0] for row in socket.getaddrinfo(sys.argv[2], 443, type=socket.SOCK_STREAM)})
            if len(answers) > 64:
                raise ValueError('dns-answer-limit')
            print(json.dumps(answers))
        elif sys.argv[1:] == ['--download']:
            print(json.dumps(download(json.loads(sys.stdin.buffer.read(65536)))))
        elif len(sys.argv) == 6:
            print(json.dumps(capture(profile=sys.argv[1], profile_sha256=sys.argv[2],
                                     source_inventory=sys.argv[3], ca_bundle=sys.argv[4], output=sys.argv[5])))
        else:
            raise ValueError('usage: profile profile-sha256 source-inventory ca-bundle new-output-directory')
    except Exception as error:
        # Response bytes, private URLs, TLS errors and paths must not leak to logs.
        print(json.dumps({'state': 'incomplete', 'reason': failure_reason(error)}))
        sys.exit(1)
