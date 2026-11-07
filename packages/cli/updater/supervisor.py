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
# Publications may arrive seconds apart. Preserve an hour of useful work after
# releasing each drain, regardless of candidate SHA or supervisor restarts.
USEFUL_WORK_SECONDS = 3600
DRAIN_SECONDS = 900


def fetch(url, timeout):
    # Cloudflare browser-integrity rejects Python's default UA (403/1010).
    return urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "bridge-runner-updater/1"}), timeout=timeout)


class Phase(str, enum.Enum):
    AVAILABLE = "available"
    DRAINING = "draining"
    INSTALLING = "installing"
    CHECKING = "checking"
    CONFIRMED = "confirmed"
    ROLLING_BACK = "rolling_back"
    RECOVERY_REQUIRED = "recovery_required"
    RECOVERY_PREPARING = "recovery_preparing"
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
        now = int(time.time() * 1000)
        if phase in (Phase.CONFIRMED, Phase.ROLLED_BACK, Phase.DEFERRED):
            fields.setdefault("next_attempt_at", now + USEFUL_WORK_SECONDS * 1000)
        self.state = {**self.state, **fields, "phase": phase.value, "at": now}
        atomic(self.state_path, self.state)
        print(json.dumps(self.state), flush=True)

    def next_check_delay(self):
        remaining = (self.state.get("next_attempt_at", 0) - time.time() * 1000) / 1000
        return min(3600, remaining) if remaining > 0 else 3600

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

    def worker_protocol(self, binary):
        try:
            return json.loads(self.run([str(binary), "build-info"])).get("worker_protocol", 0)
        except (OSError, ValueError, subprocess.SubprocessError):
            return 0  # legacy producers require the original full-drain barrier

    def running_build(self, pid):
        """Bind recovery to the actual managed process and installed executable."""
        try:
            executable = Path(f"/proc/{pid}/exe")
            if pid <= 0 or executable.resolve() != self.binary:
                return None
            commit = self.build(executable)
            return commit if self.build(self.binary) == commit and self.pid() == pid else None
        except (OSError, ValueError, subprocess.SubprocessError):
            return None

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
        phase = ack.get("phase")
        proven = phase == "idle" or (phase == "controller_ready" and self.state.get("handoff_protocol") == 1 and ack.get("worker_protocol") == 1)
        return pid > 0 and ack.get("nonce") == nonce and ack.get("pid") == pid and proven

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
        if self.running_build(pid) != self.state["from_commit"]:
            self.service("stop")
            staged = self.binary.with_name(self.binary.name + ".rollback")
            shutil.copy2(self.backup, staged)
            os.replace(staged, self.binary)
            self.service("start")
        try:
            healthy = self.health(self.state["from_commit"])
        except (OSError, ValueError, subprocess.SubprocessError):
            healthy = False
        if not healthy:
            # The rollback is already applied. Repeating it on every service
            # restart cannot repair health and must not restart the runner again.
            started = self.state.get("attempt_started_at", int(self.request.stat().st_mtime * 1000))
            self.record(Phase.RECOVERY_REQUIRED, reason="previous binary failed health; hold retained",
                        next_attempt_at=max(self.state.get("next_attempt_at", 0), started + USEFUL_WORK_SECONDS * 1000))
            self.notify("Bridge rollback awaits a verified newer build; writer hold retained")
            return
        message = f"Bridge update rolled back on {os.uname().nodename}: {self.state['to_commit'][:9]} failed; previous build restored and healthy"
        self.record(Phase.ROLLED_BACK, rejected_commit=self.state["to_commit"], pending_notification=message)
        self.request.unlink(missing_ok=True)
        self.notify(message)

    def recover(self):
        # Called under the supervisor lock. Reload/migrate only after acquiring
        # it, so a second process cannot overwrite an active installation.
        self.state = read(self.state_path, {})
        if "next_attempt_at" not in self.state and self.state.get("phase") in (
                Phase.CONFIRMED, Phase.ROLLED_BACK, Phase.DEFERRED):
            self.state["next_attempt_at"] = self.state.get("at", 0) + USEFUL_WORK_SECONDS * 1000
            atomic(self.state_path, self.state)
        # Never clear an installation hold merely because the supervisor died.
        phase = self.state.get("phase")
        if phase in (Phase.INSTALLING, Phase.CHECKING, Phase.ROLLING_BACK):
            self.rollback()
        elif phase == Phase.DRAINING:
            self.request.unlink(missing_ok=True)
            self.record(Phase.DEFERRED, reason="supervisor restarted before installation; old runner resumes")
        elif phase in (Phase.CONFIRMED, Phase.ROLLED_BACK):
            self.request.unlink(missing_ok=True)
        elif phase in (Phase.RECOVERY_REQUIRED, Phase.RECOVERY_PREPARING):
            if not self.request.exists():
                raise RuntimeError("recovery hold missing; inspect the managed runner before continuing")
        elif self.request.exists():
            raise RuntimeError("unresolved update hold; inspect update/state.json before recovery")

    def accept_running_candidate(self):
        """Reconcile an already-applied known install, never perform another one.

        An external managed restart may have restored the recorded candidate
        while recovery still says the previous build is installed. Identity,
        nonce, fresh health, stable PID and doctor remain the same real gates.
        This observation neither resets nor bypasses the next-install budget.
        """
        if self.state.get("phase") not in (Phase.RECOVERY_REQUIRED, Phase.RECOVERY_PREPARING):
            return False
        candidate = self.state.get("to_commit")
        if not candidate or candidate == self.state.get("from_commit"):
            return False
        if self.build(self.binary) != candidate:
            return False
        pid = self.pid()
        nonce = read(self.request, {}).get("nonce")
        if not nonce or self.running_build(pid) != candidate or not self.idle(nonce, pid):
            return False
        if not self.health(candidate):
            return False
        if self.pid() != pid or self.running_build(pid) != candidate or not self.idle(nonce, pid):
            return False
        message = f"Bridge verified the already-running candidate on {os.uname().nodename}: {candidate[:9]}; existing update recovered without another install/restart"
        self.record(Phase.CONFIRMED, next_attempt_at=self.state.get("next_attempt_at", 0), pending_notification=message)
        self.request.unlink(missing_ok=True)
        self.notify(message)
        return True

    def reconcile(self):
        self.flush_notification()
        config = self.config()
        if not opted_in(config):
            return
        if self.accept_running_candidate():
            return
        if time.time() * 1000 < self.state.get("next_attempt_at", 0):
            return  # no downloads, doctor, drain, or service changes in cooldown
        recovery_phase = self.state.get("phase")
        recovering = recovery_phase in (Phase.RECOVERY_REQUIRED, Phase.RECOVERY_PREPARING)
        channel = config["auto_update"]["channel"]
        target = {"x86_64": "x86_64", "aarch64": "aarch64"}[os.uname().machine] + "-unknown-linux-gnu"
        url = config["url"].rstrip("/") + "/api/runner-updates/manifest?channel=" + channel
        try:
            with fetch(url, timeout=30) as response:
                manifest = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return  # no eligible release yet; subscribe to publication
            raise
        artifact = validate_manifest(manifest, channel, target)
        current, candidate = self.build(self.binary), manifest["commit"]
        if recovery_phase == Phase.RECOVERY_REQUIRED and candidate == self.state.get("to_commit"):
            return  # a known failed candidate is not a new recovery attempt
        if current == candidate or self.state.get("rejected_commit") == candidate:
            return
        # Verify this really is the managed runner, not a stale state file or a
        # differently-installed service. Never stop a bare/nohup runner.
        pid = self.pid()
        if not pid or Path(f"/proc/{pid}/exe").resolve() != self.binary:
            raise RuntimeError("bridge.service must own the configured binary")
        recovery_request = read(self.request, {}) if recovering else None
        if recovering and (current != self.state.get("from_commit") or self.running_build(pid) != current
                           or not self.idle(recovery_request.get("nonce"), pid)):
            raise RuntimeError("recovery requires the restored managed process and its exact idle acknowledgement")
        self.record(Phase.RECOVERY_PREPARING if recovering else Phase.AVAILABLE, from_commit=current, to_commit=candidate, channel=channel,
                    attempt_started_at=int(time.time() * 1000))
        with tempfile.TemporaryDirectory(dir=self.binary.parent) as temp:
            archive, executable = Path(temp) / "build.tar.gz", Path(temp) / "bridge"
            try:
                with fetch(artifact["url"], timeout=90) as source, open(archive, "wb") as output:
                    data = source.read(MAX_ARCHIVE + 1)
                    if len(data) > MAX_ARCHIVE or hashlib.sha256(data).hexdigest() != artifact["sha256"]:
                        raise ValueError("artifact checksum/size validation failed")
                    output.write(data)
                extract_candidate(archive, executable)
                if self.build(executable) != candidate:
                    raise ValueError("candidate embedded commit differs from manifest")
                self.run([str(executable), "doctor"], timeout=90)
            except Exception:
                if recovering:
                    self.record(Phase.RECOVERY_REQUIRED, reason="newer recovery build failed preflight; hold retained",
                                next_attempt_at=self.state["attempt_started_at"] + USEFUL_WORK_SECONDS * 1000)
                raise
            if not opted_in(self.config()) or self.config()["auto_update"]["channel"] != channel:
                if recovering:
                    self.record(Phase.RECOVERY_REQUIRED, reason="recovery opt-in changed; hold retained")
                return
            nonce = recovery_request["nonce"] if recovering else uuid.uuid4().hex
            # Both directions must understand adoption: rollback may replace
            # the candidate while the same independent workers keep running.
            handoff = 1 if self.worker_protocol(self.binary) == 1 and self.worker_protocol(executable) == 1 else 0
            if not recovering:
                self.record(Phase.DRAINING, nonce=nonce, handoff_protocol=handoff)
            else:
                self.record(Phase.RECOVERY_PREPARING, handoff_protocol=handoff)
            atomic(self.request, {"nonce": nonce, **({"worker_protocol": handoff} if handoff else {})})
            until = time.monotonic() + DRAIN_SECONDS
            while not self.idle(nonce, pid):
                if not opted_in(self.config()) or self.pid() != pid or time.monotonic() > until:
                    if recovering:
                        self.record(Phase.RECOVERY_REQUIRED, reason="recovery process or acknowledgement changed; hold retained",
                                    next_attempt_at=self.state["attempt_started_at"] + USEFUL_WORK_SECONDS * 1000)
                        return
                    self.request.unlink(missing_ok=True)
                    self.record(Phase.DEFERRED, reason="active work did not drain within 15 minutes, opt-in disabled, or runner changed")
                    self.notify("Bridge update deferred: active work was preserved; the current build continues running")
                    return
                time.sleep(2)
            if self.pid() != pid or Path(f"/proc/{pid}/exe").resolve() != self.binary or not self.idle(nonce, pid):
                raise RuntimeError("managed runner or exact idle acknowledgement changed before installation")
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
        next_check = 0
        backoff = 5
        seen = {}
        while True:
            try:
                # Reconnect snapshots carry persisted channel revisions. No
                # manifest polling on the hub's bounded SSE reconnect cadence.
                if time.monotonic() >= next_check:
                    self.reconcile()
                    next_check = time.monotonic() + self.next_check_delay()
                config = self.config()
                if not opted_in(config):
                    time.sleep(30)  # local config only; no network/downloads
                    continue
                url = config["url"].rstrip("/") + "/api/runner-updates/events"
                with fetch(url, timeout=90) as response:
                    backoff = 5
                    for raw in response:
                        if not opted_in(self.config()):
                            break
                        if raw.startswith(b"data:"):
                            event = json.loads(raw[5:])
                            channel = self.config()["auto_update"]["channel"]
                            if event.get("type") == "runner.update.available" and event.get("channel") == channel and seen.get(channel) != event.get("commit"):
                                seen[channel] = event.get("commit")
                                self.reconcile()
                                next_check = time.monotonic() + self.next_check_delay()
                        if time.monotonic() >= next_check:
                            self.reconcile()
                            next_check = time.monotonic() + self.next_check_delay()
            except Exception as error:
                print(f"update supervisor: {error}", flush=True)
                if self.request.exists():
                    # Fail closed; recovery happens under the single supervisor
                    # lock on restart. Never repeat an unknown install effect.
                    self.notify(f"Bridge update requires recovery on {os.uname().nodename}: {error}; writer hold retained")
                    if self.state.get("phase") not in (Phase.RECOVERY_REQUIRED, Phase.RECOVERY_PREPARING):
                        raise
                if not self.request.exists() and isinstance(error, (ValueError, subprocess.CalledProcessError)):
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
