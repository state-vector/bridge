"""Recovery is tested as a restarted production workflow, not isolated ladders."""
import importlib.util
import io
import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("supervisor", Path(__file__).with_name("supervisor.py"))
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
OLD, NEW, NEXT, NONCE = "a" * 40, "b" * 40, "c" * 40, "d" * 32


class Crash(BaseException):
    pass


def archive(binary):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as tar:
        member = tarfile.TarInfo("bridge")
        member.size = len(binary)
        tar.addfile(member, io.BytesIO(binary))
    return gzip.compress(data.getvalue(),mtime=0)


class Machine:
    def __init__(self, home):
        self.home = home
        self.clock = 10000.0
        self.current = m.Process(123, "boot", "100", OLD)
        self.actions = []
        self.target = NEW
        self.binary = b"new binary"
        self.fetches = []
        self.ack = True
        self.frozen = False
        self.children = False
        self.waiting = False
        self.healthy = {OLD: True, NEW: True, NEXT: True}
        self.crash_state = None
        self.crash_effect = None
        self.did_crash = False
        self.doctor_ok = True
        self.export_source = None

    def fetch(self, url, timeout):
        self.fetches.append(url)
        if url.endswith("tar.gz"):
            return io.BytesIO(archive(self.binary))
        target = "aarch64-unknown-linux-gnu"
        return io.BytesIO(json.dumps({"schema_version": 1, "channel": "main", "commit": self.target,
            "artifacts": {target: {"url": f"https://github.com/state-vector/bridge/releases/download/runner-{self.target}/bridge-{target}.tar.gz",
                                   "sha256": m.hashlib.sha256(archive(self.binary)).hexdigest()}}}).encode())


