#!/usr/bin/env python3
"""Board hygiene sweeper: stale kanban cards + stale `in-progress` GitHub labels.

One pass, no daemon (runs from cron/systemd timer). Posts nags to
#cody-decisions and, where resolution is mechanical, fixes it:

GitHub (state-vector/superpositional, read-only audit + Slack nag):
  - `in-progress` issues untouched >48h            -> STALE list to #cody-decisions
  - CRITICAL/gtm-blocker issues untouched >48h     -> DECISION nag (ask Ray)
Kanban (all boards under ~/.hermes/kanban/boards):
  - running card, heartbeat >6h old, worker dead   -> reclaim + comment + nag
  - blocked card with needs_input, no movement 48h -> DECISION post to #cody-decisions
  - blocked card whose blocker quotes a finished
    thing is NOT auto-detected (human/agent reads
    the digest) — we only surface + age them.

Dry run: FLOWS_SWEEP_DRYRUN=1 prints actions, performs nothing.
"""
from __future__ import annotations

import glob
import json
import os
import sqlite3
import subprocess
import time
import urllib.request

REPO = os.environ.get("FLOWS_SWEEP_REPO", "state-vector/superpositional")
KANBAN_DIR = os.path.expanduser("~/.hermes/kanban/boards")
SLACK_CHANNEL = os.environ.get("SLACK_DECISIONS_CHANNEL", "C0C8VFQK7U4")  # #cody-decisions
DRY = os.environ.get("FLOWS_SWEEP_DRYRUN", "") == "1"
NOW = time.time()

STALE_GH_H = 48     # in-progress untouched
STALE_BLOCK_H = 48  # blocked/needs_input untouched
STALE_HB_H = 6      # running with no heartbeat


def sh(args: list[str], timeout: int = 60) -> str:
    return subprocess.run(args, capture_output=True, timeout=timeout).stdout.decode()


def slack_post(text: str) -> None:
    if DRY:
        print(f"[dry] would post to Slack:\n{text}\n")
        return
    env_file = os.path.expanduser("~/.hermes/profiles/coder/.env")
    tok = ""
    with open(env_file) as f:
        for line in f:
            if line.startswith("SLACK_BOT_TOKEN="):
                tok = line.split("=", 1)[1].strip().strip('"')
    import sys
    import urllib.parse
    import urllib.request

    data = urllib.parse.urlencode(
        {"channel": SLACK_CHANNEL, "text": text[:3900]}
    ).encode()
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=data,
        headers={"Authorization": f"Bearer {tok}"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        out = json.load(r)
        if not out.get("ok"):
            print(f"[slack] post failed: {out}", file=sys.stderr)


def gh_json(args: str):
    out = subprocess.run(
        ["gh", "api", "--paginate"] + args.split(), capture_output=True, timeout=120
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode()[:200])
    import json as j

    raw = out.stdout.decode()
    items, dec, idx = [], j.JSONDecoder(), 0
    while idx < len(raw):
        m = raw.find("[", idx)
        if m < 0:
            break
        obj, end = dec.raw_decode(raw, m)
        items.extend(obj)
        idx = end
    return items


def age_h(iso: str) -> float:
    import datetime

    t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    return (NOW - t) / 3600


def sweep_github() -> list[str]:
    lines = []
    issues = gh_json(f"repos/{REPO}/issues?state=open&per_page=100")
    stale_ip, stale_block = [], []
    for it in issues:
        if "pull_request" in it:
            continue
        labels = {l["name"] for l in it["labels"]}
        a = age_h(it["updated_at"])
        num, title = it["number"], it["title"][:70]
        if "in-progress" in labels and a > STALE_GH_H:
            stale_ip.append((num, a, title))
            if not DRY:
                subprocess.run(
                    ["gh", "issue", "edit", str(num), "-R", REPO,
                     "--remove-label", "in-progress"],
                    capture_output=True,
                )
                lines.append(f"⚙ removed stale `in-progress` from #{num} ({a:.0f}h idle) — {title}")
            else:
                lines.append(f"[dry] would remove `in-progress` #{num} ({a:.0f}h idle)")
        if (labels & {"CRITICAL", "gtm-blocker"}) and a > STALE_BLOCK_H:
            stale_block.append((num, a, title))
    if stale_ip or stale_block:
        msg = ["*board sweep — stale work (state-vector)*"]
        if stale_block:
            msg.append("*Decision needed (CRITICAL/gtm-blocker idle >48h — ask Ray):*")
            for n, a, t in sorted(stale_block, key=lambda x: -x[1]):
                msg.append(f"  • <https://github.com/{REPO}/issues/{n}|#{n}> ({a:.0f}h idle) {t}")
        if stale_ip and DRY:
            msg.append("*Would clear `in-progress` (idle >48h):*")
            for n, a, t in sorted(stale_ip, key=lambda x: -x[1]):
                msg.append(f"  • #{n} ({a:.0f}h idle) {t}")
        if stale_ip and not DRY:
            done = [l for l in lines if "#"]
            if done:
                msg.append("*Auto-hygiene this pass:*")
                msg.extend(f"  • {l}" for l in done)
        slack_post("\n".join(msg))
    return lines


def kanban_db_h() -> str | None:
    dbs = sorted(glob.glob(os.path.join(KANBAN_DIR, "*", "kanban.db")))
    return dbs[0] if dbs else None


def sweep_kanban() -> list[str]:
    lines = []
    for db in glob.glob(os.path.join(KANBAN_DIR, "*", "kanban.db")):
        slug = db.split("/")[-2]
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT id,title,status,assignee,last_heartbeat_at,worker_pid,block_kind "
            "FROM tasks WHERE status IN ('running','blocked')",
        ).fetchall()
        con.close()
        for r in rows:
            tid, status, title = r["id"], r["status"], (r["title"] or "")[:60]
            if status == "running":
                hb = r["last_heartbeat_at"]
                if hb and (NOW - hb) / 3600 > STALE_HB_H:
                    # confirm the worker is actually dead before touching
                    pid = r["worker_pid"]
                    alive = False
                    if pid:
                        try:
                            os.kill(pid, 0)
                            alive = True
                        except ProcessLookupError:
                            alive = False
                        except PermissionError:
                            alive = True
                    if not alive:
                        lines.append(f"reclaiming dead worker on {tid} ({slug}): {title}")
                        if not DRY:
                            subprocess.run(
                                ["hermes", "kanban", "reclaim", tid],
                                capture_output=True,
                                env={**os.environ, "HERMES_KANBAN_DB": db},
                            )
            elif status == "blocked":
                age = blocked_age_h(db, tid)
                if age is not None and age > STALE_BLOCK_H and r["block_kind"] in (None, "needs_input", "diagnostic"):
                    lines.append(f"DECISION: {tid} blocked {age:.0f}h: {title}")
    return lines


def blocked_age_h(db: str, tid: str) -> float | None:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    row = con.execute(
        "SELECT created_at FROM task_events WHERE task_id=? AND kind='blocked' ORDER BY id DESC LIMIT 1",
        (tid,),
    ).fetchone()
    con.close()
    return (NOW - row[0]) / 3600 if row else None


def main() -> None:
    gh_lines = sweep_github()
    kb_lines = sweep_kanban()
    if kb_lines:
        msg = ["*board sweep — kanban*"]
        for l in kb_lines:
            msg.append(f"  • {l}")
        if any(l.startswith("DECISION") for l in kb_lines):
            slack_post("\n".join(msg))
    print(f"[sweep] github: {len(gh_lines)} actions; kanban: {len(kb_lines)} findings")


if __name__ == "__main__":
    main()
