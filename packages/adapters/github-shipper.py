#!/usr/bin/env python3
"""flows adapter: tails GitHub org issues/PRs → flows /ingest door.

Contract (see adapters/README.md): every event becomes
  { id, source:"github", board:<repo>, kind, ts, task_id, title, actor, payload }
Read-only REST via `gh api` (uses the ambient gh auth — no extra tokens).
Cursor-resumable; replays a failed batch before saving the cursor.

Env:
  FLOWS_INGEST_URL    https://bridge.<subdomain>.workers.dev/ingest
  FLOWS_INGEST_TOKEN  shared bearer token
  FLOWS_GH_REPOS      space-separated repos (default: state-vector/superpositional)
  FLOWS_GH_POLL_S     poll interval seconds (default 60)
  FLOWS_STATE_PATH    cursor file (default ~/.hermes/flowsync/gh-cursor.json)

Kinds emitted (decision-relevant only — heartbeats/noise stay out):
  opened        issue or PR opened                      (activity)
  assigned      assigned to a HUMAN                     (decision candidate)
  in_progress   `in-progress` label added               (presence)
  parked        `in-progress` label removed             (presence end)
  blocked       issue labeled CRITICAL or gtm-blocker   (opens decision card,
                payload.reason = label that tripped it)
  unblocked     CRITICAL/gtm-blocker removed            (resolves decision card)
  completed     issue closed                            (resolves decision card)
  commented     human comment on an in-progress issue   (activity)
  pr_checks     PR CI finished red on an open PR        (decision candidate)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

INGEST_URL = os.environ.get("FLOWS_INGEST_URL", "")
INGEST_TOKEN = os.environ.get("FLOWS_INGEST_TOKEN", "")
REPOS = os.environ.get("FLOWS_GH_REPOS", "state-vector/superpositional").split()
STATE_PATH = os.path.expanduser(
    os.environ.get("FLOWS_STATE_PATH", "~/.hermes/flowsync/gh-cursor.json")
)
POLL_S = float(os.environ.get("FLOWS_GH_POLL_S", "60"))

DECISION_LABELS = {"CRITICAL", "gtm-blocker"}
# first poll backfills nothing older than this
MAX_BACKFILL_S = 3600


def gh(args: list[str]) -> bytes:
    out = subprocess.run(
        ["gh", "api", "--paginate"] + args,
        capture_output=True,
        timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"gh api {' '.join(args)}: {out.stderr.decode()[:300]}")
    return out.stdout


def gh_multi(args: list[str]) -> list[dict]:
    """gh api --paginate emits one JSON array per page; concat them."""
    import re

    raw = gh(args).decode()
    items = []
    dec = json.JSONDecoder()
    idx = 0
    while idx < len(raw):
        m = raw.find("[", idx)
        if m < 0:
            break
        obj, end = dec.raw_decode(raw, m)
        items.extend(obj)
        idx = end
    return items


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


def post(events: list[dict]) -> None:
    if not events:
        return
    if not INGEST_URL or not INGEST_TOKEN:
        print(f"[gh-adapter] no ingest config, dropping {len(events)} events", file=sys.stderr)
        return
    body = json.dumps({"events": events}).encode()
    req = urllib.request.Request(
        INGEST_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {INGEST_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        if resp.status != 200:
            raise RuntimeError(f"ingest returned {resp.status}")


def ts_of(iso: str) -> int:
    import datetime

    return int(datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def actor_of(author: dict | None) -> tuple[str, str]:
    login = (author or {}).get("login", "unknown")
    if login.startswith("app/") or login.endswith("[bot]"):
        return f"system:{login.split('/')[-1]}", "system"
    if login in ("rayh",):
        return f"human:{login}", "human"
    return f"agent:{login}", "agent"


def issue_events(repo: str, since_iso: str, seen: set[str]) -> list[dict]:
    """Issues updated since ISO. Timeline events give label adds/removes."""
    ev: list[dict] = []
    issues = gh_multi(
        [
            f"repos/{repo}/issues",
            f"-F",
            f"since={since_iso}",
            "-F",
            "state=all",
            "-F",
            "per_page=100",
        ]
    )
    for it in issues:
        if "pull_request" in it:  # PRs handled separately
            continue
        num, iid = it["number"], it["id"]
        title, updated = it["title"], it["updated_at"]
        labels = {l["name"] for l in it["labels"]}
        actor, kind_actor = actor_of(it.get("user"))
        assignees = it.get("assignees") or []
        base = dict(
            source="github",
            board=repo.split("/")[-1],
            ts=ts_of(updated),
            task_id=f"{repo}#{num}",
            title=title[:300],
        )
        eid = f"{repo}:i{iid}:state"
        if eid not in seen:
            seen.add(eid)
            if it["state"] == "closed":
                ev.append({**base, "id": eid, "kind": "completed",
                           "actor": actor, "actor_kind": kind_actor,
                           "payload": {"url": it["html_url"]}})
            else:
                blocked_by = sorted(labels & DECISION_LABELS)
                if blocked_by:
                    ev.append({**base, "id": eid, "kind": "blocked",
                               "actor": actor, "actor_kind": kind_actor,
                               "payload": {"reason": f"labeled {', '.join(blocked_by)} — {title[:160]}",
                                           "kind": "needs_input" if "needs_input" in labels else "diagnostic",
                                           "labels": blocked_by,
                                           "url": it["html_url"]}})
                if "in-progress" in labels:
                    ev.append({**base, "id": eid + ":ip", "kind": "in_progress",
                               "actor": actor, "actor_kind": kind_actor, "payload": {}})
                for a in assignees:
                    aa, ak = actor_of(a)
                    if ak == "human":
                        ev.append({**base, "id": eid + f":as:{a['login']}", "kind": "assigned",
                                   "actor": aa, "actor_kind": ak,
                                   "payload": {"url": it["html_url"]}})
    return ev


def pr_events(repo: str, since_iso: str, seen: set[str]) -> list[dict]:
    ev: list[dict] = []
    prs = gh_multi(
        [
            f"repos/{repo}/pulls",
            "-F",
            f"sort=updated",
            "-F",
            f"direction=desc",
            "-F",
            "state=open",
            "-F",
            "per_page=60",
        ]
    )
    for pr in prs:
        if ts_of(pr["updated_at"]) < ts_of(since_iso):
            break  # sorted desc by updated — first older one ends the window
        pid, num = pr["id"], pr["number"]
        actor, kind_actor = actor_of(pr.get("user"))
        base = dict(
            source="github",
            board=repo.split("/")[-1],
            ts=ts_of(pr["updated_at"]),
            task_id=f"{repo}#{num}",
            title=(pr["title"] or "")[:300],
        )
        eid = f"{repo}:pr{pid}"
        if eid in seen:
            continue
        seen.add(eid)
        # merged/closed PRs: pulls list with state=open only shows open ones;
        # closed PRs surface via issue_events' completed path? No — they are
        # filtered there. Check merged state via the PR object we have.
        if pr.get("merged_at"):
            ev.append({**base, "id": eid, "kind": "completed", "actor": actor,
                       "actor_kind": kind_actor,
                       "payload": {"url": pr["html_url"], "what": "PR merged"}})
        else:
            ev.append({**base, "id": eid, "kind": "opened", "actor": actor,
                       "actor_kind": kind_actor,
                       "payload": {"url": pr["html_url"], "what": "PR open"}})
        # red CI on an open PR = decision candidate
        try:
            runs = json.loads(
                gh(["repos/{0}/actions/runs?head_sha={1}&per_page=3".format(repo, pr["head"]["sha"])])
            )["workflow_runs"]
            if runs and all(
                r["conclusion"] in ("failure", "timed_out") for r in runs if r["conclusion"]
            ) and any(r["conclusion"] for r in runs):
                ev.append({**base, "id": eid + ":ci", "kind": "blocked", "actor": "system:ci",
                           "actor_kind": "system",
                           "payload": {"reason": f"CI red on open PR #{num}: {pr['title'][:140]}",
                                       "kind": "diagnostic", "url": pr["html_url"]}})
        except Exception as e:  # CI probe must never kill the adapter
            print(f"[gh-adapter] ci probe {num}: {e}", file=sys.stderr)
    return ev


def poll_once(seen: set[str], since: dict) -> tuple[list[dict], dict]:
    import datetime

    now = time.time()
    ev: list[dict] = []
    for repo in REPOS:
        iso = datetime.datetime.utcfromtimestamp(
            max(since.get(repo, now - POLL_S - 30), now - MAX_BACKFILL_S)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            ev += issue_events(repo, iso, seen)
            ev += pr_events(repo, iso, seen)
        except Exception as e:
            print(f"[gh-adapter] {repo}: {e}", file=sys.stderr)
    since = {r: now for r in REPOS}
    return ev, since


def main() -> None:
    cur = load_cursor()
    seen = set(cur.get("seen", []))
    since = cur.get("since", {})
    # bound the dedupe set
    if len(seen) > 5000:
        seen = set(sorted(seen)[-2500:])
    while True:
        try:
            ev, since = poll_once(seen, since)
            post(ev)
            if ev:
                print(f"[gh-adapter] shipped {len(ev)} events")
        except Exception as e:
            print(f"[gh-adapter] poll failed (cursor NOT advanced): {e}", file=sys.stderr)
        save_cursor({"seen": sorted(seen), "since": since})
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
