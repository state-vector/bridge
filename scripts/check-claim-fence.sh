#!/usr/bin/env bash
# scripts/check-claim-fence.sh — the repo-side half of the hub's
# one-executor-per-task rule (BR#19572). Claims live on the hub; this fence
# makes the claim mechanically BINDING at the direct-main push instead of a
# post-hoc audit. scripts/push-main.sh runs it BEFORE any push to origin, so
# a refusal costs nothing.
#
# Contract: exit 0 = the push may proceed (verified, warned, or skipped);
#           exit 1 = REFUSED — the branch's card is in_progress under a
#           different live session and this identity is not the holder.
# Fail-open by design: the ONLY refusal is in_progress + a set, mismatched
# identity. A hub blip, a missing credential, an unclaimed or review-state
# branch, or a human shell (no env identity) never freezes direct-main
# landings — the human plane keeps its authority (BR#6135/BR#6788).
#
# Identity: $BRIDGE_EXECUTOR_SESSION (set for EVERY dispatched runner by
# worker_session.rs --setenv) else $BRIDGE_SESSION (interactive agent
# convention; set it before pushing from a named agent session).
#
# Card read: GET $BRIDGE_HUB_URL/api/kb/artefact?id=BR%23<N> with the
# gateway bearer token (packages/worker/src/index.js accepts cookie|bearer
# on the /api/kb/* REST mirror). The token file exists on every runner host
# by construction; humans without one pass warned, never blocked.
#
# Usage: check-claim-fence.sh <branch-being-pushed>
set -euo pipefail

branch="${1:-}"
hub="${BRIDGE_HUB_URL:-https://hub.fleetbridge.run}"
token_file="${BRIDGE_HUB_TOKEN_FILE:-$HOME/.bridge/gateway-token}"
identity="${BRIDGE_EXECUTOR_SESSION:-${BRIDGE_SESSION:-}}"

say()  { printf 'claim fence: %s\n' "$*"; }
warn() { printf '::warning::claim fence: %s\n' "$*" >&2; }

# bridge/BR-<N> is the authoritative join key (packages/worker/src/kb/provenance.ts).
# Portable lowercase (macOS ships bash 3.2 without ${var,,}).
branch_lc=$(printf '%s' "$branch" | tr '[:upper:]' '[:lower:]')
card=""
if [[ "$branch_lc" =~ (^|[/._-])br[-_]?([0-9]{1,6})($|[/._-]) ]]; then
  card="BR#${BASH_REMATCH[2]}"
fi
if [[ -z "$card" ]]; then
  say "no BR card id on branch '${branch:-<none>}' — nothing to fence, proceed"
  exit 0
fi
card_url="${hub}/card/${card//#/-}"

# No credential: fail-open (loud). The hub's availability must never gate
# every direct-main push, and a human shell has no machine credential.
if [[ ! -r "$token_file" || ! -s "$token_file" ]]; then
  warn "no hub credential at ${token_file} — cannot verify the claim on ${card} (${card_url}); proceeding unverified"
  exit 0
fi

json=""
if ! json=$(curl -sf --max-time 15 \
    -H "Authorization: Bearer $(<"$token_file")" \
    "${hub}/api/kb/artefact?id=$(printf '%s' "$card" | sed 's/#/%23/')" 2>/dev/null); then
  warn "hub unreachable or rejected the read (${hub}) — cannot verify the claim on ${card} (${card_url}); proceeding unverified"
  exit 0
fi

status=$(jq -r '.status // "unknown"' <<<"$json" 2>/dev/null || echo "unknown")
holder=$(jq -r '.meta.session // empty' <<<"$json" 2>/dev/null || true)

if [[ "$status" != "in_progress" ]]; then
  say "card ${card} is ${status} — no active claim to fence, proceed (${card_url})"
  exit 0
fi
if [[ -z "$holder" ]]; then
  say "card ${card} is in_progress with no recorded holder — proceed (${card_url})"
  exit 0
fi
if [[ -z "$identity" ]]; then
  warn "card ${card} is in_progress under session '${holder}' (${card_url}) but this shell carries no BRIDGE_EXECUTOR_SESSION/BRIDGE_SESSION — proceeding UNVERIFIED; if this push was meant to replace the holder, take the claim over via the hub first"
  exit 0
fi
if [[ "$identity" == "$holder" ]]; then
  say "verified: ${card} is held by this session (${identity}); proceed (${card_url})"
  exit 0
fi

cat >&2 <<EOF
::error::claim fence REFUSED: ${card} is in_progress under session '${holder}' but this push identity is '${identity}'.
::error::Another executor owns the card — a second implementation landing now is the duplicate-executor class (BR#3348/BR#19572).
::error::Sanctioned paths: take the claim over via the hub (claim.takeover — owner/web/human anchored, BR#6135/BR#6788), or wait for the watchdog to release a stale claim, then re-push.
::error::Card: ${card_url}
EOF
exit 1