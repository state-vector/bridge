#!/usr/bin/env python3
"""Apply one fresh route receipt to a small batch through the existing hub gates."""
import argparse
import hashlib
import json
import os
import subprocess
import time
import urllib.parse


def rpc(url, token, task, command_id, command):
    message = {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "execution", "arguments": {
            "id": task, "session": "provider-recovery-batch",
            "command_id": command_id, "command": command,
        }},
    }
    # Use curl's normal HTTPS client. Pass the credential over stdin so it
    # does not appear in process arguments and never follow redirects.
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
        raise ValueError(result.get("content", [{}])[0].get("text", "MCP request rejected"))
    return json.loads(result["content"][0]["text"])


def choose(status, proof, inspect, limit):
    free = max(0, status["capacity"] - status["active"] - status["reserved"] - status["eligible"])
    count = min(limit, free)
    if not count or not status["live"] or status["readiness"]["kind"] != "ready":
        return []
    candidates = []
    for task in status["held"].get("retry_budget", [])[:32]:
        state = inspect(task)
        attempt = state.get("attempt") or {}
        executor = attempt.get("executor") or {}
        terminal = state.get("terminal") or {}
        outcome = terminal.get("outcome") or {}
        cause = outcome.get("cause") or {}
        archived = outcome.get("stderr_tail", "").startswith(
            "acp session/prompt failed: Internal error: No deployments available for selected model,"
        )
        if (attempt.get("phase") == "quiesced" and attempt.get("host") == proof["host"]
                and all(executor.get(k) == proof[k] for k in ("backend", "model", "config_revision"))
                and terminal.get("attempt_id") == attempt.get("attempt_id")
                and terminal.get("generation") == attempt.get("generation")
                and (archived or cause.get("class") == "route_unavailable")
                and not any(op["state"] in ("prepared", "outcome_unknown") for op in state["operations"])
                and (state.get("recovery_permit") or {}).get("phase") != "available"):
            candidates.append((task, terminal))
            if len(candidates) == count:
                break
    return candidates


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("proof", type=argparse.FileType("r"), help="Fresh ProviderRecoveryProof JSON")
    parser.add_argument("--limit", type=int, choices=range(1, 5), default=4)
    parser.add_argument("--apply", action="store_true", help="Issue permits for the selected tasks")
    args = parser.parse_args()
    proof = json.load(args.proof)
    age = int(time.time() * 1000) - proof["observed_at"]
    if not 0 <= age < 300_000 or proof["witness"]["kind"] != "configured_proxy_request":
        parser.error("supply a fresh configured proxy receipt")
    url = os.environ["BRIDGE_MCP_URL"]
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        parser.error("BRIDGE_MCP_URL must use HTTPS")
    token = os.environ["BRIDGE_TOKEN"]

    def call(task, command, suffix):
        digest = hashlib.sha256(f"{proof['id']}:{task}:{suffix}".encode()).hexdigest()
        return rpc(url, token, task, f"provider-batch:{digest}", command)

    hosts = call("gateway", {"kind": "schedule_status", "host": proof["host"]}, "status")["hosts"]
    if len(hosts) != 1:
        parser.error("the proof must identify one gateway")
    candidates = choose(hosts[0], proof, lambda task: call(task, {"kind": "inspect"}, "inspect"), args.limit)
    for task, terminal in candidates:
        if not args.apply:
            print(json.dumps({"task_id": task, "generation": terminal["generation"], "status": "selected"}))
            continue
        try:
            result = call(task, {
                "kind": "recover_provider_failure", "terminal": terminal, "proof": proof,
                "diagnosis": "provider_route_unavailable",
                "continuation": "Check current upstream state, preserve prior work, and record a verified outcome.",
                "evidence": proof["receipts"],
            }, "grant")
            print(json.dumps({"task_id": task, "status": result["kind"]}))
        except ValueError:
            print(json.dumps({"task_id": task, "status": "rejected_by_hub"}))


if __name__ == "__main__":
    main()
