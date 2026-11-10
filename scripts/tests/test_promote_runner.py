"""Runner-channel publication loop controls (BR#9305).

The publisher must expose a bounded, fixed publication stage/status for every
attempt and honor the provider's retry timing inside the unchanged 12-attempt
window — never mask a provider quota exhaustion behind blind 15-second sleeps.
Exhaustion, fallback, recovery and fail-fast semantics are each pinned here.
"""
import contextlib
import importlib.util
import io
import json
import unittest
import urllib.error
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'promote_runner', Path(__file__).parents[1] / 'promote-runner.py')
promote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promote)

TOKEN = "ghs_short_lived_job_token"
PAYLOAD = {"channel": "main", "commit": "a" * 40, "ci_run": 10, "build_run": 11}
STAGES = {"github_verification", "manifest_fetch"}


def body_error(status, body, headers=None):
    payload = body.encode() if isinstance(body, str) else body
    return urllib.error.HTTPError("https://hub.fleetbridge.run", status, "exhausted",
                                  headers or {}, io.BytesIO(payload))


class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self._body = body.encode() if isinstance(body, str) else body

    def read(self, _size=-1):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def body_json(**fields):
    return json.dumps({"error": "transient", **fields})


class PublisherLoopHarness:
    """Records every HTTP attempt, every sleep and every publication line.

    Outcomes may be values or zero-arg factories; a fresh error is built per
    attempt because a real HTTPError's body stream is consumed when read."""

    def __init__(self, outcomes):
        self.outcomes = outcomes
        self.calls = 0
        self.sleeps = []
        self.stdout = io.StringIO()

    def run(self, payload=PAYLOAD, token=TOKEN):
        index = {"next": 0}

        def urlopen(request, timeout=None):
            self.calls += 1
            outcome = self.outcomes[min(index["next"], len(self.outcomes) - 1)]
            index["next"] += 1
            if callable(outcome):
                outcome = outcome()
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        def sleep(seconds):
            self.sleeps.append(seconds)

        with contextlib.redirect_stdout(self.stdout):
            try:
                promote.publish_channel(payload, token, sleep=sleep, urlopen=urlopen)
            finally:
                pass
        return self.stdout.getvalue()

    def lines(self):
        text = self.stdout.getvalue()
        return [] if not text.strip() else [json.loads(line) for line in text.splitlines()]


def exhausted_503(retry_after=None, body=None):
    headers = {"Retry-After": str(retry_after)} if retry_after is not None else {}
    return body_error(503, body if body is not None else body_json(), headers)


class PublicationRetryWindowTests(unittest.TestCase):
    def test_provider_retry_after_is_honored_within_the_unchanged_twelve_attempt_window(self):
        """503 + Retry-After: 45 → 12 attempts, waits of 45s, never blind 15s."""
        harness = PublisherLoopHarness([lambda: exhausted_503(retry_after=45)])
        with self.assertRaises(urllib.error.HTTPError):
            harness.run()
        self.assertEqual(harness.calls, promote.PUBLISH_ATTEMPTS)
        self.assertEqual(harness.sleeps, [45] * (promote.PUBLISH_ATTEMPTS - 1))

    def test_body_retry_after_secs_is_honored_when_the_header_is_absent(self):
        harness = PublisherLoopHarness([lambda: exhausted_503(body=body_json(retry_after_secs=90))])
        with self.assertRaises(urllib.error.HTTPError):
            harness.run()
        self.assertEqual(harness.calls, promote.PUBLISH_ATTEMPTS)
        self.assertEqual(harness.sleeps, [90] * (promote.PUBLISH_ATTEMPTS - 1))

    def test_provider_timing_is_capped_at_the_publisher_wait_limit(self):
        """A provider may demand hours; the publisher never sleeps past 120s."""
        harness = PublisherLoopHarness([lambda: exhausted_503(retry_after=900)])
        with self.assertRaises(urllib.error.HTTPError):
            harness.run()
        self.assertEqual(harness.calls, promote.PUBLISH_ATTEMPTS)
        self.assertEqual(harness.sleeps, [120] * (promote.PUBLISH_ATTEMPTS - 1))

    def test_unbounded_or_nonsense_timing_falls_back_to_the_default(self):
        for timing in ["soon", "0", "-5", "36.5"]:
            harness = PublisherLoopHarness([lambda: exhausted_503(retry_after=timing)])
            with self.assertRaises(urllib.error.HTTPError):
                harness.run()
            self.assertEqual(harness.calls, promote.PUBLISH_ATTEMPTS)
            self.assertEqual(harness.sleeps, [promote.DEFAULT_BACKOFF_SECS] * (promote.PUBLISH_ATTEMPTS - 1),
                             f"timing {timing!r} must fall back to the default backoff")


