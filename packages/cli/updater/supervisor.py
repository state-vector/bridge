#!/usr/bin/env python3
"""The single owner of managed runner recovery.

One locked, durable operation survives restarts. The runner supplies facts and
fenced reconciliation; it never chooses an update/recovery policy. No process
exit, lease expiry or missing file is itself stopped-writer evidence.
"""
import argparse
from dataclasses import dataclass, asdict, replace
from enum import Enum
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import urllib.error
import uuid

MAX_ARCHIVE = 64 * 1024 * 1024
COORDINATOR_REVISION = 2
USEFUL_WORK_SECONDS = 3600
DRAIN_SECONDS = 900
HEALTH_SECONDS = 180
STABLE_SECONDS = 15
OBSERVE_SECONDS = 2


def fetch(url, timeout):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "bridge-runner-updater/1"}), timeout=timeout)


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
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


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
    if manifest.get("schema_version") != 1 or not re.fullmatch("[0-9a-f]{40}", sha) or manifest.get("channel") != channel:
        raise ValueError("unsupported update manifest or channel")
    artifact = manifest["artifacts"][target]
    expected = f"https://github.com/state-vector/bridge/releases/download/runner-{sha}/bridge-{target}.tar.gz"
    if artifact.get("url") != expected or not re.fullmatch("[0-9a-f]{64}", artifact.get("sha256", "")):
        raise ValueError("artifact origin/digest mismatch")
    return artifact


def extract_candidate(archive, destination):
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        if len(members) != 1 or members[0].name != "bridge" or not members[0].isfile() or members[0].size > MAX_ARCHIVE:
            raise ValueError("archive must contain exactly one regular bridge executable")
        with tar.extractfile(members[0]) as source, open(destination, "wb") as output:
            shutil.copyfileobj(source, output)
            output.flush()
            os.fsync(output.fileno())
    os.chmod(destination, 0o755)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class InstallStep(str, Enum):
    STOP = "stop"
    SWAP = "swap"
    START = "start"


class ReconcileStep(str, Enum):
    FREEZE = "freeze"
    PROVE = "prove"
    STOP = "stop"
    APPLY = "apply"
    LEGACY_START = "start"  # read-only continuation adapter for early v2 journals


class Reason(str, Enum):
    PREREQUISITE = "prerequisite"
    HANDOFF = "handoff"
    RECONCILIATION = "reconciliation"
    TRANSPORT = "transport"
    RESTORED_HEALTH = "restored_health"


class Intent(str, Enum):
    UPDATE = "update"
    RESTORE_RECOVERY = "restore_recovery"


class Verification(str, Enum):
    INSTALLED = "installed"
    ALREADY_RUNNING = "already_running"


class Outcome(str, Enum):
    CONFIRMED = "confirmed"
    ROLLED_BACK = "rolled_back"


@dataclass(frozen=True)
class Process:
    pid: int
    boot: str
    start: str
    commit: str
    born_at: int = 0


@dataclass(frozen=True)
class Operation:
    nonce: str
    source: str
    target: str
    channel: str
    controller: Process | None
    started_at: int
    deadline: int
    next_attempt_at: int
    worker_protocol: int
    intent: Intent = Intent.UPDATE


@dataclass(frozen=True)
class Idle:
    next_attempt_at: int = 0
    rejected: str = ""


@dataclass(frozen=True)
class Preparing:
    operation: Operation
    url: str
    archive_digest: str


@dataclass(frozen=True)
class Handoff:
    operation: Operation
    candidate_digest: str


@dataclass(frozen=True)
class Reconciling:
    operation: Operation
    candidate_digest: str
    step: ReconcileStep


@dataclass(frozen=True)
class Installing:
    operation: Operation
    candidate_digest: str
    step: InstallStep


@dataclass(frozen=True)
class Verifying:
    operation: Operation
    since: int
    mode: Verification = Verification.INSTALLED


@dataclass(frozen=True)
class Restoring:
    operation: Operation
    step: InstallStep


@dataclass(frozen=True)
class VerifyingRestored:
    operation: Operation
    since: int


