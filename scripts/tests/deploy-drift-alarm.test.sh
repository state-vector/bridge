#!/usr/bin/env bash
# scripts/tests/deploy-drift-alarm.test.sh — guards for
# scripts/deploy-drift-alarm.sh (BR#3289: the deploy-drift settle window).
#
# The alarm is only as good as its DECISION RULE, so every case below pins
# one clause of it:
#   - hub at the pushed SHA                    -> green fast, no warn;
#   - hub stale, then catching up WITHIN the window -> green with a
#     non-failing settling warn and NO error — the BR#3289 false-red class;
#   - hub reaching a NEWER main tip containing the push -> green (superseded
#     push is not drift: "deployed ≠ tip" is);
#   - hub stale through the whole window       -> RED with ::error:: — real
#     drift still fails loudly (the hard behavior is kept);
#   - hub unreachable through the whole window -> RED ("unreachable");
#   - a failing main-tip lookup never turns a mismatch green (fail-closed);
#   - missing required env fails loudly.
#
# Runs the REAL script against stub `curl` + `gh` on PATH (scripts/tests/
# fake-drift-curl, fake-drift-gh), windows compressed to ~1s via
# SETTLE_WINDOW_SECONDS / POLL_INTERVAL_SECONDS — no network, no token,
# credential-free by construction.
#
# Usage: bash scripts/tests/deploy-drift-alarm.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/deploy-drift-alarm.sh"

SHIM_DIR="$(mktemp -d)"
STATE_DIR="$(mktemp -d)"
trap 'rm -rf "${SHIM_DIR}" "${STATE_DIR}"' EXIT
cp "${HERE}/fake-drift-curl" "${SHIM_DIR}/curl"
cp "${HERE}/fake-drift-gh" "${SHIM_DIR}/gh"
chmod +x "${SHIM_DIR}/curl" "${SHIM_DIR}/gh"

EXPECTED="expected0000000000000000000000000000000000a"
OLD="oldsha000000000000000000000000000000000000000b"
TIP="tipsha000000000000000000000000000000000000000c"

TESTS=0
FAILURES=0
OUT=""
RC=0

ok()   { TESTS=$((TESTS + 1)); echo "  ok   — $1"; }
notok() {
  TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1))
  echo "  FAIL — $1"
  [ -n "${2:-}" ] && echo "         $2"
  return 0
}

# run [env=k=v ...] — executes the alarm with a fresh hub-response sequence
# per run (the stub counter lives in STATE_DIR, reset each time).
run() {
  rm -rf "${STATE_DIR}"
  STATE_DIR="$(mktemp -d)"
  OUT=$(env "PATH=${SHIM_DIR}:${PATH}" "DRIFT_STUB_STATE=${STATE_DIR}" \
    "HUB_URL=https://hub.test" "EXPECTED_SHA=${EXPECTED}" \
    "SETTLE_WINDOW_SECONDS=1" "POLL_INTERVAL_SECONDS=0" "$@" \
    bash "${SCRIPT}" 2>&1)
  RC=$?
}

expect_rc() {
  local want="$1" label="$2"
  if [ "${RC}" -eq "${want}" ]; then ok "${label} (exit ${RC})"
  else notok "${label}" "expected exit ${want}, got ${RC}"; fi
}

expect_grep() {
  local pattern="$1" label="$2"
  if echo "${OUT}" | grep -q "${pattern}"; then ok "${label}"
  else notok "${label}" "expected output to match: ${pattern}"; fi
}

expect_nogrep() {
  local pattern="$1" label="$2"
  if echo "${OUT}" | grep -q "${pattern}"; then notok "${label}" "did not expect: ${pattern}"
  else ok "${label}"; fi
}

echo "# deploy drift alarm — settle window (BR#3289)"

run FAKE_HUB_RESPONSES="${EXPECTED}" FAKE_TIP_SHA="${OLD}"
expect_rc 0 "hub at the pushed SHA passes on the first probe (fast path)"
expect_grep "live hub matches the pushed SHA" "green receipt names the match"
expect_nogrep "::warning::" "fast-path green emits no settling warn"
expect_nogrep "::error::" "fast-path green emits no error"

# within-window green cases use a 30s window: green exits as soon as the
# probe sequence reaches it, so the window only needs to be comfortably
# longer than 3 stub calls — the ~1s default window is reserved for the
# failure cases that must actually elapse it.
run FAKE_HUB_RESPONSES="${OLD}:${OLD}:${EXPECTED}" FAKE_TIP_SHA="${TIP}" SETTLE_WINDOW_SECONDS=30
expect_rc 0 "hub stale then catching up WITHIN the window is green (the BR#3289 false-red class)"
expect_grep "::warning::" "the in-flight deploy is a non-failing settling warn"
expect_grep "live hub matches the pushed SHA" "green receipt names the match"
expect_nogrep "::error::" "settling never fails the check"

run FAKE_HUB_RESPONSES="${OLD}:${TIP}" FAKE_TIP_SHA="${TIP}" SETTLE_WINDOW_SECONDS=30
expect_rc 0 "hub reaching a NEWER main tip containing the push is green (superseded push)"
expect_grep "newer push superseded" "green-by-tip is named as such"
expect_nogrep "::error::" "superseded push is not drift"

run FAKE_HUB_RESPONSES="${OLD}" FAKE_TIP_SHA="${TIP}"
expect_rc 1 "hub stale through the whole window fails loudly (real drift, hard behavior kept)"
expect_grep "::error::" "the verdict is a failing error annotation"
expect_grep "deploy drift" "the verdict names deploy drift"
expect_grep "oldsha000" "the verdict names the stale live build"
expect_grep "tipsha000" "the verdict names main's tip for comparison"
expect_nogrep "live hub matches" "no green receipt on a drift verdict"

run FAKE_HUB_RESPONSES="unreachable" FAKE_TIP_SHA="${TIP}"
expect_rc 1 "hub unreachable through the whole window fails loudly"
expect_grep "::error::" "the verdict is a failing error annotation"
expect_grep "unreachable for the whole" "the verdict names the unreachable hub"

run FAKE_HUB_RESPONSES="${OLD}:${EXPECTED}" FAKE_TIP_SHA="" SETTLE_WINDOW_SECONDS=30
expect_rc 0 "a failing tip lookup does not block green-by-pushed-SHA"

run FAKE_HUB_RESPONSES="${OLD}" FAKE_TIP_SHA=""
expect_rc 1 "a failing tip lookup never turns a mismatch green (fail-closed)"
expect_grep "deploy drift" "fail-closed still names the defect"
expect_grep "superseded-push path could not be proven" "fail-closed explains the missing tip"

echo "# config guards"

run FAKE_HUB_RESPONSES="${EXPECTED}" FAKE_TIP_SHA="${OLD}" EXPECTED_SHA=""
expect_rc 1 "missing EXPECTED_SHA fails loudly"
expect_grep "EXPECTED_SHA is required" "the missing config is named"

run FAKE_HUB_RESPONSES="${EXPECTED}" FAKE_TIP_SHA="${OLD}" HUB_URL=""
expect_rc 1 "missing HUB_URL fails loudly"
expect_grep "HUB_URL is required" "the missing config is named"

echo
echo "${TESTS} tests, ${FAILURES} failures"
[ "${FAILURES}" -eq 0 ]
