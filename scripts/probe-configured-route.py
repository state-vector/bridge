#!/usr/bin/env python3
"""Bounded configured-route evidence producer for non-review provider recovery.

The hub's direct recovery command (`recover_provider_failure`) only grants one
permit when a fresh, witnessed request on the exact configured route postdates
the failed attempt. Until now only managed reviews produced such witnesses
hub-side, so non-review tasks held on `provider_route` (for example a
rate-limited dev-runtime readback) had no producer. This script is that
producer:

1. It validates the target's execution snapshot against the same gates the hub
   enforces: todo and unowned, quiesced attempt with a matching terminal, no
   unresolved operations, no permit yet, a recomputed
   `provider_route_unavailable` diagnosis, byte-matching executor capability
   and, when a schedule snapshot is supplied, current spare capacity.
2. It runs exactly ONE bounded, neutral, tools-free configured-model request
   through the actual configured route via the local opencode transport.
3. It reads the transport's own durable records (its SQLite store) — never log
   inference — to capture model identity, output tokens and completion time.
4. It composes the `ProviderRequestProofSchema` proof from those receipts and,
   with `--submit` and the caller's existing BRIDGE_MCP_URL/BRIDGE_TOKEN
   environment (the same contract as scripts/recover-provider-batch.py),
   submits `recover_provider_failure` for the single target task.

It never reads, copies or transmits credentials: opencode holds its own auth,
the proof contains only receipts, and without `--submit` the script stays
capture-only. Per-route cooldown and per-proof dedupe live in a local ledger
(~/.bridge/configured-route-probes.jsonl) so a still-degraded route is never
hammered and one probe cannot be replayed as several proofs.

Exit codes: 0 ok, 2 eligibility refusal, 3 probe/capture/submit refusal,
4 duplicate/cooldown refusal, 5 capacity refusal, 6 configuration refusal,
7 submission rejected.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse


ARCHIVED_ROUTE_FAILURE = re.compile(
    r"^acp session/prompt failed: Internal error: No deployments available for selected model, "
    r"Try again in \d+ seconds\. Passed model=[\w./:-]+\. pre-call-checks=(?:True|False), "
    r"cooldown_list=\[(?:'[a-f0-9]{64}'(?:, '[a-f0-9]{64}')*)?\]$"
)
PROBE_PROMPT = (
    "Diagnostic route probe for provider recovery evidence. Do not use any "
    "tools. Reply with exactly: OK"
)


class Refusal(Exception):
    """A typed refusal with a process exit code; refusal is the safe outcome."""

    def __init__(self, exit_code: int, reason: str):
        super().__init__(reason)
        self.exit_code = exit_code
        self.reason = reason


def recompute_diagnosis(outcome: dict) -> str | None:
    """Mirror contracts providerRecoveryDiagnosis for route-unavailable only.

    Anything the hub would diagnose as authentication or quota, or that stays
    ambiguous, returns None: the producer refuses instead of guessing.
    """
    if outcome.get("kind") != "failed":
        return None
    cause = outcome.get("cause") or {}
    if cause.get("error_name") and cause.get("class"):
        if cause["error_name"] == "provider.rate-limit" and cause["class"] == "rate_limit":
            return "provider_route_unavailable"
        return None
    data = cause.get("data") or {}
    if (cause.get("code") == -32603 and data.get("service") == "session"
            and data.get("error_name") == cause.get("error_name")
            and cause.get("error_name") in (
                "provider.rate-limit", "provider.no-route",
                "provider.transport", "provider.internal")
            and cause.get("class") != "diagnostic"):
        return "provider_route_unavailable"
    if ARCHIVED_ROUTE_FAILURE.fullmatch(str(outcome.get("stderr_tail", "")).strip()):
        return "provider_route_unavailable"
    return None


def load_snapshot(path: str) -> dict:
    with open(path) as fh:
        snapshot = json.load(fh)
    if "execution_state" not in snapshot:
        raise SystemExit("state snapshot must contain execution_state (from execution inspect)")
    return snapshot


def rpc(url: str, token: str, task: str, command_id: str, command: dict) -> dict:
    """Same wire contract as scripts/recover-provider-batch.py: MCP tools/call."""
    message = {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "execution", "arguments": {
            "id": task, "session": "configured-route-probe",
            "command_id": command_id, "command": command,
        }},
    }
    headers = [f"Authorization: Bearer {token}", "Content-Type: application/json",
               "Accept: application/json, text/event-stream"]
    cfg = "\n".join([f"url = {json.dumps(url)}", f"data-binary = {json.dumps(json.dumps(message))}",
                     *(f"header = {json.dumps(header)}" for header in headers)])
    raw = subprocess.run(["curl", "--silent", "--show-error", "--fail", "--max-time", "30", "-K", "-"],
                         input=cfg, capture_output=True, text=True, check=True).stdout
    if raw.startswith(("event:", "data:")):
        raw = next(line[6:] for line in raw.splitlines() if line.startswith("data: "))
    reply = json.loads(raw)
    result = reply.get("result", {})
    if "error" in reply or result.get("isError"):
        text = result.get("content", [{}])[0].get("text", "MCP request rejected")
        raise Refusal(7, f"submit-rejected: {text[:300]}")
    return json.loads(result["content"][0]["text"])


def fetch_live_snapshot(task: str, url: str, token: str) -> dict:
    digest = hashlib.sha256(task.encode()).hexdigest()[:16]
    inspect = rpc(url, token, task, f"probe:{digest}:inspect", {"kind": "inspect"})
    status = rpc(url, token, "gateway", f"probe:{digest}:status",
                 {"kind": "schedule_status", "refresh": True})
    return {"execution_state": inspect, "schedule_status": status}


def eligibility_refusal(snapshot: dict, expect: dict | None = None) -> str | None:
    """Refuse unless the target matches every gate recover_provider_failure enforces."""
    state = snapshot["execution_state"]
    task = snapshot.get("task") or {}
    attempt = state.get("attempt") or {}
    terminal = state.get("terminal") or {}
    if task and task.get("status") not in (None, "todo"):
        return f"status-{task.get('status')}"
    if task and task.get("owner"):
        return "owner-present"
    if attempt.get("phase") != "quiesced":
        return f"attempt-{attempt.get('phase') or 'missing'}"
    if not terminal:
        return "terminal-missing"
    if (terminal.get("generation") != attempt.get("generation")
            or terminal.get("attempt_id") != attempt.get("attempt_id")):
        return "terminal-mismatch"
    for op in state.get("operations") or []:
        if op.get("state") in ("prepared", "outcome_unknown"):
            return f"operation-{op.get('state')}"
    permit = state.get("recovery_permit")
    if permit and permit.get("phase") in ("available", "consumed"):
        return f"permit-{permit.get('phase')}"
    diagnosis = recompute_diagnosis(terminal.get("outcome") or {})
    if diagnosis != "provider_route_unavailable":
        return f"diagnosis-{diagnosis or 'unknown'}"
    executor = attempt.get("executor") or {}
    if [key for key in ("backend", "model", "config_revision") if not executor.get(key)]:
        return "executor-incomplete"
    if expect:
        mismatched = sorted(key for key, value in expect.items() if executor.get(key) != value)
        if mismatched:
            return "foreign-expectation:" + ",".join(mismatched)
    return None


def capacity_refusal(snapshot: dict, host: str) -> str | None:
    """Refuse when the host reports no spare capacity or is not live."""
    status = snapshot.get("schedule_status")
    if not status:
        return None
    entry = next((h for h in (status.get("hosts") or []) if h.get("host") == host), None)
    if entry is None:
        return "host-unknown"
    if not entry.get("live") or (entry.get("readiness") or {}).get("kind") != "ready":
        return "host-not-ready"
    free = (entry.get("capacity", 0) - entry.get("active", 0)
            - entry.get("reserved", 0) - entry.get("eligible", 0))
    if free < 1:
        return "capacity-full"
    return None


def config_refusal(config_path: str, configured_model: str) -> str | None:
    """Confirm the configured model is really configured before probing.

    Only the provider/model structure is read; option values (credentials) are
    never loaded into memory beyond the parse itself and never printed.
    """
    try:
        with open(config_path) as fh:
            cfg = json.load(fh)
    except FileNotFoundError:
        return f"config-missing:{config_path}"
    except json.JSONDecodeError:
        return "config-unreadable"
    if "/" not in configured_model:
        return None
    provider_id, model_id = configured_model.split("/", 1)
    provider = (cfg.get("provider") or {}).get(provider_id) or {}
    if model_id not in (provider.get("models") or {}):
        return f"config-model-missing:{configured_model}"
    return None


def ledger_refusal(ledger_path: str, proof_id: str, route: str, cooldown_ms: int, now_ms: int) -> str | None:
    rows = []
    if os.path.exists(ledger_path):
        with open(ledger_path) as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
    for row in rows:
        if proof_id and row.get("proof_id") == proof_id:
            return "duplicate-proof"
        if route and now_ms - int(row.get("ts") or 0) < cooldown_ms and row.get("route") == route:
            return "route-cooldown"
    return None


def record_ledger(ledger_path: str, row: dict) -> None:
    directory = os.path.dirname(os.path.expanduser(ledger_path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(ledger_path, "a") as fh:
        fh.write(json.dumps(row) + "\n")


def default_runner(command: list[str], timeout_s: float):
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout_s)


def run_probe(configured_model: str, title: str, timeout_s: float, runner=None):
    """One bounded neutral request through the transport; rc != 0 refuses."""
    runner = runner or default_runner
    command = ["opencode", "run", "--model", configured_model, "--format", "json",
               "--archived", "--title", title, PROBE_PROMPT]
    try:
        proc = runner(command, timeout_s)
    except subprocess.TimeoutExpired:
        raise Refusal(3, "probe-timeout")
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-200:]
        raise Refusal(3, f"probe-failed: rc={proc.returncode} {tail}")
    return proc


def capture_record(db_path: str, title: str, configured_model: str, output_bound: int,
                   probe_start_ms: int, now_ms: int, freshness_ms: int) -> dict:
    """Read the transport's own durable record for this probe run.

    Every proof field is derived from these rows; a missing, foreign or
    over-bound record is a refusal, never an invented value.
    """
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.OperationalError:
        raise Refusal(3, "capture-missing: transport store unreadable at this path")
    try:
        row = con.execute(
            "SELECT id, model, time_created FROM session_v2 WHERE title=? ORDER BY time_created DESC LIMIT 1",
            (title,)).fetchone()
        if not row:
            raise Refusal(3, "capture-missing: no transport session for this probe")
        session_id, created = row[0], int(row[2] or 0)
        if created < probe_start_ms - 5_000:
            raise Refusal(3, "capture-stale: transport session predates this probe")
        model = json.loads(row[1] or "{}")
        expected_provider, _, expected_id = configured_model.partition("/")
        if model.get("id") != expected_id or (expected_provider and model.get("providerID") != expected_provider):
            raise Refusal(3, f"capture-foreign: transport recorded "
                             f"{model.get('providerID')}/{model.get('id')}")
        msg = con.execute(
            "SELECT id, data FROM session_message WHERE session_id=? AND type='assistant' ORDER BY seq DESC LIMIT 1",
            (session_id,)).fetchone()
        if not msg:
            raise Refusal(3, "capture-missing: no assistant message recorded")
        data = json.loads(msg[1])
        tokens = data.get("tokens") or {}
        completed = int((data.get("time") or {}).get("completed") or 0)
        output = int(tokens.get("output") or 0)
        if output <= 0:
            raise Refusal(3, "capture-empty: no output tokens recorded")
        if output > output_bound:
            raise Refusal(3, f"capture-overbound: {output} > {output_bound}")
        if completed <= 0:
            raise Refusal(3, "capture-missing: no completion timestamp")
        if completed < probe_start_ms:
            raise Refusal(3, "capture-stale: completion predates the probe")
        if now_ms - completed > freshness_ms:
            raise Refusal(3, "capture-stale: past the freshness budget")
        return {"session_id": session_id, "message_id": msg[0],
                "model_id": model.get("id"), "provider_id": model.get("providerID"),
                "output_tokens": output, "completed_ms": completed, "finish": data.get("finish")}
    finally:
        con.close()


def compose_proof(proof_id: str, host: str, configured_model: str, config_revision: str,
                  config_receipt: str, record: dict) -> dict:
    actual = record["model_id"]
    response_receipt = f"opencode:assistant-message:{record['message_id']}"
    return {
        "id": proof_id,
        "host": host,
        "backend": "opencode",
        "model": configured_model,
        "config_revision": config_revision,
        "result": {"kind": "succeeded", "response_receipt": response_receipt},
        "observed_at": record["completed_ms"],
        "receipts": [f"opencode:session:{record['session_id']}", response_receipt,
                     f"opencode:tokens-output:{record['output_tokens']}"],
        "request": {"kind": "configured_model_request",
                    "max_output_tokens": record["output_tokens"], "tools": "none"},
        "actual_model": actual,
        "configuration_receipt": config_receipt,
        "witness": {
            "kind": "configured_proxy_request",
            "configured_model": configured_model,
            "allowed_actual_models": [actual],
            "observed_max_output_tokens": record["output_tokens"],
            "configuration_receipt": config_receipt,
        },
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("task", help="Task id the recovery targets (e.g. BR#18632)")
    parser.add_argument("--state", help="Snapshot JSON (execution inspect [+ schedule_status, task status/owner]); fetched live when omitted")
    parser.add_argument("--out", help="Write the proof JSON here as well as stdout")
    parser.add_argument("--expect-backend")
    parser.add_argument("--expect-model")
    parser.add_argument("--expect-config-revision")
    parser.add_argument("--host", help="Gateway inventory label; defaults to the failed attempt's host")
    parser.add_argument("--max-output-tokens", type=int, default=64,
                        help="Refuse the capture when the transport recorded more output tokens (default 64)")
    parser.add_argument("--freshness-seconds", type=int, default=240,
                        help="Refuse when the capture is older than this at proof time (default 240; hub gate is 300)")
    parser.add_argument("--cooldown-seconds", type=int, default=900,
                        help="Minimum spacing between probes of one route (default 900)")
    parser.add_argument("--probe-timeout", type=float, default=120)
    parser.add_argument("--ledger", default=os.path.expanduser("~/.bridge/configured-route-probes.jsonl"))
    parser.add_argument("--opencode-db", default=os.path.expanduser("~/.local/share/opencode/opencode.db"))
    parser.add_argument("--opencode-config", default=os.path.expanduser("~/.config/opencode/opencode.json"))
    parser.add_argument("--continuation", default="Continue the preserved task from its recorded checkpoint; "
                        "original failure evidence and retry budget are retained.")
    parser.add_argument("--submit", action="store_true",
                        help="Submit recover_provider_failure via BRIDGE_MCP_URL/BRIDGE_TOKEN; without it the script stays capture-only")
    args = parser.parse_args(argv)
    now_ms = int(time.time() * 1000)

    try:
        if args.state:
            snapshot = load_snapshot(args.state)
        else:
            url = os.environ.get("BRIDGE_MCP_URL")
            token = os.environ.get("BRIDGE_TOKEN")
            if not url or not token:
                raise Refusal(3, "no --state snapshot and no BRIDGE_MCP_URL/BRIDGE_TOKEN to fetch one; "
                                 "pass --state or export the environment")
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                raise Refusal(3, "BRIDGE_MCP_URL must use plain HTTPS")
            snapshot = fetch_live_snapshot(args.task, url, token)

        state = snapshot["execution_state"]
        attempt = state.get("attempt") or {}
        executor = attempt.get("executor") or {}
        host = args.host or attempt.get("host") or ""
        configured_model = executor.get("model") or ""
        config_revision = executor.get("config_revision") or ""
        expect = {"backend": args.expect_backend or executor.get("backend"),
                  "model": args.expect_model or configured_model,
                  "config_revision": args.expect_config_revision or config_revision}
        if reason := eligibility_refusal(snapshot, expect):
            raise Refusal(2, f"ineligible target: {reason}")
        if reason := capacity_refusal(snapshot, host):
            raise Refusal(5, f"no capacity to recover onto: {reason}")
        if reason := config_refusal(args.opencode_config, configured_model):
            raise Refusal(6, f"configured route unverifiable: {reason}")

        route = f"{executor.get('backend')}|{configured_model}|{config_revision}"
        if reason := ledger_refusal(args.ledger, "", route, args.cooldown_seconds * 1000, now_ms):
            raise Refusal(4, f"probe ledger refuses: {reason}")

        probe_start_ms = now_ms
        title = f"{args.task.lower().replace('#', '')}-route-probe-{probe_start_ms}"
        run_probe(configured_model, title, args.probe_timeout)
        record = capture_record(args.opencode_db, title, configured_model, args.max_output_tokens,
                                probe_start_ms, int(time.time() * 1000), args.freshness_seconds * 1000)

        provider_id, _, model_id = configured_model.partition("/")
        suffix = f"provider.{provider_id}.models.{model_id}" if provider_id else f"model.{model_id}"
        config_receipt = f"opencode:config:{args.opencode_config}#{suffix}"
        proof = compose_proof(f"configured-route-probe:{record['session_id']}", host, configured_model,
                              config_revision, config_receipt, record)
        if reason := ledger_refusal(args.ledger, proof["id"], "", 0, now_ms):
            raise Refusal(4, f"probe ledger refuses: {reason}")
        record_ledger(args.ledger, {"ts": now_ms, "task_id": args.task, "route": route,
                                    "proof_id": proof["id"], "session_id": record["session_id"],
                                    "observed_at": record["completed_ms"]})
        rendered = json.dumps(proof, indent=2)
        print(rendered)
        if args.out:
            with open(args.out, "w") as fh:
                fh.write(rendered + "\n")

        if not args.submit:
            print("capture-only: submit this proof through an authenticated interactive session "
                  "(tools.bridge.execution recover_provider_failure) or re-run with --submit",
                  file=sys.stderr)
            return 0

        url = os.environ.get("BRIDGE_MCP_URL")
        token = os.environ.get("BRIDGE_TOKEN")
        if not url or not token:
            print("capture-only: BRIDGE_MCP_URL/BRIDGE_TOKEN not set; submit the proof above "
                  "through an authenticated interactive session", file=sys.stderr)
            return 0
        diagnosis = recompute_diagnosis((state.get("terminal") or {}).get("outcome") or {})
        command = {"kind": "recover_provider_failure", "terminal": state["terminal"], "proof": proof,
                   "diagnosis": diagnosis, "continuation": args.continuation,
                   "evidence": [proof["result"]["response_receipt"], proof["receipts"][0],
                                f"diagnosis:{diagnosis}"]}
        result = rpc(url, token, args.task, f"configured-route-probe:{record['session_id']}", command)
        print(json.dumps(result, indent=2))
        return 0
    except Refusal as refusal:
        print(f"refusal [{refusal.exit_code}]: {refusal.reason}", file=sys.stderr)
        return refusal.exit_code


if __name__ == "__main__":
    sys.exit(main())
