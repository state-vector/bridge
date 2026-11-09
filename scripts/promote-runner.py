"""Event-triggered promotion. Both CI and dev-build must succeed for the SAME
main SHA. Either workflow completion can reconcile the pair; no busy polling.
"""
import json
import os
import re
import subprocess
import urllib.request
import time

sha = os.environ["TRIGGER_SHA"]
if not re.fullmatch(r"[0-9a-f]{40}", sha):
    raise SystemExit("expected an exact runner source commit SHA")
job_token = os.environ["GH_TOKEN"]
query = f"repos/state-vector/bridge/actions/runs?head_sha={sha}&per_page=100"
runs = json.loads(subprocess.check_output(["gh", "api", query]))["workflow_runs"]

def successful(path, branch=None):
    return next((r for r in runs if r["path"] == f".github/workflows/{path}" and r["conclusion"] == "success"
                 and r["status"] == "completed" and r["event"] == "push" and (branch is None or r["head_branch"] == branch)), None)

ci, build = successful("ci.yml", "main"), successful("dev-build.yml", "main")
if not ci or not build:
    print("source build/CI pair not green yet; its completion event will reconcile")
    raise SystemExit(0)

def log_publication(status, body):
    detail = body.decode(errors="replace").strip()
    if job_token:
        detail = detail.replace(job_token, "[redacted]")
    # The legacy Actions command parser looks for ##[ anywhere.
    diagnostic = json.dumps({"publication_http": status, "detail": detail})
    print(diagnostic.replace("#", r"\u0023"), flush=True)

channels = [("main", None)]
release = successful("release.yml")
if release:
    channels.append(("stable", release["id"]))
for channel, release_run in channels:
    payload = {"channel": channel, "commit": sha, "ci_run": ci["id"], "build_run": build["id"]}
    if release_run:
        payload["release_run"] = release_run
    request = urllib.request.Request("https://hub.fleetbridge.run/api/runner-updates/publish",
                                     data=json.dumps(payload).encode(), headers={"content-type": "application/json", "user-agent": "bridge-runner-updater/1",
                                     "authorization": "Bearer " + job_token})
    # Only deployment/transport recovery is retried. A semantic rejection is a
    # broken publication and fails the job instead of looping until it passes.
    for attempt in range(12):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                log_publication(response.status, response.read(2048))
            break
        except urllib.error.HTTPError as error:
            if attempt == 11 or error.code not in (404, 429, 500, 502, 503, 504):
                log_publication(error.code, error.read(2048))
                raise
        except (OSError, TimeoutError):
            if attempt == 11:
                raise
        time.sleep(15)
