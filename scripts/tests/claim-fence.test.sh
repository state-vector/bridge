#!/usr/bin/env bash
# scripts/tests/claim-fence.test.sh — guards for scripts/check-claim-fence.sh
# (BR#19572: the repo-side one-executor rule, enforced at the direct-main
# push).
#
# Every decision row of the fence's contract gets one case:
#   - in_progress + mismatched identity -> REFUSED (exit 1), message names
#     the holder AND the sanctioned takeover path;
#   - in_progress + identity == holder  -> verified pass;
#   - in_progress + empty identity (human shell) -> WARN + pass — the human
#     plane keeps its authority, never a refusal;
#   - todo / in_review / unknown-status  -> pass, no active claim to fence;
#   - unreachable hub (curl exit 7) / rejected read (curl exit 22, e.g. 401)
#     -> WARN + pass (fail-open: the hub can never freeze all direct-main
#     landings);
#   - branch without a BR card id -> skip + pass;
#   - the bearer credential is actually sent on the read (stub records it);
#   - push-main.sh wires the fence BEFORE the preflight push to origin (a
#     refusal precedes any origin mutation).
#
# Runs the REAL fence against a stub `curl` on PATH — no network, no real
# token (a temp file carries a dummy value via BRIDGE_HUB_TOKEN_FILE).
#
# Usage: bash scripts/tests/claim-fence.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/check-claim-fence.sh"
PUSH_MAIN="${REPO_ROOT}/scripts/push-main.sh"

SHIM_DIR="$(mktemp -d)"
STATE_DIR="${SHIM_DIR}/state"
TOKEN_FILE="${SHIM_DIR}/token"
trap 'rm -rf "${SHIM_DIR}"' EXIT
mkdir -p "${STATE_DIR}"
echo "dummy-gateway-token" > "${TOKEN_FILE}"

cat > "${SHIM_DIR}/curl" <<'EOF'
#!/usr/bin/env bash
# stub curl: records its args, prints FAKE_CURL_BODY, exits FAKE_CURL_EXIT.
printf '%s\n' "$*" > "${FAKE_STATE_DIR}/last_curl_args"
[ -n "${FAKE_CURL_BODY+x}" ] && printf '%s' "${FAKE_CURL_BODY}"
exit "${FAKE_CURL_EXIT:-0}"
EOF
chmod +x "${SHIM_DIR}/curl"

TESTS=0
FAILURES=0
OUT=""
RC=0

ok() {
  TESTS=$((TESTS + 1))
  echo "  ok   — $1"
}
notok() {
  TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1))
  echo "  FAIL — $1"
  [ -n "${2:-}" ] && echo "         $2"
  return 0
}

# run <branch> — executes the real fence with stubbed curl; the response is
# set per-case via FAKE_CURL_* and the identity via FENCE_IDENTITY (empty
# string means explicitly unset, the human-shell case).
run() {
  local branch="$1"
  rm -rf "${STATE_DIR}"; mkdir -p "${STATE_DIR}"
  local identity_env=()
  if [ -n "${FENCE_IDENTITY+x}" ] && [ -n "${FENCE_IDENTITY}" ]; then
    identity_env=("BRIDGE_EXECUTOR_SESSION=${FENCE_IDENTITY}")
  fi
  OUT=$(env PATH="${SHIM_DIR}:${PATH}" \
    "BRIDGE_HUB_URL=https://hub.test" \
    "BRIDGE_HUB_TOKEN_FILE=${TOKEN_FILE}" \
    "FAKE_STATE_DIR=${STATE_DIR}" \
    "${identity_env[@]}" \
    env -u BRIDGE_SESSION \
    bash "${SCRIPT}" "${branch}" 2>&1)
  RC=$?
}

expect_rc() {
  local want="$1" label="$2"
  if [ "${RC}" -eq "${want}" ]; then ok "${label} (exit ${RC})"
  else notok "${label}" "expected exit ${want}, got ${RC}: ${OUT}"; fi
}
expect_grep() {
  local pattern="$1" label="$2"
  if echo "${OUT}" | grep -qi -- "${pattern}"; then ok "${label}"
  else notok "${label}" "expected output to match: ${pattern}"; fi
}
expect_nogrep() {
  local pattern="$1" label="$2"
  if echo "${OUT}" | grep -qi -- "${pattern}"; then
    notok "${label}" "did not expect: ${pattern}"
  else ok "${label}"; fi
}

card_json() { # card_json <status> <session>
  printf '{"id":"BR#12345","type":"task","status":"%s","meta":{"session":"%s"}}' "$1" "$2"
}

echo "claim fence: scripts/check-claim-fence.sh"

# 1. THE INCIDENT CLASS — another live session holds the card: REFUSE.
FENCE_IDENTITY="dispatch-BR-12345-aaaaaa"
export FENCE_IDENTITY
FAKE_CURL_BODY="$(card_json in_progress dispatch-BR-12345-bbbbbb)" FAKE_CURL_EXIT=0 run "bridge/BR-12345"
expect_rc  1 "in_progress under a different session refuses the push"
expect_grep "dispatch-BR-12345-bbbbbb" "refusal names the current holder"
expect_grep "claim.takeover" "refusal names the sanctioned takeover path"
expect_grep "BR#12345" "refusal names the card"
expect_nogrep "::warning::" "a refusal is not a warning"

