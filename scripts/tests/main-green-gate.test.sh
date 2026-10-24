#!/usr/bin/env bash
# scripts/tests/main-green-gate.test.sh — guards for
# scripts/main-green-gate.sh (BR#3008: the destination-green stop-the-line).
#
# The gate is only as good as its DECISION RULE, so every case below pins one
# clause of it:
#   - all settled green on main's HEAD passes with a receipt (sha printed);
#   - the NEWEST run judges — an older red superseded by a newer green must
#     not block (and a cancelled newest run falls back to the previous one);
#   - any failure on main's HEAD fails the gate AND names the failing check
#     with its run URL — the check log must be actionable on its own;
#   - an in-flight (conclusion null) main fails the gate: an unsettled main
#     does not vouch for main;
#   - all-cancelled and zero-check-runs fail (the vacuity guard);
#   - the remediation carve-out passes ONLY when the PR head is green on
#     every red check, and fails when any red check is unremediated;
#   - a gh API error fails loudly.
#
# Runs the REAL script against a stub `gh` on PATH (scripts/tests/fake-gh-
# check-runs), so there is no network and no token. Credential-free by
# construction, which is why it belongs in the PR-blocking tier.
#
# Usage: bash scripts/tests/main-green-gate.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/main-green-gate.sh"

SHIM_DIR="$(mktemp -d)"
trap 'rm -rf "${SHIM_DIR}"' EXIT
cp "${HERE}/fake-gh-check-runs" "${SHIM_DIR}/gh"
chmod +x "${SHIM_DIR}/gh"

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

# run <scenario> [env...] — executes the gate with DHG_SCENARIO set for the stub.
run() {
  local scenario="$1"; shift
  OUT=$(env "PATH=${SHIM_DIR}:${PATH}" "DHG_SCENARIO=${scenario}" "$@" \
        MAIN_GREEN_REPO="state-vector/bridge" bash "${SCRIPT}" 2>&1)
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

echo "# main-green gate decision rule"

run green
expect_rc 0 "settled green main passes"
expect_grep "GREEN" "pass prints its verdict"
expect_grep "abc123def" "pass receipt names the judged sha"

run green
expect_nogrep "REMEDIATION" "no carve-out on a green main"

run red
expect_rc 1 "a failure on main's HEAD fails the gate"
expect_grep "RED — main's HEAD has failing checks" "red verdict is named"
expect_grep "Test https://example/run/red/Test" "failing check + run URL in the log"

run cancelled-supersede
expect_rc 1 "cancelled newest run falls back to the older failure (stop-the-line holds)"
expect_grep "Test https://example/run/old/Test" "the non-cancelled failure is named"

run unsettled
expect_rc 1 "in-flight main fails the gate (unsettled does not vouch)"
expect_grep "UNSETTLED" "unsettled verdict is named"
expect_grep "CLI build" "the unsettled check is named"

run all-cancelled
expect_rc 1 "all-cancelled main fails (inconclusive is not green)"

run empty
expect_rc 1 "zero check runs fails (vacuity guard)"
expect_grep "no check runs at all" "vacuity is explained"

run api-error
expect_rc 1 "gh API error fails loudly"
expect_grep "pass blind" "the fail-blind refusal is stated"

echo "# remediation carve-out (BR#3009 remediation-merge path)"

run carve-out-pass MAIN_GREEN_PR_SHA=prheadaa1
expect_rc 0 "PR green on the exact red check passes via the carve-out"
expect_grep "REMEDIATION CARVE-OUT" "carve-out is receipted in the log"
expect_grep "https://example/pr/Test" "carve-out names the PR-head green run"
expect_grep "fixme9sha" "main red sha stays on the record"

run carve-out-miss MAIN_GREEN_PR_SHA=prheadbb2
expect_rc 1 "PR not green on the red check does NOT pass"
expect_grep "carve-out checked but incomplete" "partial carve-out is explicit"

run carve-out-pass
expect_rc 1 "no PR sha = no carve-out (red main still fails)"

run red MAIN_GREEN_PR_SHA=prheadcc3
expect_rc 1 "carve-out against a non-carve-out scenario fails closed"

echo
echo "${TESTS} tests, ${FAILURES} failures"
[ "${FAILURES}" -eq 0 ]
