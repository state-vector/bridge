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
