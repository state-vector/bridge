#!/usr/bin/env bash
# scripts/deploy-drift-alarm.sh — the "Deploy drift alarm" CI check
# (BR#2843 version marker + BR#3289 settle window).
#
# Compares the live hub's __version commit against the pushed SHA on every
# main push. The hub deploys asynchronously (git push → CF Workers Builds),
# so an alarm that failed on the first stale probe read "main is broken" on
# EVERY push (BR#3289: 6+ false reds in 24h, and each red also tripped the
# main-green gate on the next PR). The alarm now settles first:
#
# Decision rule (per probe, inside the settle window):
#   - LIVE == EXPECTED_SHA        -> GREEN, exit 0 (fast path — deploy landed).
#   - LIVE == main tip            -> GREEN, exit 0 — a newer main push
#     superseded this SHA's deploy; the tip contains this push, so the changes
#     are live. Drift is "deployed hub ≠ main tip" by definition (BR#3289),
#     and tip == live is the opposite of drift.
#   - anything else — an older build, or the hub unreachable — -> SETTLING:
#     non-failing ::warning:: annotations, keep polling.
#
# Window elapses with no green (the LAST probe is the verdict):
#   - hub answered but never matched -> ::error:: deploy drift, exit 1. Real
#     drift (CF Builds stalled or bypassed) — fails loudly, feeds the
#     main-green gate and stopTheLineSweep, exactly as before.
#   - hub never answered             -> ::error:: unreachable, exit 1
#     (a stalled deploy or a broken route is real drift too).
#
# Fail-closed: a failed tip lookup never turns a mismatch green — without the
# tip, the superseded-push path cannot be proven, so a stale hub at window
# end still fails. Any probe/tip error inside the window is a warn-and-retry,
# never an early verdict.
#
# Env (CI sets the first three; the knobs exist so tests can compress time):
#   HUB_URL                 live hub base URL (required)
#   EXPECTED_SHA            the pushed commit this run vouches for (required)
#   DEPLOY_DRIFT_REPO       repo for the main-tip lookup (default state-vector/bridge)
#   SETTLE_WINDOW_SECONDS   how long a stale hub is "settling" (default 600; 0 = old fail-fast behavior)
#   POLL_INTERVAL_SECONDS   sleep between probes (default 60)
#
# Guarded by scripts/tests/deploy-drift-alarm.test.sh
# (npm run test:deploy-drift-alarm) — stub curl + gh on PATH, windows
# compressed to ~1s.
set -euo pipefail

: "${HUB_URL:?HUB_URL is required — the live hub base URL}"
: "${EXPECTED_SHA:?EXPECTED_SHA is required — the pushed commit this run vouches for}"

REPO="${DEPLOY_DRIFT_REPO:-state-vector/bridge}"
WINDOW="${SETTLE_WINDOW_SECONDS:-600}"
POLL="${POLL_INTERVAL_SECONDS:-60}"

short() { printf '%.9s' "${1:-?}"; }

probe() {
  # -f: a 4xx/5xx from the hub is no answer, same as a refused connection.
  curl -sf --max-time 15 "$HUB_URL/__version" 2>/dev/null \
    | jq -r '.commit // empty' 2>/dev/null || true
}

tip() {
  gh api "repos/${REPO}/commits/main" --jq .sha 2>/dev/null || true
}

deadline=$(( $(date +%s) + WINDOW ))
live=""
tip_sha=""
last_warned=""
poll=0

while :; do
  live="$(probe)"
  tip_sha="$(tip)"

  if [ -n "$live" ] && [ "$live" = "$EXPECTED_SHA" ]; then
    echo "live hub matches the pushed SHA $(short "$live") ✓"
    exit 0
  fi
  # Green-by-tip: the hub runs a newer main tip that contains this push.
  # Only when the tip lookup SUCCEEDED — a failed lookup must not green a
  # stale hub (fail-closed).
  if [ -n "$live" ] && [ -n "$tip_sha" ] && [ "$live" = "$tip_sha" ] && [ "$tip_sha" != "$EXPECTED_SHA" ]; then
    echo "live hub is at main's tip $(short "$live") — a newer push superseded this SHA's deploy;"
    echo "the tip contains this push $(short "$EXPECTED_SHA"), so the changes are live (drift is deployed ≠ tip)."
    exit 0
  fi

  poll=$((poll + 1))
  now="$(date +%s)"
  if [ "$now" -ge "$deadline" ]; then
    break
  fi

  observed="${live:-unreachable}"
  # Throttled warn: first poll, whenever the observed version changes, and
  # every 20th poll. ::warning:: annotates the check without failing it —
  # a settling main is not a broken main.
  if [ "$poll" -eq 1 ] || [ "$observed" != "$last_warned" ] || [ $((poll % 20)) -eq 0 ]; then
    echo "::warning::SETTLING — live hub is ${observed}, expected $(short "$EXPECTED_SHA"); deploy in flight — fails if not settled within the ${WINDOW}s window"
    last_warned="$observed"
  else
    echo "settling (poll ${poll}) — live hub still ${observed}, expected $(short "$EXPECTED_SHA")"
  fi
  sleep "$POLL"
done

# ---------- verdict: the window elapsed without a green probe ----------
if [ -n "$live" ]; then
  if [ -n "$tip_sha" ]; then
    echo "::error::deploy drift — the ${WINDOW}s settle window elapsed and the live hub still runs $(short "$live"): neither the pushed $(short "$EXPECTED_SHA") nor main's tip $(short "$tip_sha"). CF Builds stalled or bypassed?"
  else
    echo "::error::deploy drift — the ${WINDOW}s settle window elapsed and the live hub still runs $(short "$live"), not the pushed $(short "$EXPECTED_SHA") (main-tip lookup failed, so the superseded-push path could not be proven). CF Builds stalled or bypassed?"
  fi
  echo "  This is real drift: the deployed hub is not main. Fails the run and feeds the main-green gate + stopTheLineSweep."
  exit 1
fi

echo "::error::__version unreachable for the whole ${WINDOW}s settle window — the deploy may have stalled or the route broke"
exit 1
