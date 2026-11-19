#!/usr/bin/env python3
"""Capture sampled production CPU stacks, without exposing API credentials.

Run wrangler whoami first to refresh OAuth, or set CLOUDFLARE_API_TOKEN.
See https://developers.cloudflare.com/workers/observability/profiling-in-production/
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import sys
import tomllib
import urllib.error
import urllib.request

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--account', required=True)
p.add_argument('--worker', default='bridge')
p.add_argument('--namespace')
p.add_argument('--actor')
p.add_argument('--duration-ms', type=int, default=30000)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
if not 1000 <= a.duration_ms <= 50000 or bool(a.namespace) != bool(a.actor):
    p.error('duration must be 1000..50000ms; namespace and actor must be supplied together')
token = os.environ.get('CLOUDFLARE_API_TOKEN')
if not token:
    candidates = [Path.home() / 'Library/Preferences/.wrangler/config/default.toml',
                  Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / '.wrangler/config/default.toml']
    for path in candidates:
        if path.exists():
            token = tomllib.loads(path.read_text()).get('oauth_token')
            if token:
                break
if not token:
    p.error('Set CLOUDFLARE_API_TOKEN or sign in using wrangler')
body = {'duration_ms': a.duration_ms, 'profile_type': 'cpu'}
if a.actor:
    body.update(namespace_id=a.namespace, actor_id=a.actor)
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
u = f'https://api.cloudflare.com/client/v4/accounts/{a.account}/workers/workers/{a.worker}/versions/latest-deployed/profile'
try:
    with urllib.request.urlopen(urllib.request.Request(u, data=json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}), timeout=65) as r:
        data = r.read()
except urllib.error.HTTPError as error:
    print(f'Profile HTTP {error.code}: {error.read().decode()}', file=sys.stderr)
    sys.exit(1)
a.output.parent.mkdir(parents=True, exist_ok=True)
a.output.write_bytes(data)
a.output.with_suffix(a.output.suffix + '.json').write_text(json.dumps({
    'started_at': started, 'finished_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'worker': a.worker, 'request': body, 'bytes': len(data),
}, indent=2) + '\n')
print(f'Saved {len(data)} bytes to {a.output}; inspect with go tool pprof -top -cum {a.output}')