# 2. Holder pushes: verified pass.
FAKE_CURL_BODY="$(card_json in_progress dispatch-BR-12345-aaaaaa)" FAKE_CURL_EXIT=0 run "bridge/BR-12345"
expect_rc  0 "the holder's own push passes"
expect_grep "verified" "holder pass is marked verified"

# 3. Human shell (no env identity): WARN + pass, never a refusal.
FENCE_IDENTITY=""
export FENCE_IDENTITY
FAKE_CURL_BODY="$(card_json in_progress dispatch-BR-12345-bbbbbb)" FAKE_CURL_EXIT=0 run "bridge/BR-12345"
expect_rc  0 "a human shell (no env identity) passes"
expect_grep "UNVERIFIED" "the human path warns loudly"
expect_grep "dispatch-BR-12345-bbbbbb" "the warning names the holder"

# 4. Non-in_progress statuses: no active claim to fence.
for status in todo in_review blocked; do
  FAKE_CURL_BODY="$(card_json "$status" dispatch-BR-12345-bbbbbb)" FAKE_CURL_EXIT=0 run "bridge/BR-12345"
  expect_rc  0 "a ${status} card has no active claim to fence"
  expect_grep "no active claim" "${status} pass says so"
done

# 5. Unreachable hub (curl exit 7): fail-open.
FENCE_IDENTITY="dispatch-BR-12345-aaaaaa"
export FENCE_IDENTITY
FAKE_CURL_BODY="" FAKE_CURL_EXIT=7 run "bridge/BR-12345"
expect_rc  0 "an unreachable hub fails open"
expect_grep "unverified" "hub outage warns"

# 6. Rejected read (curl -f exit 22 — e.g. 401): fail-open.
FAKE_CURL_BODY="" FAKE_CURL_EXIT=22 run "bridge/BR-12345"
expect_rc  0 "a rejected read (401) fails open"
expect_grep "unverified" "auth failure warns"

# 7. Malformed / error payload: no status — fail-open pass.
FAKE_CURL_BODY='{"error":"no such card"}' FAKE_CURL_EXIT=0 run "bridge/BR-12345"
expect_rc  0 "an error payload passes as no active claim"

# 8. No BR card on the branch: skip entirely.
FAKE_CURL_BODY="{}" FAKE_CURL_EXIT=0 run "feature/some-refactor"
expect_rc  0 "a branch without a BR card id skips the fence"
expect_grep "nothing to fence" "the skip says so"

# 9. The bearer credential actually rode the read (stub-recorded args).
FAKE_CURL_BODY="$(card_json in_progress dispatch-BR-12345-aaaaaa)" FAKE_CURL_EXIT=0 run "bridge/BR-12345"
if grep -q -- "Authorization: Bearer dummy-gateway-token" "${STATE_DIR}/last_curl_args" \
  && grep -q -- "id=BR%2312345" "${STATE_DIR}/last_curl_args"; then
  ok "the read carries the bearer token and the URL-encoded card id"
else
  notok "the read carries the bearer token and the URL-encoded card id" \
    "stub saw: $(cat "${STATE_DIR}/last_curl_args" 2>/dev/null)"
fi

# 10. Missing credential file: fail-open (humans without a machine token).
BRIDGE_HUB_TOKEN_FILE_ALT="${SHIM_DIR}/absent-token" FAKE_CURL_BODY="never-read" FAKE_CURL_EXIT=0 \
  env PATH="${SHIM_DIR}:${PATH}" BRIDGE_HUB_URL=https://hub.test \
  BRIDGE_HUB_TOKEN_FILE="${SHIM_DIR}/absent-token" FAKE_STATE_DIR="${STATE_DIR}" \
  bash "${SCRIPT}" "bridge/BR-12345" > /dev/null 2>&1 && RC=$? || RC=$?
if [ "${RC}" -eq 0 ]; then ok "a missing credential file fails open (exit 0)"
else notok "a missing credential file fails open (exit 0)" "got exit ${RC}"; fi

# 11. Wiring: push-main.sh must run the fence BEFORE the preflight push.
fence_line=$(grep -nF 'check-claim-fence.sh' "${PUSH_MAIN}" | head -1 | cut -d: -f1)
push_line=$(grep -nF 'git push origin "$candidate:$ref"' "${PUSH_MAIN}" | head -1 | cut -d: -f1)
if [ -n "${fence_line}" ] && [ -n "${push_line}" ] \
  && [ "${fence_line}" -lt "${push_line}" ]; then
  ok "push-main.sh fences (line ${fence_line}) before the preflight push (line ${push_line})"
else
  notok "push-main.sh fences before the preflight push" \
    "fence at '${fence_line:-absent}', preflight push at '${push_line:-absent}'"
fi

# 12. Syntax gates: both scripts parse.
if bash -n "${SCRIPT}" 2>/dev/null && bash -n "${PUSH_MAIN}" 2>/dev/null; then
  ok "both scripts parse (bash -n)"
else
  notok "both scripts parse (bash -n)"
fi

echo
if [ "${FAILURES}" -eq 0 ]; then
  echo "claim fence: all ${TESTS} checks passed"
  exit 0
fi
echo "claim fence: ${FAILURES}/${TESTS} checks FAILED"
exit 1