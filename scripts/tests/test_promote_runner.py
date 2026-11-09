import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch
from urllib.error import HTTPError


SCRIPT = Path(__file__).resolve().parents[1] / "promote-runner.py"
SHA = "a" * 40
RUNS = [
    {"id": number, "path": f".github/workflows/{workflow}", "conclusion": "success",
     "status": "completed", "event": "push", "head_branch": "main"}
    for number, workflow in [(10, "ci.yml"), (11, "dev-build.yml")]
]


def response_error(code, body, headers=None):
    return HTTPError("https://hub.fleetbridge.run/api/runner-updates/publish",
                     code, "response error", headers or {},
                     io.BytesIO(json.dumps(body).encode()))


class SuccessResponse(io.BytesIO):
    status = 200


class PromoteRunnerTests(unittest.TestCase):
    def exercise(self, effects):
        output = io.StringIO()
        failure = None
        with (patch.dict(os.environ, {"TRIGGER_SHA": SHA, "GH_TOKEN": "job-token"}),
              patch("subprocess.check_output", return_value=json.dumps({"workflow_runs": RUNS})),
              patch("urllib.request.urlopen", side_effect=effects) as opener,
              patch("time.time", return_value=1794212400),
              patch("time.sleep") as sleep,
              contextlib.redirect_stdout(output)):
            try:
                runpy.run_path(str(SCRIPT), run_name="__main__")
            except (HTTPError, RuntimeError) as error:
                failure = error
        return output.getvalue(), opener, sleep, failure

    def test_known_quota_exhaustion_beyond_budget_stops_after_one_call(self):
        failure = response_error(503, {"stage": "verify_ci", "upstream_status": 403,
                                       "rate_reset_at": 1794216000, "error": "private provider body"},
                                 {"Retry-After": "3600"})
        output, opener, sleep, result = self.exercise([failure] * 12)
        self.assertEqual(opener.call_count, 1)
        sleep.assert_not_called()
        self.assertIn("verify_ci", output)
        self.assertIn("403", output)
        self.assertIn("3600", output)
        self.assertIn("1794216000", output)
        self.assertIn("retry budget", str(result))
        self.assertNotIn("private provider body", output)
        self.assertNotIn("job-token", output)

    def test_retry_after_is_honored_when_recovery_fits_budget(self):
        failure = response_error(503, {"stage": "fetch_manifest", "upstream_status": 503},
                                 {"Retry-After": "35"})
        output, opener, sleep, result = self.exercise([failure, SuccessResponse(b'{"published":"main"}')])
        sleep.assert_called_once_with(35)
        self.assertEqual(opener.call_count, 2)
        self.assertIsNone(result)
        self.assertIn("fetch_manifest", output)
        self.assertIn("published", output)

    def test_unrecognized_failure_body_does_not_leak_and_uses_normal_backoff(self):
        failure = response_error(503, {"stage": "private provider body"})
        output, opener, sleep, result = self.exercise([failure, SuccessResponse(b'{"unchanged":true}')])
        sleep.assert_called_once_with(15)
        self.assertEqual(opener.call_count, 2)
        self.assertIsNone(result)
        self.assertNotIn("private provider body", output)
        self.assertIn("unchanged", output)


if __name__ == "__main__":
    unittest.main()
