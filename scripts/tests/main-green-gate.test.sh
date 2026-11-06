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
#   - the gate's own run (GITHUB_RUN_ID match on html_url/details_url) is
#     excluded BEFORE the judge — the self-referential class BR#5487 found,
#     fixed in the shared script so every repo inherits it (BR#5518); a run
#     from a DIFFERENT run id still judges, and excluding the only run still
#     trips the vacuity guard;
#   - unset MAIN_GREEN_REPO fails loudly — the shared definition must be told
#     which destination it vouches for (BR#5518); and
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

# run_no_repo <scenario> [env...] — same as run(), but MAIN_GREEN_REPO is
# explicitly UNSET: the shared definition (BR#5518) must refuse to judge a
# destination it was never told. One env var, no default, fail loudly.
run_no_repo() {
  local scenario="$1"; shift
  OUT=$(env -u MAIN_GREEN_REPO "PATH=${SHIM_DIR}:${PATH}" "DHG_SCENARIO=${scenario}" "$@" \
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

echo "# own-run exclusion (BR#5518 — the gate never counts itself into the verdict)"

# Every own-run scenario puts the gate's own run (id 555, html_url carrying
# the test's GITHUB_RUN_ID=424242) on main's HEAD — the self-referential
# class BR#5487 found. The shared script drops it BEFORE the judge, so the
# verdict is decided by the remaining checks.

run own-run-pending MAIN_GREEN_SHA=ownruns0ha GITHUB_RUN_ID=424242
expect_rc 0 "own in-flight run on the judged sha is excluded — the gate passes"
expect_nogrep "UNSETTLED" "own pending run does not unsettle the gate"

run own-run-pending MAIN_GREEN_SHA=ownruns0ha GITHUB_RUN_ID=999999
expect_rc 1 "a pending run that is NOT this run's own still unsettles the gate"
expect_grep "UNSETTLED" "non-own pending run is judged"

run own-run-red MAIN_GREEN_SHA=ownruns0ha GITHUB_RUN_ID=424242
expect_rc 0 "own FAILED run on the judged sha is excluded — no self-inflicted red"

run own-run-name-red-other-id MAIN_GREEN_SHA=ownruns0ha GITHUB_RUN_ID=424242
expect_rc 1 "a FAILED gate-named run from a DIFFERENT run id still judges (name match is not enough)"
expect_grep "https://example/run/stale/gate" "the stale failed gate run is named with its URL"

run own-run-only MAIN_GREEN_SHA=ownruns0ha GITHUB_RUN_ID=424242
expect_rc 1 "excluding the own run leaves zero checks — the vacuity guard still fires"
expect_grep "no check runs at all" "vacuity guard message printed"

echo "# carve-out never self-vouches (BR#5518 — the PR leg applies the same exclusion)"

run carve-out-self-vouch MAIN_GREEN_SHA=selfv1sha MAIN_GREEN_PR_SHA=prheadbb2 GITHUB_RUN_ID=424242
expect_rc 1 "main red on 'main-green gate' + the PR head's own green gate run excluded — carve-out refuses self-vouching"
expect_grep "carve-out checked but incomplete" "the refusal names the missing remediation"

echo "# no-repo honesty (BR#5518 — the shared definition must be told its destination)"

run_no_repo green
expect_rc 1 "unset MAIN_GREEN_REPO fails loudly — the gate has no repo default"
expect_grep "MAIN_GREEN_REPO is required" "the refusal names the missing input"

echo
echo "${TESTS} tests, ${FAILURES} failures"
[ "${FAILURES}" -eq 0 ]
