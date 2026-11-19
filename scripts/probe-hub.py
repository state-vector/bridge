#!/usr/bin/env python3
"""Timestamped concurrent task/hub/edge probes; never emits task bodies or credentials."""
import argparse
import concurrent.futures
import datetime
import json
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--seconds', type=int, default=180)
p.add_argument('--task', required=True)
p.add_argument('--include-train', action='store_true')
p.add_argument('--origin', default='https://hub.fleetbridge.run')
p.add_argument('--session-file', type=Path, default=Path.home() / '.bridge/session.json')
a = p.parse_args()
secret = json.loads(a.session_file.read_text())['value']
headers = {'Cookie': 'bridge_session=' + secret, 'User-Agent': 'Mozilla/5.0'}
paths = {'task': '/api/kb/artefact?id=' + urllib.parse.quote(a.task), 'diagnostics': '/api/kb/diagnostics',
         'stateful_version': '/__version?scope=stateful', 'edge_version': '/__version'}
if a.include_train:
    paths['train'] = '/api/kb/train'

def call(name, path):
    started = time.monotonic()
    result = {'name': name}
    try:
        with urllib.request.urlopen(urllib.request.Request(a.origin + path, headers=headers), timeout=30) as r:
            body = json.load(r)
            result['status'] = r.status
            if name.endswith('version'):
                result['commit'] = body.get('commit')
            if name == 'diagnostics':
                result['instance_id'] = body.get('instance_id')
                result['slow_or_active'] = [v for v in body.get('active', []) + body.get('recent', [])
                    if v.get('phase') == 'active' or v.get('elapsed_ms', 0) >= 500 or v.get('ingress_ms', 0) >= 500]
    except urllib.error.HTTPError as error:
        result['status'] = error.code
        # Responses are not dumped: arbitrary error bodies can contain request data.
    except Exception as error:
        result.update(status=None, failure=type(error).__name__)
    result['elapsed_ms'] = round((time.monotonic() - started) * 1000)
    return result

end = time.monotonic() + a.seconds
with concurrent.futures.ThreadPoolExecutor(max_workers=len(paths)) as pool:
    while time.monotonic() < end:
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        pending = [pool.submit(call, name, path) for name, path in paths.items()]
        print(json.dumps({'timestamp': at, 'results': [job.result() for job in pending]}), flush=True)
        time.sleep(2)