class Harness(m.Supervisor):
    def __init__(self, machine):
        self.machine = machine
        super().__init__(machine.home / "bridge", machine.home)

    def process(self):
        return self.machine.current

    def pid(self):
        return self.machine.current.pid if self.machine.current else 0

    def info(self, binary):
        data = Path(binary).read_bytes()
        return {"commit": self.machine.target if data == self.machine.binary else OLD,
                "update_protocol": 1, "worker_protocol": 1,
                "recovery_protocol": 1 if self.machine.export_source or not self.machine.ack else 0}

    def idle(self, op, process):
        if self.machine.ack and process:
            m.atomic(self.root / "idle.json", {"nonce": op.nonce, "pid": process.pid, "phase": "controller_ready" if op.worker_protocol==1 else "idle", "worker_protocol": op.worker_protocol})
        return super().idle(op, process)

    def health(self, op, commit, since):
        self.assert_hold(op)
        return self.machine.current is not None and self.machine.current.commit == commit and self.idle(op, self.machine.current) and self.machine.healthy[commit]

    def assert_hold(self, op):
        if m.read(self.request, {}).get("nonce") != op.nonce:
            raise AssertionError("service/health action without the exact admission hold")

    def save(self, state):
        super().save(state)
        key = type(state).__name__ + ":" + str(getattr(state, "step", ""))
        if self.machine.crash_state == key and not self.machine.did_crash:
            self.machine.did_crash = True
            raise Crash()

    def service(self, action):
        op = self.state.operation
        self.assert_hold(op)
        self.machine.actions.append(action)
        if action == "stop":
            self.machine.current = None
        elif action == "start":
            self.machine.current = m.Process(124 + len(self.machine.actions), "boot", str(200 + len(self.machine.actions)), self.build(self.binary))
        elif action == "freeze":
            self.machine.frozen = True
        elif action == "thaw":
            self.machine.frozen = False
        if self.machine.crash_effect == action and not self.machine.did_crash:
            self.machine.did_crash = True
            raise Crash()

    def run(self, args, timeout=60):
        if args[1] == "doctor":
            if not self.machine.doctor_ok:
                raise subprocess.CalledProcessError(1, "doctor")
        elif args[1:3] == ["recovery", "boundary"]:
            return json.dumps({"kind": "controller_only" if self.machine.frozen and not self.machine.children else "busy"})
        elif args[1] == "recovery" and args[2] in ("inspect", "reconcile"):
            if args[2] == "reconcile":
                self.machine.actions.append("reconcile")
                if not self.machine.waiting:
                    self.machine.ack = True
            return json.dumps({"waiting": ["protected original record"] if self.machine.waiting else []})
        elif args[1:3] == ["recovery", "source"]:
            return self.machine.export_source
        elif args[1] == "alarm":
            self.machine.actions.append("notify")
        else:
            raise AssertionError(args)
        return ""


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / "bridge").write_bytes(b"old binary")
        self.machine = Machine(self.home)
        self.u = Harness(self.machine)
        m.atomic(self.home / ".bridge/config.json", {"url": "https://hub.example", "auto_update": {"enabled": True, "channel": "main"}})
        self.clock = patch.object(m.time, "time", side_effect=lambda: self.machine.clock)
        self.clock.start();self.addCleanup(self.clock.stop)
        self.network = patch.object(m, "fetch", side_effect=self.machine.fetch)
        self.network.start();self.addCleanup(self.network.stop)
        self.uname = patch.object(m.os, "uname", return_value=type("Uname", (), {"machine":"aarch64", "nodename":"test-host"})())
        self.uname.start();self.addCleanup(self.uname.stop)
        self.quiet = patch("builtins.print")
        self.quiet.start();self.addCleanup(self.quiet.stop)

    def drive(self, limit=100):
        for _ in range(limit):
            try:
                self.u.reconcile()
            except Crash:
                self.u = Harness(self.machine)
            if isinstance(self.u.state, m.Idle) and self.u.binary.read_bytes() == self.machine.binary:
                return
            self.machine.clock += 31
        self.fail(f"workflow did not settle: {self.u.state}")

    def test_closed_opt_in_digest_origin_and_archive(self):
        for value in ({}, {"auto_update":None}, {"auto_update":{"enabled":"true","channel":"main"}}, {"auto_update":{"enabled":True,"channel":"pinned"}}):
            self.assertFalse(m.opted_in(value))
        for name, kind in (("../bridge",tarfile.REGTYPE),("bridge",tarfile.SYMTYPE)):
            path = self.home / "bad.tar.gz"
            with tarfile.open(path,"w:gz") as tar:
                item=tarfile.TarInfo(name);item.type=kind;tar.addfile(item)
            with self.assertRaises(ValueError):m.extract_candidate(path,self.home/"extracted")
        manifest=json.load(self.machine.fetch("manifest",30))
        with self.assertRaises(ValueError):m.validate_manifest(manifest,"stable","aarch64-unknown-linux-gnu")
        manifest["artifacts"]["aarch64-unknown-linux-gnu"]["url"]="https://evil.invalid/bridge"
        with self.assertRaises(ValueError):m.validate_manifest(manifest,"main","aarch64-unknown-linux-gnu")
        m.atomic(self.home/".bridge/config.json",{})
        self.u.reconcile();self.assertEqual(self.machine.fetches,["manifest"])

    def test_every_saved_phase_resumes_one_operation_without_duplicate_install(self):
        keys=["Preparing:","Handoff:","Installing:InstallStep.STOP","Installing:InstallStep.SWAP","Installing:InstallStep.START","Verifying:","Finished:"]
        for key in keys:
            with self.subTest(key=key):
                self.setUp()
                self.machine.crash_state=key
                self.drive()
                self.assertTrue(self.machine.did_crash)
                self.assertEqual(self.machine.actions,["stop","start","notify"])
                self.assertFalse(self.u.request.exists())
                self.assertGreaterEqual(self.u.state.next_attempt_at,13600000)
                self.assertLessEqual(self.u.state.next_attempt_at,13631000)

    def test_stop_and_start_effect_with_lost_response_are_observed_not_repeated(self):
        for effect in ("stop","start"):
            with self.subTest(effect=effect):
                self.setUp();self.machine.crash_effect=effect;self.drive()
                self.assertEqual(self.machine.actions,["stop","start","notify"])

    def test_swap_crash_replays_saved_digest_without_needing_moved_staging_file(self):
        replace=os.replace
        def after_swap(source,target):
            replace(source,target)
            if Path(target)==self.u.binary and not self.machine.did_crash:
                self.machine.did_crash=True;raise Crash()
        with patch.object(m.os,"replace",side_effect=after_swap):self.drive()
        self.assertEqual(self.machine.actions,["stop","start","notify"])

    def test_expected_controller_restart_uses_fresh_ack_without_resetting_deadline(self):
        self.machine.crash_state="Handoff:"
        with self.assertRaises(Crash):self.u.reconcile()
        saved=self.u.state.operation
        self.machine.current=m.Process(900,"boot","new-start",OLD)
        self.machine.crash_state=None
        self.u=Harness(self.machine)
        self.u.step()
        self.assertIsInstance(self.u.state,m.Installing)
        self.assertEqual(self.u.state.operation.nonce,saved.nonce)
        self.assertEqual(self.u.state.operation.deadline,saved.deadline)
        self.assertEqual(self.u.state.operation.next_attempt_at,saved.next_attempt_at)
        self.drive()

    def test_all_reconciliation_phases_restart_and_keep_independent_work(self):
        for step in m.ReconcileStep:
            with self.subTest(step=step):
                self.setUp();self.machine.ack=False
                self.machine.crash_state="Reconciling:"+str(step)
                protected=self.home/"unrelated-work";protected.write_bytes(b"unpublished work and output")
                self.drive()
                self.assertEqual(protected.read_bytes(),b"unpublished work and output")
                self.assertEqual(self.machine.actions.count("reconcile"),1)
                self.assertEqual(self.machine.actions.count("stop"),2)
                self.assertEqual(self.machine.actions.count("start"),2)

    def test_unproved_records_wait_without_restarting_every_retry(self):
        self.machine.ack=False;self.machine.waiting=True
        self.u.reconcile()
        self.assertIsInstance(self.u.state,m.Waiting)
        self.assertEqual(self.u.state.reason,m.Reason.RECONCILIATION)
        actions=list(self.machine.actions)
        for _ in range(10):
            self.machine.clock+=31;self.u=Harness(self.machine);self.u.reconcile()
        self.assertEqual(self.machine.actions,actions)
        self.assertTrue(self.u.request.exists())
        self.machine.waiting=False
        self.drive()

    def test_busy_frozen_boundary_is_thawed_without_stopping_writers(self):
        self.machine.ack=False;self.machine.children=True
        self.u.reconcile()
        self.assertEqual(self.machine.actions,["freeze","thaw"])
        self.assertTrue(self.u.request.exists())
        self.assertNotIn("stop",self.machine.actions)

    def test_failed_candidate_restores_once_and_never_retries_that_candidate(self):
        self.machine.healthy[NEW]=False
        self.u.reconcile()
        self.assertIsInstance(self.u.state,m.Idle)
        self.assertEqual(self.u.binary.read_bytes(),b"old binary")
        self.assertEqual(self.u.state.rejected,NEW)
        self.assertEqual(self.machine.actions,["stop","start","stop","start","notify"])
        self.machine.clock+=7200;self.u.reconcile()
        self.assertEqual(self.machine.actions,["stop","start","stop","start","notify"])

    def test_failed_restored_health_never_restarts_it_again(self):
        self.machine.healthy[NEW]=False;self.machine.healthy[OLD]=False
        self.u.reconcile()
        actions=list(self.machine.actions)
        for _ in range(10):
            self.machine.clock+=61;self.u=Harness(self.machine);self.u.reconcile()
        self.assertEqual(actions,["stop","start","stop","start"])
        self.assertEqual(self.machine.actions,actions)
        self.assertTrue(self.u.request.exists())

    def test_new_verified_candidate_recovers_failed_rollback_after_original_budget(self):
        self.machine.healthy[NEW]=False;self.machine.healthy[OLD]=False
        self.u.reconcile();nonce=m.read(self.u.request)["nonce"]
        self.machine.target=NEXT;self.machine.binary=b"newer binary";self.machine.clock+=3601
        self.drive()
        self.assertEqual(self.machine.current.commit,NEXT)
        self.assertEqual(self.machine.actions.count("stop"),3)
        self.assertEqual(self.machine.actions.count("start"),3)
        self.assertFalse(self.u.request.exists())
        self.assertTrue(nonce)

    def test_prerequisite_failure_waits_before_any_hold_or_service_change(self):
        self.machine.doctor_ok=False
        self.u.reconcile()
        self.assertIsInstance(self.u.state,m.Waiting)
        self.assertEqual(self.u.state.reason,m.Reason.PREREQUISITE)
        self.assertFalse(self.u.request.exists())
        self.assertEqual(self.machine.actions,[])
        self.machine.doctor_ok=True;self.drive()

    def test_changed_nonce_is_never_released_or_used_as_authority(self):
        self.machine.crash_state="Installing:InstallStep.STOP"
        with self.assertRaises(Crash):self.u.reconcile()
        m.atomic(self.u.request,{"nonce":"someone-else"})
        self.machine.crash_state=None;self.u=Harness(self.machine);self.u.reconcile()
        self.assertEqual(m.read(self.u.request),{"nonce":"someone-else"})
        self.assertEqual(self.machine.actions,[])

    def test_old_pid_start_and_boot_identity_do_not_cover_another_process(self):
        op=m.Operation(NONCE,OLD,NEW,"main",self.machine.current,1,100,0,1)
        m.atomic(self.u.root/"idle.json",{"nonce":NONCE,"pid":122,"phase":"controller_ready","worker_protocol":1})
        self.machine.ack=False
        self.assertFalse(self.u.idle(op,self.machine.current))
        for identity in (m.Process(123,"other-boot","100",OLD),m.Process(123,"boot","200",OLD)):
            self.assertNotEqual(identity,op.controller)
        self.u.save(m.Installing(op,"invalid",m.InstallStep.STOP));self.machine.current=None
        self.u.step();self.assertEqual(self.u.state.step,m.InstallStep.SWAP)

    def test_cooldown_coalesces_publications_and_survives_restart(self):
        self.u.save(m.Idle(13600000))
        for seconds in (1,8,3599):
            self.machine.clock=10000+seconds;self.u=Harness(self.machine);self.u.reconcile()
        self.assertEqual(self.machine.fetches,[])
        self.machine.clock=13600;self.machine.target=NEXT;self.machine.binary=b"newest";self.drive()
        self.assertEqual(self.machine.current.commit,NEXT)

    def test_legacy_known_running_candidate_requires_health_and_preserves_budget(self):
        self.u.binary.write_bytes(self.machine.binary);self.machine.current=m.Process(123,"boot","100",NEW)
        m.atomic(self.u.state_path,{"phase":"recovery_required","from_commit":OLD,"to_commit":NEW,"nonce":NONCE,"next_attempt_at":20000000})
        m.atomic(self.u.request,{"nonce":NONCE})
        self.u=Harness(self.machine);self.u.reconcile()
        self.assertEqual(self.machine.actions,["notify"])
        self.assertEqual(self.u.state.next_attempt_at,20000000)

    def test_legacy_install_with_stopped_controller_restores_without_inventing_pid(self):
        self.u.backup.write_bytes(b"old binary");self.u.binary.write_bytes(self.machine.binary);self.machine.current=None
        m.atomic(self.u.state_path,{"phase":"installing","from_commit":OLD,"to_commit":NEW,"nonce":NONCE,"next_attempt_at":0})
        m.atomic(self.u.request,{"nonce":NONCE})
        self.u=Harness(self.machine);self.u.reconcile()
        self.assertEqual(self.u.binary.read_bytes(),b"old binary")
        self.assertEqual(self.machine.actions,["start","notify"])

    def test_closed_state_rejects_unknown_continuations_and_missing_data(self):
        for data in ({"schema_version":3,"phase":"idle"},{"schema_version":2,"phase":"invented"},
                     {"schema_version":2,"phase":"installing"},
                     {"schema_version":2,"phase":"waiting","reason":"transport","detail":"x","retry_at":1,"resume":m.encode(m.Idle())}):
            with self.assertRaises((ValueError,TypeError,KeyError)):m.decode(data)

    def test_legacy_migration_cannot_borrow_another_operations_hold(self):
        m.atomic(self.u.state_path,{"phase":"recovery_required","from_commit":OLD,"to_commit":NEW,"nonce":NONCE})
        m.atomic(self.u.request,{"nonce":"other"})
        self.u=Harness(self.machine)
        with self.assertRaisesRegex(RuntimeError,"identity is unproved"):self.u.reconcile()
        self.assertEqual(m.read(self.u.request),{"nonce":"other"});self.assertEqual(self.machine.actions,[])

    def test_confirmed_native_updates_the_only_supervisor_and_reexecs_from_saved_finish(self):
        self.machine.export_source="# upgraded single supervisor\n"
        with self.assertRaises(m.SupervisorUpgraded):self.u.reconcile()
        self.assertIsInstance(self.u.state,m.Finished)
        self.assertEqual((self.u.root/"supervisor.py").read_text(),self.machine.export_source)
        self.assertFalse(self.u.request.exists())
        self.u=Harness(self.machine);self.u.reconcile()
        self.assertEqual(self.machine.actions,["stop","start","notify"])

    def test_old_recovery_ladders_and_separate_native_cleanup_commands_are_removed(self):
        source=Path(m.__file__).read_text()
        for symbol in ("def rollback(","def recover(","def accept_running_candidate("):
            self.assertNotIn(symbol,source)
        cli=Path(__file__).parents[1]/"src/main.rs"
        for command in ("reconcile-stopped","reconcile-reservations"):
            self.assertNotIn(command,cli.read_text())