class PublicationExhaustionDiagnosticsTests(unittest.TestCase):
    def test_every_exhaustion_attempt_exposes_bounded_stage_status_and_timing(self):
        body = body_json(stage="github_verification", retry_after_secs=45)
        harness = PublisherLoopHarness([lambda: exhausted_503(retry_after=45, body=body)])
        with self.assertRaises(urllib.error.HTTPError):
            harness.run()
        lines = harness.lines()
        # One bounded line per attempt: no masked silence, and the final line
        # carries what the provider told us but no next-wait (nothing follows).
        self.assertEqual(len(lines), promote.PUBLISH_ATTEMPTS)
        for attempt, line in enumerate(lines, start=1):
            self.assertEqual(line["publication_http"], 503)
            self.assertEqual(line["publication_attempt"], attempt)
            self.assertEqual(line["publication_stage"], "github_verification")
            self.assertEqual(line["retry_after_secs"], 45)
            if attempt < promote.PUBLISH_ATTEMPTS:
                self.assertLessEqual(line["next_wait_secs"], 120)
            else:
                self.assertNotIn("next_wait_secs", line)
        self.assertNotIn(TOKEN, harness.stdout.getvalue())

    def test_unknown_stage_values_are_never_echoed(self):
        harness = PublisherLoopHarness([lambda: exhausted_503(body=body_json(stage="attacker://probe"))])
        with self.assertRaises(urllib.error.HTTPError):
            harness.run()
        for line in harness.lines():
            self.assertNotIn("publication_stage", line)


class PublicationRecoveryTests(unittest.TestCase):
    def test_transient_failure_then_success_publishes_and_reports_both(self):
        harness = PublisherLoopHarness([
            exhausted_503(retry_after=20, body=body_json(stage="manifest_fetch", retry_after_secs=20)),
            FakeResponse(200, json.dumps({"published": "main", "commit": "a" * 40})),
        ])
        harness.run()
        self.assertEqual(harness.calls, 2)
        self.assertEqual(harness.sleeps, [20])
        lines = harness.lines()
        self.assertEqual(lines[0]["publication_http"], 503)
        self.assertEqual(lines[0]["publication_stage"], "manifest_fetch")
        self.assertEqual(lines[-1]["publication_http"], 200)
        self.assertIn("published", lines[-1]["detail"])

    def test_semantic_rejection_fails_fast_without_retry_or_sleep(self):
        harness = PublisherLoopHarness([lambda: body_error(400, json.dumps({"error": "unverified ci.yml build"}))])
        with self.assertRaises(urllib.error.HTTPError):
            harness.run()
        self.assertEqual(harness.calls, 1)
        self.assertEqual(harness.sleeps, [])
        self.assertEqual(len(harness.lines()), 1)

    def test_the_job_token_never_reaches_publication_diagnostics(self):
        harness = PublisherLoopHarness([lambda: body_error(400, json.dumps({"error": f"rejected {TOKEN}"}))])
        with self.assertRaises(urllib.error.HTTPError):
            harness.run()
        self.assertNotIn(TOKEN, harness.stdout.getvalue())
        self.assertIn("[redacted]", harness.stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
