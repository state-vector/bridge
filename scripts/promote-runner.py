"""Event-triggered promotion. Both CI and dev-build must succeed for the SAME
main SHA. Either workflow completion can reconcile the pair; no busy polling.
"""
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
import time

PUBLISH_URL = "https://hub.fleetbridge.run/api/runner-updates/publish"
RETRYABLE = (404, 429, 500, 502, 503, 504)
PUBLISH_ATTEMPTS = 12
DEFAULT_BACKOFF_SECS = 15
MAX_BACKOFF_SECS = 120
TIMING_EXPOSURE_CAP_SECS = 3600
# Bounded, fixed publication stages the publisher may echo from a failure body.
PUBLICATION_STAGES = ("github_verification", "manifest_fetch")


def log_publication(status, body, token, **fields):
    detail = body.decode(errors="replace").strip()
    if token:
        detail = detail.replace(token, "[redacted]")
    # The legacy Actions command parser looks for ##[ anywhere.
    diagnostic = json.dumps({"publication_http": status, **fields, "detail": detail})
    print(diagnostic.replace("#", r"\u0023"), flush=True)


def bounded_publication_stage(body):
    """Echo only a fixed stage value; anything else stays suppressed."""
    try:
        stage = json.loads(body).get("stage")
    except (ValueError, AttributeError):
        return None
    return stage if stage in PUBLICATION_STAGES else None


def provider_retry_seconds(headers, body):
    """The provider's own retry timing: fixed Retry-After header first, then a
    bounded body retry_after_secs. Only finite integer seconds are honored."""
    seconds = _bounded_integer(headers.get("Retry-After")) if headers else None
    if seconds is not None:
        return seconds
    try:
        return _bounded_integer(json.loads(body).get("retry_after_secs"))
    except (ValueError, AttributeError):
        return None


def _bounded_integer(value):
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return None
    if seconds < 1:
        return None
    return min(seconds, TIMING_EXPOSURE_CAP_SECS)


def publish_channel(payload, token, sleep=time.sleep, urlopen=None):
    urlopen = urlopen or urllib.request.urlopen
    request = urllib.request.Request(PUBLISH_URL,
                                     data=json.dumps(payload).encode(), headers={"content-type": "application/json", "user-agent": "bridge-runner-updater/1",
                                     "authorization": "Bearer " + token})
    # Only deployment/transport recovery is retried. A semantic rejection is a
    # broken publication and fails the job instead of looping until it passes.
    # Every retryable attempt exposes its bounded stage/status and honors the
    # provider's retry timing, inside this unchanged bounded attempt window.
    for attempt in range(1, PUBLISH_ATTEMPTS + 1):
        try:
            with urlopen(request, timeout=45) as response:
                log_publication(response.status, response.read(2048), token)
            return
        except urllib.error.HTTPError as error:
            body = error.read(2048)
            stage = bounded_publication_stage(body)
            retry_after = provider_retry_seconds(error.headers, body)
            fields = {"publication_attempt": attempt}
            if stage:
                fields["publication_stage"] = stage
            if retry_after is not None:
                fields["retry_after_secs"] = retry_after
            if attempt == PUBLISH_ATTEMPTS or error.code not in RETRYABLE:
                log_publication(error.code, body, token, **fields)
                raise
            wait = min(retry_after, MAX_BACKOFF_SECS) if retry_after is not None else DEFAULT_BACKOFF_SECS
            log_publication(error.code, body, token, next_wait_secs=wait, **fields)
            sleep(wait)
        except (OSError, TimeoutError):
            if attempt == PUBLISH_ATTEMPTS:
                raise
            sleep(DEFAULT_BACKOFF_SECS)


def main():
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

    channels = [("main", None)]
    release = successful("release.yml")
    if release:
        channels.append(("stable", release["id"]))
    for channel, release_run in channels:
        payload = {"channel": channel, "commit": sha, "ci_run": ci["id"], "build_run": build["id"]}
        if release_run:
            payload["release_run"] = release_run
        publish_channel(payload, job_token)


if __name__ == "__main__":
    main()
