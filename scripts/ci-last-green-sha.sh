#!/usr/bin/env bash

# What should a push run compare itself against? Not the push before it: the
# last push this workflow PASSED on.
#
# A team pull request runs no check before it merges (AGENTS.md, "When CI
# runs"), and a push run tests only what its range changed: `nx affected` in
# `pre-commit.yml` and the `changes` job of `browser-regressions.yml` both
# narrow to it. With the previous push as the base, a red merge is forgotten by
# the next one: A breaks the compile, B changes a doc, B's run narrows to the
# doc and is green, and the release gates, which read the tip, ship A. With the
# last green push as the base, B's range still holds A's change, B's run is red
# too, and the tip stays red until a push whose run covers everything since
# the last green one passes.
#
# Prints one SHA: the head of the newest successful push run of
# <workflow file> on <branch> that is <before> or an ancestor of it. That is
# <before> itself whenever the previous push's run has finished green. While
# that run is still going it is not yet a pass, so the range reaches back to
# the last finished green one and this run re-tests the merges in flight:
# wider, never narrower.
#
# When the runs cannot be read, or no successful run is an ancestor, there is
# no base, and the answer is the all-zero SHA: every caller already treats a
# base that is not a commit as "compare everything". The previous push is
# never the answer then. It would narrow the range, and narrowing on a failed
# read is how a red merge gets forgotten: the cost of the other choice is one
# full run.
#
# Needs `gh`, a `GH_TOKEN` with `actions: read`, and a checkout with history
# (`fetch-depth: 0`) to test ancestry.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: ci-last-green-sha.sh <workflow file> <branch> <before sha>" >&2
  exit 2
fi

workflow=$1
branch=$2
before=$3

no_base() {
  echo "::warning::$1; comparing everything." >&2
  echo "0000000000000000000000000000000000000000"
  exit 0
}

# A new branch has no previous push; the caller already treats that as
# "compare everything".
if ! git rev-parse --verify --quiet "${before}^{commit}" >/dev/null; then
  echo "${before}"
  exit 0
fi

candidates="$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs?branch=${branch}&event=push&status=success&per_page=100" \
  --jq '.workflow_runs[].head_sha')" \
  || no_base "could not read the successful push runs of ${workflow} on ${branch}"

# Newest first. A run that finished out of order can belong to a commit after
# <before>; only <before> or an ancestor of it is a base for this push.
while IFS= read -r sha; do
  [ -n "${sha}" ] || continue
  if git merge-base --is-ancestor "${sha}" "${before}" 2>/dev/null; then
    echo "${sha}"
    exit 0
  fi
done <<<"${candidates}"

no_base "no successful push run of ${workflow} on ${branch} is an ancestor of ${before:0:12}"
