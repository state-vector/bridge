#!/usr/bin/env python3
"""Linux same-host recovery of old-daemon slots. Dry-run unless --apply.

Never kill processes, delete work, publish checkpoints or resolve external
operations. A dead daemon AND a complete readable kernel census are required;
lease expiry, task status and an empty runner report alone are not evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request


def stopped_writer_proof(slot, proc=Path('/proc'), uid=None, self_pid=None):
    uid = os.getuid() if uid is None else uid
    self_pid = os.getpid() if self_pid is None else self_pid
    owner, separator, _ = slot['attempt_id'].partition('-')
    if not separator or not owner.isdecimal() or int(owner) <= 1:
        raise RuntimeError('attempt has no recorded daemon PID; retain slot')
    if (proc / owner).exists():
        raise RuntimeError('original daemon still exists; retain slot')
    needles = [slot['attempt_id'].encode(), slot['session'].encode(),
               slot['task_id'].encode(), slot['task_id'].replace('#', '-').encode()]
    inspected = 0
    for process in proc.iterdir():
        if not process.name.isdecimal() or int(process.name) == self_pid:
            continue
        try:
            if process.stat().st_uid != uid:
                continue
            # Every same-UID process must be inspectable. EPERM is not ESRCH.
            data = (process / 'environ').read_bytes() + (process / 'cmdline').read_bytes()
            cwd = os.readlink(process / 'cwd')
            descriptors = list((process / 'fd').iterdir())
            paths = [cwd]
            for descriptor in descriptors:
                try:
                    paths.append(os.readlink(descriptor))
                except FileNotFoundError:
                    pass  # descriptor closed during the census
            inspected += 1
            data += '\n'.join(paths).encode()
            if any(needle in data for needle in needles):
                raise RuntimeError(f'process {process.name} retains this task scope; retain slot')
        except FileNotFoundError:
            if process.exists():
                raise RuntimeError(f'process {process.name} could not be fully inspected; retain slot')
            # The process itself exited during the scan.
    if (proc / owner).exists():
        raise RuntimeError('original daemon appeared during census; retain slot')
    return {'kind': 'kernel_scope_absent', 'daemon_pid': int(owner),
            'uid': uid, 'processes_inspected': inspected, 'observed_at': int(time.time() * 1000)}


class Gateway:
    def __init__(self, home, binary):
        self.home, self.binary = home, binary
        self.uid = home.stat().st_uid
        self.config = json.loads((home / '.bridge/config.json').read_text())
        self.token = (home / '.bridge/gateway-token').read_text().strip()
        self.host = self.config['label']

    def call(self, task, session, command, command_id):
        payload = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                   'params': {'name': 'execution', 'arguments': {
                       'id': task, 'session': session, 'runner_protocol': 'worker-ready-v2',
                       'inventory_protocol': 2, 'command_id': command_id, 'command': command}}}
        request = urllib.request.Request(self.config['url'].rstrip('/') + '/mcp',
            data=json.dumps(payload).encode(), headers={'Authorization': 'Bearer ' + self.token,
                'content-type': 'application/json', 'user-agent': 'bridge-gateway-reconcile/1'})
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.load(response)
        if 'error' in body:
            raise RuntimeError(str(body['error']))
        result = body['result']
        text = result['content'][0]['text']
        if result.get('isError'):
            raise RuntimeError(text)
        return json.loads(text)

    def slots(self):
        command = [self.binary, 'execution', 'schedule-status', self.host]
        if os.getuid() == 0 and self.uid != 0:
            command = ['sudo', '-u', f'#{self.uid}', '-H'] + command
        status = json.loads(subprocess.check_output(command, text=True, timeout=45))
        host = next(h for h in status['hosts'] if h['host'] == self.host)
        print(json.dumps({'host': self.host, 'occupancy': {k: v for k, v in host['occupancy'].items() if k != 'slots'},
                          'eligible': host['eligible']}), flush=True)
        return [slot for slot in host['occupancy']['slots'] if slot['kind'] == 'unconfirmed']

    def reconcile(self, slot, apply):
        task, session = slot['task_id'], slot['session']
        state = self.call(task, session, {'kind': 'inspect'}, 'kernel-inspect-' + str(time.time_ns()))
        attempt = state.get('attempt') or {}
        expected = {k: slot[k] for k in ('generation', 'attempt_id', 'session')}
        if any(attempt.get(k) != value for k, value in expected.items()) or attempt.get('host') != self.host:
            raise RuntimeError('attempt or host changed; retain slot')
        if attempt.get('phase') == 'quiesced':
            return {'task': task, 'result': 'already_quiesced'}
        proof = stopped_writer_proof(slot, uid=self.uid)
        if not apply:
            return {'task': task, 'result': 'proved_stopped_dry_run', 'fence': expected, 'proof': proof}
        # The hub fences generation/attempt/session atomically. The stable
        # command ID replays the original receipt if the response was lost.
        key = hashlib.sha256(json.dumps([self.host, task, expected], sort_keys=True).encode()).hexdigest()
        command = {'kind': 'quiesce', 'generation': slot['generation'],
                   'attempt_id': slot['attempt_id'], 'writers': 'process_group_empty'}
        result = self.call(task, session, command, 'kernel-quiesce-v1-' + key)
        if result.get('attempt', {}).get('phase') != 'quiesced':
            raise RuntimeError('hub did not confirm quiescence')
        if result.get('operations') != state.get('operations'):
            raise RuntimeError('external-operation evidence changed; inspect before further recovery')
        return {'task': task, 'result': 'quiesced', 'fence': expected, 'proof': proof,
                'operations_preserved': True, 'command_id': 'kernel-quiesce-v1-' + key}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--binary', default=str(Path.home() / '.local/bin/bridge'))
    parser.add_argument('--home', type=Path, default=Path.home(), help='Gateway home; root may inspect otherwise unreadable same-UID processes')
    parser.add_argument('--limit', type=int, default=20)
    args = parser.parse_args()
    gateway = Gateway(args.home, args.binary)
    for slot in gateway.slots()[:max(0, min(args.limit, 20))]:
        try:
            result = gateway.reconcile(slot, args.apply)
        except (OSError, RuntimeError, ValueError, KeyError) as error:
            result = {'task': slot['task_id'], 'result': 'retained', 'reason': str(error)}
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
