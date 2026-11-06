"""Event-triggered promotion. Both CI and dev-build must succeed for the SAME
main SHA. Either workflow completion can reconcile the pair; no busy polling.
"""
import json
import os
import subprocess
import urllib.request
import time

sha = os.environ["TRIGGER_SHA"]
query = f"repos/state-vector/bridge/actions/runs?head_sha={sha}&per_page=100"
runs = json.loads(subprocess.check_output(["gh", "api", query]))["workflow_runs"]

def successful(path, branch=None):
    return next((r for r in runs if r["path"] == f".github/workflows/{path}" and r["conclusion"] == "success"
                 and r["status"] == "completed" and r["event"] == "push" and (branch is None or r["head_branch"] == branch)), None)

ci, build = successful("ci.yml", "main"), successful("dev-build.yml", "main")
if not ci or not build:
    print("source build/CI pair not green yet; its completion event will reconcile")
    raise SystemExit(0)

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
                                     "authorization": "Bearer " + os.environ["GH_TOKEN"]})
    # Only deployment/transport recovery is retried. A semantic rejection is a
    # broken publication and fails the job instead of looping until it passes.
    for attempt in range(12):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                print(response.read().decode())
            break
        except urllib.error.HTTPError as error:
            if error.code not in (404, 429, 500, 502, 503, 504):
                print(error.read().decode()[:2000])
                raise
            if attempt == 11:
                raise
        except (OSError, TimeoutError):
            if attempt == 11:
                raise
        time.sleep(15)
