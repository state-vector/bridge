"""Event-triggered promotion. Both CI and dev-build must succeed for the SAME
main SHA. Either workflow completion can reconcile the pair; no busy polling.
"""
from email.utils import parsedate_to_datetime
import json
import math
import os
import re
import subprocess
import time
import urllib.request

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

RETRYABLE_STATUS = (404, 429, 500, 502, 503, 504)
RETRY_STAGES = {"verify_ci", "verify_build", "verify_release", "fetch_manifest", "publication_rate", "publish"}
MAX_ATTEMPTS = 12
REQUEST_TIMEOUT = 45
RETRY_DELAY = 15
RETRY_BUDGET = MAX_ATTEMPTS * REQUEST_TIMEOUT + (MAX_ATTEMPTS - 1) * RETRY_DELAY


def retry_after_seconds(value):
    if not value:
        return 0
    if re.fullmatch(r"[0-9]{1,12}", value):
        return int(value)
    try:
        date = parsedate_to_datetime(value)
        return max(0, math.ceil(date.timestamp() - time.time())) if date.tzinfo else 0
    except (TypeError, ValueError, OverflowError):
        return 0


def publication_retry_delay(error):
    delay = retry_after_seconds(error.headers.get("Retry-After"))
    diagnostic = {"publication_http": error.code}
    try:
        details = json.loads(error.read(2048))
    except (OSError, ValueError):
        details = None
    if isinstance(details, dict):
        stage = details.get("stage")
        if isinstance(stage, str) and stage in RETRY_STAGES:
            diagnostic["stage"] = stage
        upstream = details.get("upstream_status")
        if type(upstream) is int and 100 <= upstream <= 599:
            diagnostic["upstream_status"] = upstream
        reset_at = details.get("rate_reset_at")
        if type(reset_at) is int and 0 < reset_at < 10 ** 12:
            diagnostic["rate_reset_at"] = reset_at
            delay = max(delay, math.ceil(reset_at - time.time()))
    diagnostic["retry_after_seconds"] = delay
    print(json.dumps(diagnostic), flush=True)
    return max(RETRY_DELAY, delay)


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
    deadline = time.monotonic() + RETRY_BUDGET
    for attempt in range(MAX_ATTEMPTS):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("runner publication retry budget exhausted")
        delay = RETRY_DELAY
        try:
            with urllib.request.urlopen(request, timeout=min(REQUEST_TIMEOUT, remaining)) as response:
                log_publication(response.status, response.read(2048))
            break
        except OSError as error:
            if isinstance(error, urllib.error.HTTPError):
                with error:
                    if error.code not in RETRYABLE_STATUS:
                        log_publication(error.code, error.read(2048))
                        raise
                    delay = publication_retry_delay(error)
            if attempt == MAX_ATTEMPTS - 1:
                raise
            if delay >= deadline - time.monotonic():
                raise RuntimeError("provider retry window exceeds runner publication retry budget") from error
        time.sleep(delay)
