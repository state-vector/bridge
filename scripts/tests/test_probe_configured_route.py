#!/usr/bin/env python3
"""Tests for scripts/probe-configured-route.py — the bounded configured-route
evidence producer for non-review provider recovery (BR#18700)."""
import importlib.util
import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("probe_configured_route", ROOT / "probe-configured-route.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)

NOW = int(time.time() * 1000)
RATE_LIMIT_OUTCOME = {
    "kind": "failed", "exit_code": 1, "stdout_tail": "",
    "stderr_tail": "Task failed before delivery",
    "cause": {"code": -32000, "error_name": "provider.rate-limit", "class": "rate_limit"},
}


def snapshot(**overrides):
    state = {
        "attempt": {"phase": "quiesced", "generation": 1, "attempt_id": "a1", "host": "ip-10-0-0-1",
                    "executor": {"backend": "opencode", "model": "llmgw/glm-5.3-flash",
                                 "config_revision": "rev-one"}},
        "terminal": {"generation": 1, "attempt_id": "a1", "outcome": RATE_LIMIT_OUTCOME},
        "operations": [], "recovery_permit": None,
    }
    state.update(overrides.pop("state", {}))
    task = overrides.pop("task", {"status": "todo", "owner": ""})
    return {"task": task, "execution_state": state,
            "schedule_status": overrides.pop("schedule_status", None)}


class DiagnosisTests(unittest.TestCase):
    def test_typed_rate_limit_maps_to_route_unavailable(self):
        self.assertEqual(probe.recompute_diagnosis(RATE_LIMIT_OUTCOME), "provider_route_unavailable")

    def test_typed_auth_and_quota_refuse(self):
        for name in ("provider.auth", "provider.quota"):
            outcome = {"kind": "failed", "exit_code": 1, "stdout_tail": "", "stderr_tail": "",
                       "cause": {"code": -32000, "error_name": name, "class": "account_action"}}
            self.assertIsNone(probe.recompute_diagnosis(outcome))

    def test_archived_liteLLM_envelope_maps_to_route_unavailable(self):
        cooldown = "'" + "a" * 64 + "'"
        outcome = {"kind": "failed", "exit_code": 1, "stdout_tail": "", "cause": None,
                   "stderr_tail": "acp session/prompt failed: Internal error: No deployments available "
                                  "for selected model, Try again in 30 seconds. Passed model=llmgw/glm-5.3-flash. "
                                  f"pre-call-checks=False, cooldown_list=[{cooldown}]"}
        self.assertEqual(probe.recompute_diagnosis(outcome), "provider_route_unavailable")

    def test_ambiguous_and_completed_outcomes_refuse(self):
        self.assertIsNone(probe.recompute_diagnosis({"kind": "failed", "stderr_tail": "no route maybe?"}))
        self.assertIsNone(probe.recompute_diagnosis({"kind": "completed", "exit_code": 0, "stdout_tail": "ok", "stderr_tail": ""}))


class EligibilityTests(unittest.TestCase):
    def test_held_snapshot_is_eligible(self):
        self.assertIsNone(probe.eligibility_refusal(snapshot()))

    def test_status_owner_and_lifecycle_refuse(self):
        self.assertEqual(probe.eligibility_refusal(snapshot(task={"status": "in_progress", "owner": ""})), "status-in_progress")
        self.assertEqual(probe.eligibility_refusal(snapshot(task={"status": "todo", "owner": "someone"})), "owner-present")
        self.assertEqual(probe.eligibility_refusal(snapshot(state={"attempt": {"phase": "running"}})), "attempt-running")
        prepared = snapshot(state={"operations": [{"state": "prepared"}]})
        self.assertEqual(probe.eligibility_refusal(prepared), "operation-prepared")
        self.assertEqual(probe.eligibility_refusal(snapshot(state={"recovery_permit": {"phase": "available"}})), "permit-available")

    def test_terminal_mismatch_and_diagnosis_refuse(self):
        self.assertEqual(probe.eligibility_refusal(snapshot(state={"terminal": {"generation": 2, "attempt_id": "a1"}})), "terminal-mismatch")
        self.assertEqual(probe.eligibility_refusal(snapshot(state={"terminal": {"generation": 1, "attempt_id": "a1", "outcome": {"kind": "completed"}}})), "diagnosis-unknown")

    def test_foreign_expectation_refuses(self):
        refusal = probe.eligibility_refusal(snapshot(), expect={"backend": "opencode", "model": "llmgw/glm-4.6", "config_revision": "rev-one"})
        self.assertEqual(refusal, "foreign-expectation:model")


class CapacityTests(unittest.TestCase):
    def test_spare_capacity_passes(self):
        status = {"hosts": [{"host": "ip-10-0-0-1", "live": True, "readiness": {"kind": "ready"},
                             "capacity": 20, "active": 9, "reserved": 0, "eligible": 0}]}
        self.assertIsNone(probe.capacity_refusal({"schedule_status": status}, "ip-10-0-0-1"))

    def test_full_unknown_and_unready_refuse(self):
        status = {"hosts": [{"host": "ip-10-0-0-1", "live": True, "readiness": {"kind": "ready"},
                             "capacity": 2, "active": 2, "reserved": 0, "eligible": 0}]}
        self.assertEqual(probe.capacity_refusal({"schedule_status": status}, "ip-10-0-0-1"), "capacity-full")
        self.assertEqual(probe.capacity_refusal({"schedule_status": {"hosts": []}}, "ip-10-0-0-1"), "host-unknown")
        unready = {"hosts": [{"host": "ip-10-0-0-1", "live": False, "readiness": {"kind": "ready"},
                              "capacity": 2, "active": 0, "reserved": 0, "eligible": 0}]}
        self.assertEqual(probe.capacity_refusal({"schedule_status": unready}, "ip-10-0-0-1"), "host-not-ready")


class ConfigTests(unittest.TestCase):
    def test_configured_model_passes_without_reading_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "opencode.json"
            path.write_text(json.dumps({"provider": {"llmgw": {"models": {"glm-5.3-flash": {}}}}}))
            self.assertIsNone(probe.config_refusal(str(path), "llmgw/glm-5.3-flash"))

    def test_missing_model_and_file_refuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "opencode.json"
            path.write_text(json.dumps({"provider": {"llmgw": {"models": {}}}}))
            self.assertEqual(probe.config_refusal(str(path), "llmgw/glm-5.3-flash"), "config-model-missing:llmgw/glm-5.3-flash")
            self.assertTrue(probe.config_refusal(str(Path(tmp) / "absent.json"), "llmgw/glm-5.3-flash").startswith("config-missing"))


class LedgerTests(unittest.TestCase):
    def test_duplicate_proof_id_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = str(Path(tmp) / "probes.jsonl")
            self.assertIsNone(probe.ledger_refusal(ledger, "p1", "route", 1000, NOW))
            probe.record_ledger(ledger, {"ts": NOW, "proof_id": "p1", "route": "route"})
            self.assertEqual(probe.ledger_refusal(ledger, "p1", "route", 1000, NOW), "duplicate-proof")

    def test_route_cooldown_refuses_until_elapsed(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = str(Path(tmp) / "probes.jsonl")
            probe.record_ledger(ledger, {"ts": NOW, "proof_id": "p1", "route": "route"})
            self.assertEqual(probe.ledger_refusal(ledger, "p2", "route", 60_000, NOW + 1), "route-cooldown")
            self.assertIsNone(probe.ledger_refusal(ledger, "p2", "route", 60_000, NOW + 61_000))
            self.assertIsNone(probe.ledger_refusal(ledger, "p2", "other-route", 60_000, NOW + 1))


def make_transport_db(tmp: str, model: dict, output: int, completed: int, session_id="ses_probe", message_id="msg_probe", name="opencode.db"):
    path = Path(tmp) / name
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE session_v2 (id TEXT, title TEXT, model TEXT, time_created INTEGER)")
    con.execute("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)")
    con.execute("INSERT INTO session_v2 VALUES (?,?,?,?)", (session_id, "probe-title", json.dumps(model), completed - 5000))
    con.execute("INSERT INTO session_message VALUES (?,?,?,?,?)", (message_id, session_id, "assistant", 2, json.dumps({
        "time": {"completed": completed}, "finish": "stop",
        "tokens": {"input": 10, "output": output, "reasoning": 0}})))
    con.commit()
    con.close()
    return str(path)


class CaptureTests(unittest.TestCase):
    def test_happy_capture_reads_the_transport_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = make_transport_db(tmp, {"id": "glm-5.3-flash", "providerID": "llmgw"}, 4, NOW)
            record = probe.capture_record(db, "probe-title", "llmgw/glm-5.3-flash", 64, NOW - 30_000, NOW, 240_000)
            self.assertEqual(record["session_id"], "ses_probe")
            self.assertEqual(record["output_tokens"], 4)
            self.assertEqual(record["completed_ms"], NOW)

    def test_foreign_missing_and_overbound_captures_refuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            foreign = make_transport_db(tmp, {"id": "glm-4.6", "providerID": "llmgw"}, 4, NOW, name="foreign.db")
            with self.assertRaises(probe.Refusal) as caught:
                probe.capture_record(foreign, "probe-title", "llmgw/glm-5.3-flash", 64, NOW - 30_000, NOW, 240_000)
            self.assertIn("capture-foreign", caught.exception.reason)
            overbound = make_transport_db(tmp, {"id": "glm-5.3-flash", "providerID": "llmgw"}, 65, NOW, name="overbound.db")
            with self.assertRaises(probe.Refusal) as caught:
                probe.capture_record(overbound, "probe-title", "llmgw/glm-5.3-flash", 64, NOW - 30_000, NOW, 240_000)
            self.assertIn("capture-overbound", caught.exception.reason)
            with self.assertRaises(probe.Refusal) as caught:
                probe.capture_record(str(Path(tmp) / "none.db"), "probe-title", "llmgw/glm-5.3-flash", 64, NOW - 30_000, NOW, 240_000)
            self.assertIn("capture-missing", caught.exception.reason)

    def test_stale_capture_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = make_transport_db(tmp, {"id": "glm-5.3-flash", "providerID": "llmgw"}, 4, NOW - 400_000)
            with self.assertRaises(probe.Refusal) as caught:
                probe.capture_record(old, "probe-title", "llmgw/glm-5.3-flash", 64, NOW - 500_000, NOW, 240_000)
            self.assertIn("capture-stale", caught.exception.reason)


class ComposeTests(unittest.TestCase):
    def test_proof_binds_witness_to_the_record(self):
        record = {"session_id": "ses_probe", "message_id": "msg_probe", "model_id": "glm-5.3-flash",
                  "provider_id": "llmgw", "output_tokens": 4, "completed_ms": NOW, "finish": "stop"}
        proof = probe.compose_proof("configured-route-probe:ses_probe", "ip-10-0-0-1", "llmgw/glm-5.3-flash",
                                    "rev-one", "opencode:config:/cfg#provider.llmgw.models.glm-5.3-flash", record)
        self.assertEqual(proof["witness"]["configured_model"], proof["model"])
        self.assertIn(proof["actual_model"], proof["witness"]["allowed_actual_models"])
        self.assertEqual(proof["witness"]["observed_max_output_tokens"], proof["request"]["max_output_tokens"])
        self.assertEqual(proof["witness"]["configuration_receipt"], proof["configuration_receipt"])
        self.assertEqual(proof["request"], {"kind": "configured_model_request", "max_output_tokens": 4, "tools": "none"})
        self.assertEqual(proof["result"], {"kind": "succeeded", "response_receipt": "opencode:assistant-message:msg_probe"})
        self.assertEqual(proof["observed_at"], record["completed_ms"])


if __name__ == "__main__":
    unittest.main()