Active = Preparing | Handoff | Reconciling | Installing | Verifying | Restoring | VerifyingRestored


@dataclass(frozen=True)
class Waiting:
    reason: Reason
    detail: str
    retry_at: int
    resume: Active


@dataclass(frozen=True)
class Finished:
    operation: Operation
    outcome: Outcome
    next_attempt_at: int
    rejected: str
    notification: str


@dataclass(frozen=True)
class Legacy:
    """Read-only input adapter; never a second recovery implementation."""
    receipt: dict


State = Idle | Active | Waiting | Finished | Legacy
KINDS = {cls.__name__.lower(): cls for cls in (Idle, Preparing, Handoff, Reconciling, Installing, Verifying, Restoring, VerifyingRestored, Waiting, Finished, Legacy)}


def encode(state):
    data = asdict(state)
    if isinstance(state, Waiting):
        data["resume"] = encode(state.resume)
    return {"schema_version": 2, "coordinator_revision": COORDINATOR_REVISION, "phase": type(state).__name__.lower(), **data}


def decode(data):
    if data is None or data == {}:
        return Idle()
    if not isinstance(data, dict):
        raise ValueError("recovery journal must be a versioned object")
    if "schema_version" not in data:
        return Legacy(data)
    if data["schema_version"] != 2 or data.get("phase") not in KINDS:
        raise ValueError("unknown recovery state; original journal and hold retained")
    cls = KINDS[data["phase"]]
    if data.get("coordinator_revision",0)>COORDINATOR_REVISION:
        raise ValueError("newer recovery coordinator owns this journal")
    fields = {k: v for k, v in data.items() if k not in ("schema_version", "coordinator_revision", "phase")}
    if "operation" in fields:
        op = fields["operation"]
        if not re.fullmatch("[0-9a-f]{32}", op["nonce"]) or any(not re.fullmatch("[0-9a-f]{40}", op[key]) for key in ("source", "target")):
            raise ValueError("invalid saved recovery identity")
        if op["channel"] not in ("main", "stable") or op["worker_protocol"] not in (0, 1):
            raise ValueError("unsupported saved recovery protocol/channel")
        fields["operation"] = Operation(**{**op, "controller": Process(**op["controller"]) if op["controller"] is not None else None, "intent":Intent(op.get("intent", "update"))})
    if cls is Waiting:
        fields["reason"] = Reason(fields["reason"])
        fields["resume"] = decode(fields["resume"])
        if not isinstance(fields["resume"], (Preparing, Handoff, Reconciling, Installing, Verifying, Restoring, VerifyingRestored)):
            raise ValueError("invalid recovery continuation")
        if data.get("coordinator_revision",0)<COORDINATOR_REVISION and fields["reason"] is Reason.TRANSPORT and isinstance(fields["resume"],Restoring) and fields["resume"].step is InstallStep.STOP:
            # Early v2 incorrectly used job-idle acknowledgement as health.
            # Re-observe the same known candidate before any rollback effect;
            # real process/nonce/health/doctor checks still decide the outcome.
            saved=fields["resume"]
            return Verifying(saved.operation,saved.operation.started_at)
        if fields["reason"] is Reason.RECONCILIATION and isinstance(fields["resume"],Handoff):
            saved=fields["resume"]
            return Reconciling(saved.operation,saved.candidate_digest,ReconcileStep.LEGACY_START)
    if cls is Reconciling:
        fields["step"] = ReconcileStep(fields["step"])
    if cls in (Installing, Restoring):
        fields["step"] = InstallStep(fields["step"])
    if cls is Verifying:
        fields["mode"] = Verification(fields["mode"])
    if cls is Finished:
        fields["outcome"] = Outcome(fields["outcome"])
    if cls in (Preparing, Handoff, Reconciling) and fields["operation"].controller is None:
        raise ValueError("recovery phase requires a proved controller identity")
    if cls in (Handoff, Reconciling, Installing) and not re.fullmatch("[0-9a-f]{64}", fields["candidate_digest"]):
        raise ValueError("saved installation digest is invalid")
    return cls(**fields)


