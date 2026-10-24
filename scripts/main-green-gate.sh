#!/usr/bin/env bash
# scripts/main-green-gate.sh — the destination-green stop-the-line gate (BR#3008).
#
# Merges must not land while the destination branch is red. Before this gate,
# that rule (accepted decision BR#3009, "destination-green precondition") was
# checked by hand; the 2026-10-24 bridge pileup happened because nothing
# mechanical stopped it. This script is the merge-time half of the fix: the
# required `main-green gate` check on every PR refuses to pass while the
# latest check-run state on main's HEAD commit has any failure.
#
# Decision rule:
#   - Resolve main's HEAD commit sha (live tip; MAIN_GREEN_SHA overrides for
#     drills/tests only — CI never sets it).
#   - List the check runs on that commit
#     (`gh api repos/<repo>/commits/<sha>/check-runs` — the reference
#     implementation named in BR#3009).
#   - Per check NAME, the newest non-cancelled run is the judge (a cancelled
#     run says nothing — the same rule the deploy-health gate uses, PR #2275):
#       conclusion null                -> UNSETTLED (checks still running)
#       failure/timed_out/action_required/startup_failure -> RED
#       success/skipped/neutral        -> green
#   - Any UNSETTLED name fails the gate: an in-flight main does not vouch for
#     main. Green is a claim you can only make once the checks are settled.
#   - Zero check runs on main's HEAD also fails (the vacuity guard — a gate
#     that cannot see main's checks must not report main healthy).
#
# Remediation carve-out (BR#3009's remediation-merge path): if EVERY red
# check on main is green on the PR's own head (the PR fixes exactly what main
# fails), the gate passes with an explicit carve-out receipt — the alert is
# still filed by the hub sweep, and the merge commit's checks must come back
# green or the line stays stopped. MAIN_GREEN_PR_SHA supplies the PR head
# (CI sets it from the pull_request event).
#
# Exit codes: 0 = main green (or full remediation carve-out); 1 = everything
# else, loudly. Any API error fails the gate — never a vacuous pass.
#
# Wired as the required check `main-green gate` in
# .github/workflows/main-green-gate.yml (ruleset "main: main-green gate
# required"). Guarded by scripts/tests/main-green-gate.test.sh.
set -euo pipefail

REPO="${MAIN_GREEN_REPO:-state-vector/bridge}"
RED_CONCLUSIONS="failure timed_out action_required startup_failure"

sha="${MAIN_GREEN_SHA:-}"
if [ -z "${sha}" ]; then
  sha="$(gh api "repos/${REPO}/commits/main" --jq .sha)" || {
    echo "FAIL: gh api could not resolve main's HEAD on ${REPO} — the gate fails rather than pass blind (BR#3009)."
    exit 1
  }
fi

runs_json="$(gh api "repos/${REPO}/commits/${sha}/check-runs?per_page=100")" || {
  echo "FAIL: gh api could not list check runs on ${REPO}@${sha} — the gate fails rather than pass blind (BR#3009)."
  exit 1
}

# Per check name: the newest non-cancelled run judges; cancelled runs are
# skipped (they say nothing). Output TSV: name <tab> judge-conclusion <tab>
# judge-run-url, one line per name. An empty judge column with a `pending`
# marker means the newest non-cancelled run has not finished (unsettled).
classifications="$(printf '%s' "${runs_json}" | jq -r '
  [.check_runs[]]
  | if length == 0 then empty
    else
      group_by(.name)[]
      | map(select(.conclusion != "cancelled"))
      | sort_by(-.id)
      | .[0]
      | [.name, (.conclusion // "pending"), (.html_url // "")]
      | @tsv
    end')"
if [ -z "${classifications}" ]; then
  echo "FAIL: no check runs at all on ${REPO}@${sha} — a gate that cannot see"
  echo "      main's checks must not report main healthy (BR#3009 vacuity guard)."
  exit 1
fi

red_names=()
red_urls=()
unsettled=()
green_count=0
while IFS=$'\t' read -r name conclusion url; do
  [ -z "${name}" ] && continue
  case "${conclusion}" in
    pending)
      unsettled+=("${name}")
      ;;
    success|skipped|neutral)
      green_count=$((green_count + 1))
      ;;
    *)
      is_red=0
      for rc in ${RED_CONCLUSIONS}; do
        [ "${conclusion}" = "${rc}" ] && is_red=1 && break
      done
      if [ "${is_red}" = "1" ]; then
        red_names+=("${name}")
        red_urls+=("${url}")
      else
        # unknown conclusion — not provably green, so not provably safe
        unsettled+=("${name} (unknown conclusion: ${conclusion})")
      fi
      ;;
  esac
done <<< "${classifications}"

echo "main-green gate: destination main @ ${sha:0:9} on ${REPO}"
echo "  settled-green checks: ${green_count}"

if [ "${#red_names[@]}" -eq 0 ] && [ "${#unsettled[@]}" -eq 0 ]; then
  echo "GREEN — every check on main's HEAD is settled green; the destination is mergeable (BR#3009)."
  exit 0
fi

# ---------- remediation carve-out (BR#3009 remediation-merge path) ----------
if [ "${#red_names[@]}" -gt 0 ] && [ -n "${MAIN_GREEN_PR_SHA:-}" ]; then
  pr_runs_json="$(gh api "repos/${REPO}/commits/${MAIN_GREEN_PR_SHA}/check-runs?per_page=100")" || \
    pr_runs_json=""
  remediated=()
  unremediated=()
  for i in "${!red_names[@]}"; do
    name="${red_names[$i]}"
    pr_ok_url="$(printf '%s' "${pr_runs_json}" | jq -r --arg n "${name}" '
      [.check_runs[] | select(.name == $n and .conclusion != "cancelled")]
      | sort_by(-.id) | .[0]
      | if . == null then empty
        elif .conclusion == "success" then .html_url
        else empty end' 2>/dev/null || true)"
    if [ -n "${pr_ok_url}" ]; then
      remediated+=("${name} — PR head green: ${pr_ok_url}")
    else
      unremediated+=("${name}")
    fi
  done
  if [ "${#unremediated[@]}" -eq 0 ]; then
    echo "REMEDIATION CARVE-OUT (BR#3009): main is red but this PR is green on every red check —"
    echo "  this is the remediation-merge path. The stop-the-line alert is still filed;"
    echo "  the merge commit's checks must come back green or the line stays stopped."
    printf '  %s\n' "${remediated[@]}"
    echo "  red on main (for the record):"
    for i in "${!red_names[@]}"; do
      echo "    - ${red_names[$i]} ${red_urls[$i]}"
    done
    exit 0
  fi
  echo "  carve-out checked but incomplete — not green on the PR head:"
  printf '    - %s\n' "${unremediated[@]}"
fi

if [ "${#red_names[@]}" -gt 0 ]; then
  echo "RED — main's HEAD has failing checks. STOP THE LINE (BR#3009): merging onto red main is"
  echo "  mechanically blocked; merges halt until main is green."
  echo "  red checks on ${sha:0:9}:"
  for i in "${!red_names[@]}"; do
    echo "    - ${red_names[$i]} ${red_urls[$i]}"
  done
  echo "  Fix main (or land the remediation PR green on the exact failing checks) before merging."
fi

if [ "${#unsettled[@]}" -gt 0 ]; then
  echo "UNSETTLED — checks on main's HEAD are still running (or inconclusive):"
  printf '    - %s\n' "${unsettled[@]}"
  echo "  An in-flight main does not vouch for main: the gate refuses until checks settle."
fi
exit 1
