#!/usr/bin/env bash
# Run GitHub's required checks on this exact commit before updating main.
set -euo pipefail

repo=state-vector/bridge
main=refs/heads/main
candidate=$(git rev-parse HEAD)
git fetch origin "$main"
base=$(git rev-parse FETCH_HEAD)
if [[ "$candidate" == "$base" ]] || ! git merge-base --is-ancestor "$base" "$candidate"; then
  echo "Expected HEAD to advance origin/main ($base). Rebase the candidate and retry." >&2
  exit 1
fi

branch="main-preflight/${candidate}-$(date +%s)-$$"
ref="refs/heads/$branch"
cleanup() {
  git push origin ":$ref" >&2 || echo "Could not remove preflight branch $branch." >&2
}
git push origin "$candidate:$ref"
trap cleanup EXIT
if [[ "$(gh api "repos/$repo/commits/$candidate" --jq .commit.verification.verified)" != true ]]; then
  echo "GitHub could not verify the signature on $candidate. Main was not updated." >&2
  exit 1
fi

run=
for ((attempt = 0; attempt < 30; attempt++)); do
  run=$(gh run list --repo "$repo" --workflow ci.yml --branch "$branch" \
    --commit "$candidate" --event push --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  if [[ -n "$run" ]]; then
    break
  fi
  sleep 2
done
if [[ -z "$run" ]]; then
  echo "GitHub did not start CI for $candidate on $branch. Main was not updated." >&2
  exit 1
fi

echo "Checking $candidate in https://github.com/$repo/actions/runs/$run"
gh run watch "$run" --repo "$repo" --compact --exit-status
required=$(gh run view "$run" --repo "$repo" --json jobs,headSha,headBranch,event \
  --jq '{headSha,headBranch,event,jobs:[.jobs[] | select(.conclusion == "success") | .name]}')
if ! jq -e --arg sha "$candidate" --arg branch "$branch" '
  .headSha == $sha and .headBranch == $branch and .event == "push"
  and ((["Test", "CLI build (packages/cli)", "main-green gate"] - .jobs) == [])
' <<< "$required" >/dev/null; then
  echo "Required successful jobs are missing for $candidate. Main was not updated." >&2
  exit 1
fi

# Ancestry was proven above. The explicit lease prevents a concurrent update
# to main from changing the base after the destination health check.
git push --force-with-lease="$main:$base" origin "$candidate:$main"
