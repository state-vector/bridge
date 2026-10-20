#!/usr/bin/env python3
"""flows adapter: tails Hermes kanban task_events → flows /ingest door.

Contract (see adapters/README.md): every kanban event becomes
  { id, source:"kanban", board, kind, ts, task_id, title, actor, payload }
Heartbeats are collapsed client-side (≥60s per task) and noise kinds skipped,
so presence costs ~nothing against the Workers free tier.

Env:
  BRIDGE_INGEST_URL    https://<your-subdomain>.workers.dev/ingest
  BRIDGE_INGEST_TOKEN  shared bearer token
  BRIDGE_POLL_S        poll interval seconds (default 5)
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request

KANBAN_DIR = os.environ.get("BRIDGE_KANBAN_DIR", os.path.expanduser("~/.hermes/kanban"))
STATE_PATH = os.path.expanduser("~/.hermes/flowsync/cursor.json")
POLL_S = float(os.environ.get("BRIDGE_POLL_S", "5"))
HEARTBEAT_MIN_GAP_S = 60
SKIP_KINDS = {"tip_scratch_workspace", "terminal_worker_reaped"}


def boards() -> dict[str, str]:
    d = os.path.join(KANBAN_DIR, "boards")
    out = {}
    if os.path.isdir(d):
        for slug in sorted(os.listdir(d)):
            p = os.path.join(d, slug, "kanban.db")
            if os.path.isfile(p):
                out[slug] = p
    return out


def load_cursor() -> dict:
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def save_cursor(c: dict) -> None:
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(c, f)
    os.replace(tmp, STATE_PATH)


def new_events(db_path: str, slug: str, last_id: int, limit: int = 500) -> list[dict]:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT id, task_id, run_id, kind, payload, created_at "
            "FROM task_events WHERE id > ? ORDER BY id LIMIT ?",
            (last_id, limit)).fetchall()
        out = []
        for r in rows:
            kind = r["kind"]
            if kind in SKIP_KINDS:
                continue
            try:
                payload = json.loads(r["payload"]) if r["payload"] else {}
            except Exception:
                payload = {"raw": (r["payload"] or "")[:200]}
            t = con.execute(
                "SELECT title, status, assignee FROM tasks WHERE id=?",
                (r["task_id"],)).fetchone()
            actor = None
            if payload.get("author"):
                actor = f"agent:{payload['author']}"
            elif t and t["assignee"]:
                actor = f"agent:{t['assignee']}"
            out.append({
                "id": f"{slug}:{r['id']}",
                "source": "kanban",
                "board": slug,
                "kind": kind,
                "ts": r["created_at"],
                "task_id": r["task_id"],
                "run_id": r["run_id"],
                "title": t["title"] if t else None,
                "task_status": t["status"] if t else None,
                "actor": actor,
                "payload": payload,
            })
        return out
    finally:
        con.close()


def collapse(events: list[dict], last_hb: dict[str, float]) -> tuple[list[dict], dict[str, float]]:
    """Drop heartbeats closer than HEARTBEAT_MIN_GAP_S per task."""
    out = []
    for e in events:
        if e["kind"] == "heartbeat":
            key = e["task_id"] or "?"
            if e["ts"] - last_hb.get(key, 0) < HEARTBEAT_MIN_GAP_S:
                continue
            last_hb[key] = e["ts"]
        out.append(e)
    return out, last_hb


def post(endpoint: str, token: str, events: list[dict]) -> bool:
    body = json.dumps({"events": events}).encode()
    req = urllib.request.Request(
        endpoint, data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as e:
        print(f"[shipper] HTTP {e.code}: {e.read()[:200]!r}", flush=True)
        return False
    except Exception as e:
        print(f"[shipper] post failed: {e}", flush=True)
        return False


def main() -> None:
    endpoint = os.environ.get("BRIDGE_INGEST_URL", "").rstrip("/")
    token = os.environ.get("BRIDGE_INGEST_TOKEN", "")
    if not endpoint or not token:
        print("BRIDGE_INGEST_URL and BRIDGE_INGEST_TOKEN required", flush=True)
        sys.exit(1)

    print(f"[shipper] tailing {KANBAN_DIR} -> {endpoint}", flush=True)
    cursor = load_cursor()
    last_hb: dict[str, float] = {}
    while True:
        try:
            batch: list[dict] = []
            new_cursor = dict(cursor)
            for slug, path in boards().items():
                last = int(cursor.get(slug, 0))
                evs = new_events(path, slug, last)
                if evs:
                    new_cursor[slug] = int(evs[-1]["id"].rsplit(":", 1)[1])
                    evs, last_hb = collapse(evs, last_hb)
                    if evs:
                        batch.extend(evs)
            if batch:
                if post(endpoint, token, batch):
                    save_cursor(new_cursor)
                    cursor = new_cursor
                    kinds: dict[str, int] = {}
                    for e in batch:
                        kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
                    print(f"[shipper] shipped {len(batch)}: {kinds}", flush=True)
                else:
                    print(f"[shipper] batch of {len(batch)} held for retry", flush=True)
        except Exception as e:
            print(f"[shipper] loop error: {e}", flush=True)
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
