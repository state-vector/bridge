#!/usr/bin/env python3
"""Independent opt-in updater. HTTPS hub events are hints; manifests are durable.

Never infers writer quiescence from a heartbeat or lease. The managed runner
acknowledges the nonce only after its worker receivers drain and train joins.
Candidates start under the same hold, so failed health checks cannot launch work.
"""
import argparse
import enum
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import urllib.error
import uuid

MAX_ARCHIVE = 64 * 1024 * 1024


class Phase(str, enum.Enum):
    AVAILABLE = "available"
    DRAINING = "draining"
    INSTALLING = "installing"
    CHECKING = "checking"
    CONFIRMED = "confirmed"
    ROLLING_BACK = "rolling_back"
    ROLLED_BACK = "rolled_back"
    DEFERRED = "deferred"
    FAILED = "failed"


def atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf8") as stream:
        os.chmod(tmp, 0o600)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def read(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default


def opted_in(config):
    update = config.get("auto_update") or {}
    return update.get("enabled") is True and update.get("channel") in ("main", "stable")


def validate_manifest(manifest, channel, target):
    sha = manifest.get("commit", "")
    if manifest.get("schema_version") != 1 or not re.fullmatch("[0-9a-f]{40}", sha):
        raise ValueError("unsupported update manifest")
    if manifest.get("channel") != channel:
        raise ValueError("channel mismatch")
    artifact = manifest["artifacts"][target]
    expected = f"https://github.com/state-vector/bridge/releases/download/runner-{sha}/bridge-{target}.tar.gz"
    if artifact.get("url") != expected or not re.fullmatch("[0-9a-f]{64}", artifact.get("sha256", "")):
        raise ValueError("artifact origin/digest mismatch")
    return artifact


def extract_candidate(archive, destination):
    # No extractall: symlinks, traversal and extra members are forbidden.
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        if len(members) != 1 or members[0].name != "bridge" or not members[0].isfile() or members[0].size > MAX_ARCHIVE:
            raise ValueError("archive must contain exactly one regular bridge executable")
        with tar.extractfile(members[0]) as source, open(destination, "wb") as output:
            shutil.copyfileobj(source, output)
    os.chmod(destination, 0o755)


class Supervisor:
    def __init__(self, binary, home=None):
        self.home = Path(home or Path.home())
        self.root = self.home / ".bridge/update"
        self.root.mkdir(parents=True, exist_ok=True)
        self.binary = Path(binary).resolve()
        self.backup = self.binary.with_name(self.binary.name + ".previous")
        self.request = self.root / "request.json"
        self.state_path = self.root / "state.json"
        self.state = read(self.state_path, {})

    def config(self):
        return read(self.home / ".bridge/config.json", {})

    def record(self, phase, **fields):
        self.state = {**self.state, **fields, "phase": phase.value, "at": int(time.time() * 1000)}
        atomic(self.state_path, self.state)
        print(json.dumps(self.state), flush=True)

    def run(self, args, timeout=60):
        return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=timeout).strip()

    def service(self, action):
        return self.run(["systemctl", "--user", action, "bridge.service"], timeout=120)

    def pid(self):
        return int(self.run(["systemctl", "--user", "show", "bridge.service", "-p", "MainPID", "--value"]) or 0)

    def build(self, binary):
        info = json.loads(self.run([str(binary), "build-info"]))
        if info.get("update_protocol") != 1:
            raise ValueError("bootstrap an update-protocol-1 runner first")
        return info["commit"]

    def notify(self, text):
        # Existing ops/alarm feed is consumed by Bridge Log and the Slack shipper.
        if self.state.get("last_notification") == text:
            return
        atomic(self.root / "notification.json", {"text": text})
        self.flush_notification()

    def flush_notification(self):
        pending = read(self.root / "notification.json") or ({"text": self.state["pending_notification"]} if self.state.get("pending_notification") else None)
        if pending:
            try:
                self.run([str(self.binary), "alarm", "--kind", "ops", pending["text"]])
                self.state.update(last_notification=pending["text"], pending_notification=None)
                atomic(self.state_path, self.state)
                (self.root / "notification.json").unlink(missing_ok=True)
            except (OSError, subprocess.SubprocessError):
                pass  # durable outbox; retry at reconnect/hourly reconciliation

    def idle(self, nonce, pid):
        ack = read(self.root / "idle.json", {})
        return pid > 0 and ack.get("nonce") == nonce and ack.get("pid") == pid and ack.get("phase") == "idle"

    def health(self, commit, deadline=180):
        start = int(time.time() * 1000)
        until = time.monotonic() + deadline
        last_pid = 0
        stable_since = time.monotonic()
        while time.monotonic() < until:
            pid = self.pid()
            if pid != last_pid:
                last_pid, stable_since = pid, time.monotonic()
            receipt = read(self.root / "health.json", {})
            if pid > 0 and receipt.get("pid") == pid and receipt.get("commit") == commit and receipt.get("observed_at", 0) >= start:
                # Check real backend readiness + hub auth with the candidate's doctor.
                self.run([str(self.binary), "doctor"], timeout=90)
                if self.pid() == pid and time.monotonic() - stable_since >= 15:
                    self.run(["systemctl", "--user", "is-active", "bridge.service"])
                    return True
            time.sleep(2)
        return False

    def rollback(self):
        self.record(Phase.ROLLING_BACK)
        if not self.backup.is_file():
            raise RuntimeError("rollback binary missing; update hold retained")
        # The candidate cannot claim work under request.json. Still require its
        # explicit acknowledgement before stopping it (or prove it is stopped).
        pid = self.pid()
        nonce = read(self.request, {}).get("nonce")
        if pid and not self.idle(nonce, pid):
            raise RuntimeError("candidate has not acknowledged idle; hold retained")
        self.service("stop")
        staged = self.binary.with_name(self.binary.name + ".rollback")
        shutil.copy2(self.backup, staged)
        os.replace(staged, self.binary)
        self.service("start")
        if not self.health(self.state["from_commit"]):
            raise RuntimeError("previous binary failed health; hold retained")
        message = f"Bridge update rolled back on {os.uname().nodename}: {self.state['to_commit'][:9]} failed; previous build restored and healthy"
        self.record(Phase.ROLLED_BACK, rejected_commit=self.state["to_commit"], pending_notification=message)
        self.request.unlink(missing_ok=True)
        self.notify(message)

    def recover(self):
        # Never clear an installation hold merely because the supervisor died.
        phase = self.state.get("phase")
        if phase in (Phase.INSTALLING, Phase.CHECKING, Phase.ROLLING_BACK):
            self.rollback()
        elif phase == Phase.DRAINING:
            self.request.unlink(missing_ok=True)
            self.record(Phase.DEFERRED, reason="supervisor restarted before installation; old runner resumes")
        elif phase in (Phase.CONFIRMED, Phase.ROLLED_BACK):
            self.request.unlink(missing_ok=True)
        elif self.request.exists():
            raise RuntimeError("unresolved update hold; inspect update/state.json before recovery")

    def reconcile(self):
        self.flush_notification()
        config = self.config()
        if not opted_in(config):
            return
        channel = config["auto_update"]["channel"]
        target = {"x86_64": "x86_64", "aarch64": "aarch64"}[os.uname().machine] + "-unknown-linux-gnu"
        url = config["url"].rstrip("/") + "/api/runner-updates/manifest?channel=" + channel
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                manifest = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return  # no eligible release yet; subscribe to publication
            raise
        artifact = validate_manifest(manifest, channel, target)
        current, candidate = self.build(self.binary), manifest["commit"]
        if current == candidate or self.state.get("rejected_commit") == candidate:
            return
        # Verify this really is the managed runner, not a stale state file or a
        # differently-installed service. Never stop a bare/nohup runner.
        pid = self.pid()
        if not pid or Path(f"/proc/{pid}/exe").resolve() != self.binary:
            raise RuntimeError("bridge.service must own the configured binary")
        self.record(Phase.AVAILABLE, from_commit=current, to_commit=candidate, channel=channel)
        with tempfile.TemporaryDirectory(dir=self.binary.parent) as temp:
            archive, executable = Path(temp) / "build.tar.gz", Path(temp) / "bridge"
            with urllib.request.urlopen(artifact["url"], timeout=90) as source, open(archive, "wb") as output:
                data = source.read(MAX_ARCHIVE + 1)
                if len(data) > MAX_ARCHIVE or hashlib.sha256(data).hexdigest() != artifact["sha256"]:
                    raise ValueError("artifact checksum/size validation failed")
                output.write(data)
            extract_candidate(archive, executable)
            if self.build(executable) != candidate:
                raise ValueError("candidate embedded commit differs from manifest")
            self.run([str(executable), "doctor"], timeout=90)
            if not opted_in(self.config()) or self.config()["auto_update"]["channel"] != channel:
                return
            nonce = uuid.uuid4().hex
            self.record(Phase.DRAINING, nonce=nonce)
            atomic(self.request, {"nonce": nonce})
            until = time.monotonic() + 900
            while not self.idle(nonce, pid):
                if not opted_in(self.config()) or self.pid() != pid or time.monotonic() > until:
                    self.request.unlink(missing_ok=True)
                    self.record(Phase.DEFERRED, reason="active work did not drain within 15 minutes, opt-in disabled, or runner changed")
                    self.notify("Bridge update deferred: active work was preserved; the current build continues running")
                    return
                time.sleep(2)
            # Backup durable before recording an install intent; recovery can
            # roll back even if the supervisor dies between stop/swap/start.
            shutil.copy2(self.binary, self.backup)
            with open(self.backup, "rb") as stream:
                os.fsync(stream.fileno())
            self.record(Phase.INSTALLING)
            try:
                self.service("stop")
                os.replace(executable, self.binary)
                self.service("start")
                self.record(Phase.CHECKING)
                if not self.health(candidate):
                    raise RuntimeError("candidate did not pass startup/hub/backend health")
                # Write confirmation BEFORE releasing hold: a crash in between
                # resumes the already-verified version, never rolls back writers.
                message = f"Bridge updated successfully on {os.uname().nodename}: {current[:9]} → {candidate[:9]} ({channel}); hub connected, backend ready, runner healthy"
                self.record(Phase.CONFIRMED, pending_notification=message)
                self.request.unlink(missing_ok=True)
                self.notify(message)
            except Exception:
                if self.state.get("phase") != Phase.CONFIRMED:
                    self.rollback()
                raise

    def serve(self):
        self.recover()
        last_check = 0
        backoff = 5
        seen = {}
        while True:
            try:
                # Reconnect snapshots carry persisted channel revisions. No
                # manifest polling on the hub's bounded SSE reconnect cadence.
                if last_check == 0 or time.monotonic() - last_check >= 3600:
                    last_check = time.monotonic()
                    self.reconcile()
                config = self.config()
                if not opted_in(config):
                    time.sleep(30)  # local config only; no network/downloads
                    continue
                url = config["url"].rstrip("/") + "/api/runner-updates/events"
                with urllib.request.urlopen(url, timeout=90) as response:
                    backoff = 5
                    for raw in response:
                        if not opted_in(self.config()):
                            break
                        if raw.startswith(b"data:"):
                            event = json.loads(raw[5:])
                            channel = self.config()["auto_update"]["channel"]
                            if event.get("type") == "runner.update.available" and event.get("channel") == channel and seen.get(channel) != event.get("commit"):
                                seen[channel] = event.get("commit")
                                last_check = time.monotonic()
                                self.reconcile()
                        if time.monotonic() - last_check >= 3600:
                            last_check = time.monotonic()
                            self.reconcile()
            except Exception as error:
                print(f"update supervisor: {error}", flush=True)
                if self.request.exists():
                    # Fail closed; recovery happens under the single supervisor
                    # lock on restart. Never repeat an unknown install effect.
                    self.notify(f"Bridge update requires recovery on {os.uname().nodename}: {error}; writer hold retained")
                    raise
                if isinstance(error, (ValueError, subprocess.CalledProcessError)):
                    self.record(Phase.FAILED, rejected_commit=self.state.get("to_commit"), reason=str(error))
                    self.notify(f"Bridge update verification failed on {os.uname().nodename}: {error}; current runner preserved")
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", required=True)
    args = parser.parse_args()
    supervisor = Supervisor(args.bin)
    with open(supervisor.root / "lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        supervisor.serve()


if __name__ == "__main__":
    main()