class SupervisorUpgraded(BaseException):
    """Restart this sole coordinator after its confirmed, durable self-update."""


class Supervisor:
    def __init__(self, binary, home=None):
        self.home = Path(home or Path.home())
        self.root = self.home / ".bridge/update"
        self.root.mkdir(parents=True, exist_ok=True)
        self.binary = Path(binary).resolve()
        self.backup = self.binary.with_name(self.binary.name + ".previous")
        self.request = self.root / "request.json"
        self.state_path = self.root / "state.json"
        self.state = decode(read(self.state_path, {}))
        self.reported = None

    def config(self):
        return read(self.home / ".bridge/config.json", {})

    def save(self, state):
        resuming = isinstance(self.state, Waiting) and state == self.state.resume
        atomic(self.state_path, encode(state))
        self.state = state
        view = encode(state)
        if isinstance(state, Waiting):
            view = {key:value for key,value in view.items() if key != "retry_at"}
        if not resuming and view != self.reported:
            print(json.dumps(view), flush=True)
            self.reported = view

    def run(self, args, timeout=60):
        return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=timeout).strip()

    def service(self, action):
        return self.run(["systemctl", "--user", action, "bridge.service"], timeout=120)

    def pid(self):
        return int(self.run(["systemctl", "--user", "show", "bridge.service", "-p", "MainPID", "--value"]) or 0)

    def stopped(self):
        # PID zero during an activating/queued start is not a stopped boundary.
        state=self.run(["systemctl","--user","show","bridge.service","-p","ActiveState","--value"])
        job=self.run(["systemctl","--user","show","bridge.service","-p","Job","--value"])
        return state in ("inactive","failed") and job in ("","0") and self.pid()==0

    def info(self, binary):
        info = json.loads(self.run([str(binary), "build-info"]))
        if info.get("update_protocol") != 1:
            raise ValueError("unsupported managed-runner protocol")
        return info

    def build(self, binary):
        return self.info(binary)["commit"]

    def process(self):
        pid = self.pid()
        if not pid:
            return None
        proc = Path(f"/proc/{pid}")
        if (proc / "exe").resolve() != self.binary:
            raise RuntimeError("managed service does not own the configured binary")
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        start = (proc / "stat").read_text().rsplit(") ", 1)[1].split()[19]
        boot_seconds = next(int(line.split()[1]) for line in Path("/proc/stat").read_text().splitlines() if line.startswith("btime "))
        born_at = int((boot_seconds + int(start) / os.sysconf("SC_CLK_TCK")) * 1000)
        process = Process(pid, boot, start, self.build(proc / "exe"), born_at)
        if self.pid() != pid or self.build(self.binary) != process.commit:
            raise RuntimeError("managed process changed while checking its identity")
        return process

    def candidate(self, operation):
        return self.root / "candidates" / operation.nonce / "bridge"

    def own_request(self, op):
        value = read(self.request)
        if value is not None and value.get("nonce") != op.nonce:
            raise RuntimeError("another recovery owns the admission hold")
        atomic(self.request, {"nonce": op.nonce, "worker_protocol": op.worker_protocol,
                              "source": op.source, "target": op.target, "deadline": op.deadline})

    def release_request(self, op):
        value = read(self.request)
        if value is not None:
            if value.get("nonce") != op.nonce:
                raise RuntimeError("changed admission hold must not be cleared")
            self.request.unlink()

    def idle(self, op, process):
        path = self.root / "idle.json"
        ack = read(path, {})
        if process is not None and process.born_at and (not path.exists() or path.stat().st_mtime_ns // 1_000_000 < process.born_at):
            return False
        return process is not None and ack.get("pid") == process.pid and ack.get("nonce") == op.nonce and (
            ack.get("phase") == "idle" or (ack.get("phase") == "controller_ready" and op.worker_protocol == 1 and ack.get("worker_protocol") == 1))

    def health(self, op, commit, since):
        until = time.monotonic() + HEALTH_SECONDS
        stable = None
        stable_since = time.monotonic()
        while time.monotonic() < until:
            current = self.process()
            if current != stable:
                stable, stable_since = current, time.monotonic()
            receipt = read(self.root / "health.json", {})
            if current and current.commit == commit and receipt.get("phase")=="ready" and receipt.get("pid") == current.pid and receipt.get("commit") == commit and receipt.get("observed_at", 0) >= since:
                try:
                    self.run([str(self.binary), "doctor"], timeout=90)
                except subprocess.CalledProcessError:
                    return False
                if self.process() == current and time.monotonic() - stable_since >= STABLE_SECONDS and read(self.request, {}).get("nonce") == op.nonce:
                    return True
            time.sleep(OBSERVE_SECONDS)
        return False

    def finish(self, op, outcome, rejected="", preserve_budget=False):
        outcome = Outcome(outcome)
        deadline = op.next_attempt_at if preserve_budget else max(op.next_attempt_at, int(time.time() * 1000) + USEFUL_WORK_SECONDS * 1000)
        message = f"Bridge recovery {outcome.value} on {os.uname().nodename}: {op.source[:9]} → {op.target[:9]}"
        self.save(Finished(op, outcome, deadline, rejected, message))

    def wait(self, reason, detail, resume, seconds=5):
        self.save(Waiting(reason, detail, int(time.time() * 1000) + seconds * 1000, resume))

    def migrate(self, state):
        old = state.receipt
        original = self.state_path.read_bytes()
        archive = self.root / "history" / ("state-v1-" + hashlib.sha256(original).hexdigest() + ".json")
        if not archive.exists():
            atomic(archive, old)
        phase = old.get("phase")
        budget = old.get("next_attempt_at", old.get("at", 0) + USEFUL_WORK_SECONDS * 1000 if phase in ("confirmed", "rolled_back", "deferred") else 0)
        if phase in (None, "confirmed", "rolled_back", "deferred", "failed", "available") and not self.request.exists():
            self.save(Idle(budget, old.get("rejected_commit", "")))
            return
        nonce = read(self.request, {}).get("nonce")
        current = self.process()
        installed = self.build(self.binary)
        if not nonce or old.get("nonce") != nonce or installed not in (old.get("from_commit"), old.get("to_commit")) or (current and current.commit != installed):
            raise RuntimeError("legacy recovery identity is unproved; original record and hold retained")
        op = Operation(nonce, old["from_commit"], old["to_commit"], old.get("channel", "main"), current,
                       old.get("attempt_started_at", old.get("at", 0)), old.get("at", 0) + DRAIN_SECONDS * 1000, budget, old.get("handoff_protocol", 0))
        if phase=="draining" and installed==op.source:
            # v1 committed no installation intent. Its own interrupted hold
            # can be released without requiring the old code to settle jobs.
            self.release_request(op)
            self.save(Idle(budget,old.get("rejected_commit","")))
            return
        if phase=="recovery_preparing" and current and installed==op.source:
            if int(time.time()*1000)<budget:return
            config=self.config()
            if not opted_in(config):return
            target={"x86_64":"x86_64","aarch64":"aarch64"}[os.uname().machine]+"-unknown-linux-gnu"
            with fetch(config["url"].rstrip("/")+"/api/runner-updates/manifest?channel="+op.channel,30) as response:
                manifest=json.load(response)
            artifact=validate_manifest(manifest,op.channel,target)
            if manifest["commit"] in (op.source,old.get("rejected_commit")):return
            self.save(Preparing(replace(op,target=manifest["commit"],intent=Intent.RESTORE_RECOVERY),artifact["url"],artifact["sha256"]))
            return
        if current and current.commit == op.target:
            self.save(Verifying(op, int(time.time() * 1000), Verification.ALREADY_RUNNING))
        elif phase in ("draining", "recovery_preparing", "recovery_required", "installing", "checking", "rolling_back"):
            if current:
                self.save(VerifyingRestored(op, int(time.time() * 1000)))
            else:
                self.save(Restoring(op, InstallStep.SWAP))
        else:
            raise RuntimeError("unknown legacy recovery phase; original hold retained")

    def step(self):
        state = self.state
        now = int(time.time() * 1000)
        if isinstance(state, Legacy):
            self.migrate(state)
        elif isinstance(state, Idle):
            config = self.config()
            if not opted_in(config) or now < state.next_attempt_at:
                return
            channel = config["auto_update"]["channel"]
            target = {"x86_64": "x86_64", "aarch64": "aarch64"}[os.uname().machine] + "-unknown-linux-gnu"
            try:
                with fetch(config["url"].rstrip("/") + "/api/runner-updates/manifest?channel=" + channel, 30) as response:
                    manifest = json.load(response)
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    return
                raise
            artifact = validate_manifest(manifest, channel, target)
            current = self.process()
            if not current or current.commit == manifest["commit"] or manifest["commit"] == state.rejected:
                return
            if self.request.exists():
                raise RuntimeError("unowned admission hold; do not start another recovery")
            op = Operation(uuid.uuid4().hex, current.commit, manifest["commit"], channel, current, now,
                           now + DRAIN_SECONDS * 1000, state.next_attempt_at, 0)
            self.save(Preparing(op, artifact["url"], artifact["sha256"]))
        elif isinstance(state, Waiting):
            if now >= state.retry_at:
                if state.reason is Reason.RESTORED_HEALTH:
                    op = state.resume.operation
                    current = self.process()
                    config = self.config()
                    if now >= max(op.next_attempt_at, op.started_at + USEFUL_WORK_SECONDS * 1000) and opted_in(config) and current and current.commit == op.source:
                        target = {"x86_64":"x86_64", "aarch64":"aarch64"}[os.uname().machine] + "-unknown-linux-gnu"
                        with fetch(config["url"].rstrip("/") + "/api/runner-updates/manifest?channel=" + op.channel, 30) as response:
                            manifest = json.load(response)
                        artifact = validate_manifest(manifest, op.channel, target)
                        if manifest["commit"] not in (op.source, op.target):
                            self.save(Preparing(replace(op, target=manifest["commit"], controller=current, started_at=now,
                                deadline=now + DRAIN_SECONDS * 1000, intent=Intent.RESTORE_RECOVERY), artifact["url"], artifact["sha256"]))
                            return
                self.save(state.resume)
        elif isinstance(state, Preparing):
            config = self.config()
            if not opted_in(config) or config["auto_update"]["channel"] != state.operation.channel:
                if state.operation.intent is Intent.RESTORE_RECOVERY:
                    self.wait(Reason.PREREQUISITE, "Recovery configuration changed; existing hold retained", state, 30)
                else:
                    self.save(Idle(state.operation.next_attempt_at))
                return
            executable = self.candidate(state.operation)
            executable.parent.mkdir(parents=True, exist_ok=True)
            archive = executable.with_suffix(".tar.gz")
            with fetch(state.url, 90) as source:
                data = source.read(MAX_ARCHIVE + 1)
            if len(data) > MAX_ARCHIVE or hashlib.sha256(data).hexdigest() != state.archive_digest:
                raise ValueError("artifact checksum/size validation failed")
            archive.write_bytes(data)
            extract_candidate(archive, executable)
            if self.build(executable) != state.operation.target:
                raise ValueError("candidate embedded commit differs from manifest")
            self.run([str(executable), "doctor"], timeout=90)
            protocol = 1 if self.info(self.binary).get("worker_protocol") == self.info(executable).get("worker_protocol") == 1 else 0
            self.save(Handoff(replace(state.operation, worker_protocol=protocol), digest(executable)))
        elif isinstance(state, Handoff):
            op = state.operation
            if not opted_in(self.config()):
                if op.intent is Intent.RESTORE_RECOVERY:
                    self.wait(Reason.PREREQUISITE, "Recovery opt-in changed; existing hold retained", state, 30)
                    return
                self.release_request(op)
                self.save(Idle(op.next_attempt_at))
                return
            self.own_request(op)
            current = self.process()
            if current and current.commit == op.target:
                self.save(Verifying(op, now, Verification.ALREADY_RUNNING))
                return
            if not current or current.commit != op.source:
                raise RuntimeError("source controller changed build; preserve the recovery hold")
            if (op.intent is Intent.UPDATE and self.config().get("role") != "train"
                    and self.info(self.binary).get("upgrade_notice_protocol") == 1):
                notice = read(self.root / "upgrade-notice.json", {})
                if notice.get("nonce") != op.nonce or notice.get("pid") != current.pid:
                    if now >= op.deadline:
                        self.release_request(op)
                        self.save(Idle(max(op.next_attempt_at, now + USEFUL_WORK_SECONDS * 1000)))
                    else:
                        self.wait(Reason.HANDOFF, "Waiting for the hub to record the planned gateway upgrade", state, 5)
                    return
            if self.idle(op, current):
                # A same-build controller restart is a participant reconnect,
                # not a failed update or a new retry budget.
                op = replace(op, controller=current)
                shutil.copy2(self.binary, self.backup)
                with self.backup.open("rb") as stream:
                    os.fsync(stream.fileno())
                self.save(Installing(op, state.candidate_digest, InstallStep.STOP))
            elif op.worker_protocol == 1 and self.info(self.candidate(op)).get("recovery_protocol") == 1:
                self.save(Reconciling(replace(op, controller=current), state.candidate_digest, ReconcileStep.FREEZE))
            elif now >= op.deadline:
                if op.intent is Intent.RESTORE_RECOVERY:
                    self.wait(Reason.HANDOFF,"Restored controller still needs a safe handoff; hold retained",state,30)
                else:
                    self.release_request(op)
                    self.save(Idle(max(op.next_attempt_at, now + USEFUL_WORK_SECONDS * 1000)))
            else:
                self.wait(Reason.HANDOFF, "Waiting for the original controller's handoff facts", state)
        elif isinstance(state, Reconciling):
            op = state.operation
            self.own_request(op)
            if state.step is ReconcileStep.LEGACY_START:
                current=self.process()
                if current is None:self.save(replace(state,step=ReconcileStep.APPLY))
                elif current.commit==op.source:self.save(Handoff(replace(op,controller=current),state.candidate_digest))
                elif current.commit==op.target:self.save(Verifying(op,now,Verification.ALREADY_RUNNING))
                else:raise RuntimeError("Legacy continuation refers to a different running build")
            elif state.step is ReconcileStep.FREEZE:
                if self.process() != op.controller:
                    self.save(Handoff(op, state.candidate_digest))
                    return
                self.service("freeze")
                self.save(replace(state, step=ReconcileStep.PROVE))
            elif state.step is ReconcileStep.PROVE:
                facts = json.loads(self.run([str(self.candidate(op)), "recovery", "boundary", str(op.controller.pid), op.nonce, op.source]))
                if facts.get("kind") != "controller_only":
                    self.service("thaw")
                    if now>=op.deadline and op.intent is Intent.UPDATE:
                        self.release_request(op)
                        self.save(Idle(max(op.next_attempt_at,now+USEFUL_WORK_SECONDS*1000)))
                    else:
                        self.wait(Reason.HANDOFF, "Controller still owns active work; preserving it", Handoff(op, state.candidate_digest),30)
                    return
                if self.process() != op.controller:
                    raise RuntimeError("frozen controller identity changed")
                self.save(replace(state, step=ReconcileStep.STOP))
            elif state.step is ReconcileStep.STOP:
                if self.pid():
                    if self.process() != op.controller:
                        raise RuntimeError("refuse to stop a different controller")
                    proof = json.loads(self.run([str(self.candidate(op)), "recovery", "boundary", str(op.controller.pid), op.nonce, op.source]))
                    if proof.get("kind") != "controller_only":
                        raise RuntimeError("frozen boundary proof changed; do not stop the controller")
                    self.service("stop")
                self.save(replace(state, step=ReconcileStep.APPLY))
            elif state.step is ReconcileStep.APPLY:
                if not self.stopped():
                    current=self.process()
                    if current and current.commit==op.source:self.save(Handoff(replace(op,controller=current),state.candidate_digest));return
                    if current and current.commit==op.target:self.save(Verifying(op,now,Verification.ALREADY_RUNNING));return
                    raise RuntimeError("Reconciliation waits for the original service stop to settle")
                result = json.loads(self.run([str(self.candidate(op)), "recovery", "reconcile", "--apply"], timeout=180))
                if result.get("kind") != "reconciliation" or not isinstance(result.get("waiting"), list):
                    raise RuntimeError("Reconciliation facts are unreadable; preserve the saved operation")
                if not self.stopped() or self.build(self.binary) != op.source:
                    raise RuntimeError("Proved controller boundary changed during reconciliation")
                # Job-specific waits retain their original WAL/ownership. They
                # are NOT controller writers and cannot require restarting the
                # old code before installing the code that can reconcile them.
                shutil.copy2(self.binary, self.backup)
                with self.backup.open("rb") as stream:
                    os.fsync(stream.fileno())
                self.save(Installing(op, state.candidate_digest, InstallStep.SWAP))
        elif isinstance(state, Installing):
            op = state.operation
            self.own_request(op)
            if state.step is InstallStep.STOP:
                current = self.process()
                if current and current.commit == op.target:
                    self.save(Verifying(op, now))
                elif current:
                    if current.commit == op.source and current != op.controller:
                        self.save(Handoff(replace(op, controller=current), state.candidate_digest))
                        return
                    if current != op.controller or not self.idle(op, current):
                        raise RuntimeError("source identity or acknowledgement changed before install")
                    self.service("stop")
                    self.save(replace(state, step=InstallStep.SWAP))
                else:
                    self.save(replace(state, step=InstallStep.SWAP))
            elif state.step is InstallStep.SWAP:
                if not self.stopped():
                    current=self.process()
                    if current and current.commit==op.source:self.save(Handoff(replace(op,controller=current),state.candidate_digest));return
                    if current and current.commit==op.target:self.save(Verifying(op,now,Verification.ALREADY_RUNNING));return
                    raise RuntimeError("Runner service is still activating at the installation boundary")
                if digest(self.binary) != state.candidate_digest:
                    if self.build(self.binary) != op.source or digest(self.candidate(op)) != state.candidate_digest:
                        raise RuntimeError("installation bytes do not match the saved operation")
                    os.replace(self.candidate(op), self.binary)
                self.save(replace(state, step=InstallStep.START))
            else:
                current = self.process()
                if current and current.commit != op.target:
                    raise RuntimeError("unexpected managed process after installation")
                if current is None:
                    self.service("start")
                self.save(Verifying(op, now))
        elif isinstance(state, Verifying):
            op = state.operation
            self.own_request(op)
            if self.health(op, op.target, state.since):
                self.finish(op, "confirmed", preserve_budget=state.mode is Verification.ALREADY_RUNNING)
            else:
                self.save(Restoring(op, InstallStep.STOP))
        elif isinstance(state, Restoring):
            op = state.operation
            self.own_request(op)
            if not self.backup.exists() or self.build(self.backup) != op.source:
                raise RuntimeError("verified rollback binary missing; preserve admission hold")
            current = self.process()
            if current and current.commit == op.source:
                self.save(VerifyingRestored(op, now))
            elif state.step is InstallStep.STOP:
                if current:
                    if current.commit != op.target or not self.idle(op, current):
                        raise RuntimeError("candidate has not acknowledged its exact rollback hold")
                    self.service("stop")
                self.save(replace(state, step=InstallStep.SWAP))
            elif state.step is InstallStep.SWAP:
                if not self.stopped():
                    if current and current.commit==op.target:self.save(replace(state,step=InstallStep.STOP));return
                    raise RuntimeError("Rollback waits for the original service stop to settle")
                staged = self.binary.with_name(self.binary.name + ".rollback")
                shutil.copy2(self.backup, staged)
                os.replace(staged, self.binary)
                self.save(replace(state, step=InstallStep.START))
            else:
                if not self.pid():
                    self.service("start")
                self.save(VerifyingRestored(op, now))
        elif isinstance(state, VerifyingRestored):
            if self.health(state.operation, state.operation.source, state.since):
                self.finish(state.operation, "rolled_back", state.operation.target)
            else:
                self.wait(Reason.RESTORED_HEALTH, "Restored runner needs verified health; no repeated restart", state, 60)
        elif isinstance(state, Finished):
            self.release_request(state.operation)
            info=self.info(self.binary)
            if info.get("recovery_protocol") == 1 and info.get("coordinator_revision",0)>=COORDINATOR_REVISION:
                source = self.run([str(self.binary), "recovery", "source"]).rstrip().encode() + b"\n"
                compile(source.decode(), "confirmed supervisor", "exec")
                path = self.root / "supervisor.py"
                if not path.exists() or path.read_bytes() != source:
                    staged = path.with_suffix(".new")
                    with staged.open("wb") as stream:
                        os.chmod(staged, 0o600)
                        stream.write(source)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(staged, path)
                    raise SupervisorUpgraded()
            try:
                self.run([str(self.binary), "alarm", "--kind", "ops", state.notification])
            except (OSError, subprocess.SubprocessError):
                return
            self.save(Idle(state.next_attempt_at, state.rejected))

    def reconcile(self):
        # Every entry point executes this same dispatcher. A restart does not
        # call a second recovery/rollback implementation or allocate an episode.
        for _ in range(16):
            before = self.state
            try:
                self.step()
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                state = self.state
                if isinstance(state, Reconciling) and state.step in (ReconcileStep.FREEZE, ReconcileStep.PROVE, ReconcileStep.STOP) and self.process() == state.operation.controller:
                    # A failed observation cannot leave the source controller
                    # frozen. Compensate only our exact still-running boundary.
                    self.service("thaw")
                    self.wait(Reason.PREREQUISITE, str(error), Handoff(state.operation, state.candidate_digest), 30)
                    return
                if isinstance(state, (Preparing, Handoff)):
                    self.wait(Reason.PREREQUISITE, str(error), state, 30)
                elif isinstance(state, (Reconciling, Installing, Verifying, Restoring, VerifyingRestored)):
                    self.wait(Reason.TRANSPORT, str(error), state, 5)
                else:
                    raise
                return
            if before == self.state or isinstance(self.state, (Waiting, Idle)):
                return

    def next_check_delay(self):
        state = self.state
        deadline = state.retry_at if isinstance(state, Waiting) else state.next_attempt_at if isinstance(state, Idle) else 0
        return max(1, min(30 if not isinstance(state, Idle) else 3600, (deadline - time.time() * 1000) / 1000)) if deadline else 2

    def serve(self):
        next_check = 0
        while True:
            try:
                if time.monotonic() >= next_check:
                    self.reconcile()
                    next_check = time.monotonic() + self.next_check_delay()
                config = self.config()
                if not opted_in(config):
                    time.sleep(2 if not isinstance(self.state, Idle) else 30)
                    continue
                with fetch(config["url"].rstrip("/") + "/api/runner-updates/events", 30) as stream:
                    for raw in stream:
                        if raw.startswith(b"data:") or time.monotonic() >= next_check:
                            self.reconcile()
                            next_check = time.monotonic() + self.next_check_delay()
            except Exception as error:
                # Transport retry cannot mutate recovery phase, clear a hold,
                # reject a build or reset a deadline. The journal owns the exit.
                print(f"recovery observation deferred: {error}", flush=True)
                time.sleep(5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", required=True)
    args = parser.parse_args()
    supervisor = Supervisor(args.bin)
    with open(supervisor.root / "lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Reload only after winning the lock; constructing a diagnostic reader
        # never migrates or overwrites another supervisor's current journal.
        supervisor.state = decode(read(supervisor.state_path, {}))
        try:
            supervisor.serve()
        except SupervisorUpgraded:
            pass
    os.execv(sys.executable, [sys.executable, str(supervisor.root / "supervisor.py"), "--bin", str(supervisor.binary)])


if __name__ == "__main__":
    main()
