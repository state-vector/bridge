import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("supervisor", Path(__file__).with_name("supervisor.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.bin = self.home / "bridge"
        self.bin.write_text("old binary")
        self.u = m.Supervisor(self.bin, self.home)
        self.bin = self.u.binary

    def test_opt_in_is_strict_and_pinned_never_updates(self):
        for value in ({}, {"auto_update": None}, {"auto_update": {"enabled": False, "channel": "main"}},
                      {"auto_update": {"enabled": "true", "channel": "main"}}, {"auto_update": {"enabled": True, "channel": "pinned"}}):
            self.assertFalse(m.opted_in(value))
        self.assertTrue(m.opted_in({"auto_update": {"enabled": True, "channel": "main"}}))
        with patch.object(m.urllib.request, "urlopen", side_effect=AssertionError("disabled updater contacted network")):
            self.u.reconcile()

    def test_http_requests_use_the_application_user_agent(self):
        with patch.object(m.urllib.request, "urlopen") as open_url:
            m.fetch("https://hub.example/api/runner-updates/events", 90)
            request = open_url.call_args.args[0]
            self.assertEqual(request.get_header("User-agent"), "bridge-runner-updater/1")

    def test_digest_origin_channel_and_commit_are_closed(self):
        sha = "a" * 40
        manifest = {"schema_version": 1, "channel": "main", "commit": sha, "artifacts": {"aarch64-unknown-linux-gnu": {
            "url": f"https://github.com/state-vector/bridge/releases/download/runner-{sha}/bridge-aarch64-unknown-linux-gnu.tar.gz", "sha256": "b" * 64}}}
        m.validate_manifest(manifest, "main", "aarch64-unknown-linux-gnu")
        with self.assertRaises(ValueError):
            m.validate_manifest(manifest, "stable", "aarch64-unknown-linux-gnu")
        manifest["artifacts"]["aarch64-unknown-linux-gnu"]["url"] = "https://evil.invalid/bridge"
        with self.assertRaises(ValueError):
            m.validate_manifest(manifest, "main", "aarch64-unknown-linux-gnu")

    def test_archive_does_not_extract_traversal_or_links(self):
        for name, kind in [("../bridge", tarfile.REGTYPE), ("bridge", tarfile.SYMTYPE)]:
            archive = self.home / "test.tgz"
            with tarfile.open(archive, "w:gz") as tar:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.size = 1 if kind == tarfile.REGTYPE else 0
                tar.addfile(member, io.BytesIO(b"x") if member.size else None)
            with self.assertRaises(ValueError):
                m.extract_candidate(archive, self.home / "extracted")

    def test_stale_pid_nonce_and_lease_are_not_quiescence(self):
        m.atomic(self.u.root / "idle.json", {"nonce": "old", "pid": 11, "phase": "idle"})
        self.assertFalse(self.u.idle("new", 11))
        self.assertFalse(self.u.idle("old", 12))
        self.assertFalse(self.u.idle("old", 0))
        self.assertTrue(self.u.idle("old", 11))

    def test_unacknowledged_candidate_is_never_killed_for_rollback(self):
        self.u.backup.write_text("old")
        self.u.state = {"from_commit": "a", "to_commit": "b"}
        m.atomic(self.u.request, {"nonce": "n"})
        with patch.object(self.u, "pid", return_value=12), patch.object(self.u, "service") as service:
            with self.assertRaisesRegex(RuntimeError, "not acknowledged idle"):
                self.u.rollback()
            service.assert_not_called()
        self.assertTrue(self.u.request.exists())

    def test_interrupted_install_rolls_back_under_hold_then_resumes_after_health(self):
        self.bin.write_text("candidate")
        self.u.backup.write_text("previous")
        self.u.record(m.Phase.INSTALLING, from_commit="old", to_commit="new")
        m.atomic(self.u.request, {"nonce": "n"})
        m.atomic(self.u.root / "idle.json", {"nonce": "n", "pid": 12, "phase": "idle"})
        actions = []
        def health(commit):
            self.assertTrue(self.u.request.exists())
            self.assertEqual(self.bin.read_text(), "previous")
            return commit == "old"
        with patch.object(self.u, "pid", return_value=12), patch.object(self.u, "service", side_effect=actions.append), patch.object(self.u, "health", side_effect=health), patch.object(self.u, "notify") as notify:
            self.u.recover()
            self.assertEqual(actions, ["stop", "start"])
            self.assertEqual(self.u.state["phase"], "rolled_back")
            self.assertEqual(self.u.state["rejected_commit"], "new")
            self.assertFalse(self.u.request.exists())
            notify.assert_called_once()

    def test_confirmed_crash_releases_hold_without_rollback(self):
        self.u.record(m.Phase.CONFIRMED)
        m.atomic(self.u.request, {"nonce": "n"})
        with patch.object(self.u, "rollback", side_effect=AssertionError("rolled back a confirmed writer")):
            self.u.recover()
        self.assertFalse(self.u.request.exists())

    def test_every_drain_outcome_preserves_work_window_across_restart(self):
        config = {"auto_update": {"enabled": True, "channel": "main"}}
        for phase in (m.Phase.CONFIRMED, m.Phase.DEFERRED, m.Phase.ROLLED_BACK):
            with self.subTest(phase=phase), patch.object(m.time, "time", return_value=10000):
                self.u.record(phase)
                restarted = m.Supervisor(self.bin, self.home)
                restarted.recover()
                self.assertEqual(restarted.state["next_attempt_at"], 13600000)
                with patch.object(restarted, "config", return_value=config), \
                     patch.object(m, "fetch", side_effect=AssertionError("publication bypassed work window")), \
                     patch.object(restarted, "service") as service:
                    for _ in range(20):
                        restarted.reconcile()
                    service.assert_not_called()
                self.assertFalse(restarted.request.exists())
                self.assertEqual(restarted.next_check_delay(), 3600)

    def test_legacy_receipt_and_interrupted_drain_do_not_bypass_cooldown(self):
        m.atomic(self.u.state_path, {"phase": "confirmed", "at": 10000000})
        with patch.object(m.time, "time", return_value=10030):
            restarted = m.Supervisor(self.bin, self.home)
            # Construction alone must never mutate state outside the lock.
            self.assertNotIn("next_attempt_at", m.read(restarted.state_path))
            restarted.recover()
            self.assertEqual(restarted.next_check_delay(), 3570)
            self.assertEqual(m.read(restarted.state_path)["next_attempt_at"], 13600000)
            restarted.record(m.Phase.DRAINING)
            m.atomic(restarted.request, {"nonce": "old"})
            restarted.recover()
            self.assertFalse(restarted.request.exists())
            self.assertEqual(restarted.state["phase"], "deferred")
            self.assertEqual(restarted.state["next_attempt_at"], 13630000)

    def test_cooldown_coalesces_publications_and_installs_latest_at_deadline(self):
        # Real archive/digest/install path: a deferred drain must not immediately
        # re-drain for a new SHA, but the latest manifest must install when due.
        machine = type("Uname", (), {"machine": "aarch64", "nodename": "test-host"})()
        target = "aarch64-unknown-linux-gnu"
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as tar:
            member = tarfile.TarInfo("bridge")
            member.size = 3
            tar.addfile(member, io.BytesIO(b"new"))
        data = archive.getvalue()
        latest = ["a" * 40]
        fetched = []
        def fetch(url, timeout):
            fetched.append(url)
            sha = latest[0]
            manifest = {"schema_version": 1, "commit": sha, "channel": "main", "artifacts": {target: {
                "url": f"https://github.com/state-vector/bridge/releases/download/runner-{sha}/bridge-{target}.tar.gz",
                "sha256": m.hashlib.sha256(data).hexdigest()}}}
            return io.BytesIO(data if url.endswith("tar.gz") else json.dumps(manifest).encode())
        config = {"url": "https://hub.example", "auto_update": {"enabled": True, "channel": "main"}}
        with patch.object(m.time, "time", return_value=10000) as clock, \
             patch.object(m.os, "uname", return_value=machine), \
             patch.object(self.u, "config", return_value=config), patch.object(m, "fetch", side_effect=fetch), \
             patch.object(self.u, "pid", return_value=123), patch.object(m.Path, "resolve", return_value=self.bin), \
             patch.object(self.u, "build", side_effect=lambda p: "old" if p == self.bin else latest[0]), \
             patch.object(self.u, "idle", return_value=True), patch.object(self.u, "run", return_value=""), \
             patch.object(self.u, "health", return_value=True), patch.object(self.u, "notify"), \
             patch.object(self.u, "service") as service:
            self.u.record(m.Phase.DEFERRED)
            for seconds, sha in ((1, "a"), (8, "b"), (3599, "c")):
                clock.return_value = 10000 + seconds
                latest[0] = sha * 40
                self.u.reconcile()
                self.assertFalse(self.u.request.exists())
            self.assertEqual(fetched, [])
            service.assert_not_called()
            self.assertEqual(self.u.next_check_delay(), 1)
            clock.return_value = 13600
            self.u.reconcile()
            self.assertEqual(self.u.state["to_commit"], "c" * 40)
            self.assertEqual(self.u.state["phase"], "confirmed")
            self.assertEqual(self.u.state["next_attempt_at"], 17200000)
            self.assertEqual([c.args[0] for c in service.call_args_list], ["stop", "start"])
            self.assertFalse(self.u.request.exists())

    def test_pending_candidate_reconciles_at_cooldown_expiry_without_new_event(self):
        # Exercise serve's timer with only stream heartbeats, no publication.
        config = {"url": "https://hub.example", "auto_update": {"enabled": True, "channel": "main"}}
        class Stream:
            def __enter__(stream):
                return stream
            def __exit__(stream, *args):
                pass
            def __iter__(stream):
                clock.return_value = 13599
                mono.return_value = 3599
                yield b": heartbeat\n"
                clock.return_value = 13600
                mono.return_value = 3600
                yield b": heartbeat\n"
                raise KeyboardInterrupt()
        with patch.object(m.time, "time", return_value=10000) as clock, \
             patch.object(m.time, "monotonic", return_value=0) as mono, \
             patch.object(m.time, "sleep"), patch.object(self.u, "config", return_value=config), \
             patch.object(m, "fetch", return_value=Stream()), patch.object(self.u, "notify"):
            self.u.record(m.Phase.DEFERRED)
            checked = []
            def reconcile():
                checked.append(clock.return_value)
            with patch.object(self.u, "reconcile", side_effect=reconcile):
                with self.assertRaises(KeyboardInterrupt):
                    self.u.serve()
            self.assertEqual(checked, [10000, 13600])

    def test_full_install_and_failed_candidate_rollback_keep_writers_held(self):
        for fail_health in (False, True):
            with self.subTest(fail_health=fail_health):
                self.bin.write_bytes(b"old binary")
                self.u.state = {}
                sha = "c" * 40
                target = {"x86_64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}[m.os.uname().machine] + "-unknown-linux-gnu"
                archive = io.BytesIO()
                with tarfile.open(fileobj=archive, mode="w:gz") as tar:
                    member = tarfile.TarInfo("bridge")
                    member.size = len(b"new binary")
                    tar.addfile(member, io.BytesIO(b"new binary"))
                data = archive.getvalue()
                manifest = {"schema_version": 1, "commit": sha, "channel": "main", "artifacts": {target: {
                    "url": f"https://github.com/state-vector/bridge/releases/download/runner-{sha}/bridge-{target}.tar.gz",
                    "sha256": m.hashlib.sha256(data).hexdigest()}}}
                config = {"url": "https://hub.example", "auto_update": {"enabled": True, "channel": "main"}}
                actions = []
                def idle(nonce, pid):
                    return True
                def service(action):
                    self.assertTrue(self.u.request.exists(), "service mutation outside update hold")
                    actions.append(action)
                def health(commit):
                    self.assertTrue(self.u.request.exists(), "writer hold lifted before health")
                    if commit == sha:
                        self.assertEqual(self.bin.read_bytes(), b"new binary")
                        return not fail_health
                    self.assertEqual(self.bin.read_bytes(), b"old binary")
                    return True
                def fetch(url, timeout):
                    return io.BytesIO(data if url.full_url.endswith("tar.gz") else json.dumps(manifest).encode())
                machine = type("Uname", (), {"machine": target.split("-unknown")[0], "nodename": "test-host"})()
                with patch.object(self.u, "config", return_value=config), patch.object(self.u, "pid", return_value=123), \
                     patch.object(self.u, "build", side_effect=lambda p: sha if Path(p).read_bytes() == b"new binary" else "old"), \
                     patch.object(self.u, "idle", side_effect=idle), patch.object(self.u, "service", side_effect=service), \
                     patch.object(self.u, "health", side_effect=health), patch.object(self.u, "run", return_value=""), \
                     patch.object(self.u, "notify") as notify, patch.object(m.Path, "resolve", return_value=self.bin), \
                     patch.object(m.urllib.request, "urlopen", side_effect=fetch), patch.object(m.os, "uname", return_value=machine):
                    if fail_health:
                        with self.assertRaisesRegex(RuntimeError, "candidate did not pass"):
                            self.u.reconcile()
                    else:
                        self.u.reconcile()
                    self.assertEqual(actions, ["stop", "start"] * (2 if fail_health else 1))
                    self.assertEqual(self.u.state["phase"], "rolled_back" if fail_health else "confirmed")
                    self.assertFalse(self.u.request.exists())
                    notify.assert_called_once()


if __name__ == "__main__":
    unittest.main()