class RealProcessRecoveryTests(unittest.TestCase):
    def test_real_archive_install_survives_coordinator_crash_and_preserves_live_worker_output(self):
        # Only the OS service adapter is substituted. The production journal,
        # archive validation, installation, native subprocess doctor, hold and
        # health protocol all execute against real files and live processes.
        program = '''#!/usr/bin/env python3
import json,os,sys,time
from pathlib import Path
COMMIT = "COMMIT_VALUE"
if sys.argv[1] == "build-info":
 print(json.dumps({"commit":COMMIT,"update_protocol":1,"worker_protocol":1,"recovery_protocol":0}))
elif sys.argv[1] == "doctor":
 sys.exit(0)
elif sys.argv[1] == "alarm":
 sys.exit(0)
else:
 root=Path(sys.argv[2])/".bridge/update"
 while True:
  request=root/"request.json"
  if request.exists():
   value=json.loads(request.read_text())
   for name,data in [("idle.json",{"nonce":value["nonce"],"pid":os.getpid(),"phase":"controller_ready","worker_protocol":1}),("health.json",{"pid":os.getpid(),"commit":COMMIT,"observed_at":int(time.time()*1000)})]:
    tmp=root/(name+".child");tmp.write_text(json.dumps(data));os.replace(tmp,root/name)
  time.sleep(.005)
'''
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory);binary=home/"bridge"
            binary.write_text(program.replace("COMMIT_VALUE",OLD));binary.chmod(0o755)
            candidate=program.replace("COMMIT_VALUE",NEW).encode();data=archive(candidate)
            m.atomic(home/".bridge/config.json",{"url":"https://fixture","auto_update":{"enabled":True,"channel":"main"}})
            hardware={"process":None,"commit":OLD,"actions":[],"crashed":False}
            output=home/"independent-output"
            worker=subprocess.Popen([sys.executable,"-c","import pathlib,time,sys,os\np=pathlib.Path(sys.argv[1]);tmp=p.with_suffix('.next')\ni=0\nwhile True:\n i+=1;tmp.write_text(str(i));os.replace(tmp,p);time.sleep(.005)",str(output)])
            class Actual(m.Supervisor):
                def process(self):
                    p=hardware["process"]
                    return m.Process(p.pid,"fixture-boot",str(p.pid),hardware["commit"]) if p and p.poll() is None else None
                def pid(self):
                    current=self.process();return current.pid if current else 0
                def service(self,action):
                    if action=="stop":
                        hardware["process"].terminate();hardware["process"].wait(timeout=2)
                    elif action=="start":
                        hardware["commit"]=self.build(self.binary)
                        hardware["process"]=subprocess.Popen([str(self.binary),"fixture-run",str(home)])
                    else:raise AssertionError(action)
                    hardware["actions"].append(action)
                def idle(self,op,process):
                    deadline=time.monotonic()+.2
                    while not super().idle(op,process) and time.monotonic()<deadline:time.sleep(.001)
                    return super().idle(op,process)
                def save(self,state):
                    super().save(state)
                    if isinstance(state,m.Installing) and state.step is m.InstallStep.SWAP and not hardware["crashed"]:
                        hardware["crashed"]=True;raise Crash()
            hardware["process"]=subprocess.Popen([str(binary),"fixture-run",str(home)])
            original_pid=hardware["process"].pid
            def fetch(url,timeout):
                manifest={"schema_version":1,"channel":"main","commit":NEW,"artifacts":{"aarch64-unknown-linux-gnu":{
                    "url":f"https://github.com/state-vector/bridge/releases/download/runner-{NEW}/bridge-aarch64-unknown-linux-gnu.tar.gz",
                    "sha256":m.hashlib.sha256(data).hexdigest()}}}
                return io.BytesIO(data if url.endswith("tar.gz") else json.dumps(manifest).encode())
            try:
                with patch.object(m,"fetch",side_effect=fetch),patch.object(m,"STABLE_SECONDS",.025),patch.object(m,"OBSERVE_SECONDS",.005),patch.object(m,"HEALTH_SECONDS",3),\
                     patch.object(m.os,"uname",return_value=type("Uname",(),{"machine":"aarch64","nodename":"real-process-test"})()),patch("builtins.print"):
                    u=Actual(binary,home);deadline=time.monotonic()+10
                    while True:
                        try:u.reconcile()
                        except Crash:u=Actual(binary,home)
                        if isinstance(u.state,m.Idle) and hardware["commit"]==NEW:break
                        self.assertLess(time.monotonic(),deadline);time.sleep(.01)
                    self.assertEqual(hardware["actions"],["stop","start"])
                    self.assertTrue(hardware["crashed"])
                    self.assertNotEqual(hardware["process"].pid,original_pid)
                    before=int(output.read_text());time.sleep(.03)
                    self.assertIsNone(worker.poll());self.assertGreater(int(output.read_text()),before)
                    self.assertFalse(u.request.exists());self.assertEqual(u.build(binary),NEW)
            finally:
                for p in [hardware["process"],worker]:
                    if p and p.poll() is None:p.terminate();p.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
