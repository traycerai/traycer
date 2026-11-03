#!/usr/bin/env bash

# Does a change reach what one workflow tests? Prints `true` or `false` on
# stdout, and why on stderr.
#
# Every workflow that reads this triggers on a push to `main` with no `paths:`
# filter and decides inside the run, through a `changes` job that calls this
# script and a job-level `if` that reads its answer. That is deliberate: a
# `paths:` filter on the trigger would break two things a filter cannot see.
#
#   - `scripts/ci-push-checks-green.sh` in the internal repository judges a
#     pushed commit by every workflow's latest push run, and refuses a commit
#     whose own push started no run at all. A `paths:` filter starts no run; a
#     `changes` job that skips the rest of the workflow still produces one, and
#     that run concludes `success`, because the `changes` job itself passed.
#   - Scorecard's Binary-Artifacts check exempts a committed
#     `gradle-wrapper.jar` only while the latest commit has a successful run of
#     the workflow that validates it (`gradle-wrapper.yml`). A skipped
#     `validate` job leaves that run in place; a filtered-out trigger does not.
#
# FOUR RULES KEEP SELECTION A GATE, NOT A HOLE (root AGENTS.md, "When CI
# runs"). They hold for every workflow listed below.
#
#  1. A change to a workflow file runs that workflow in full. Every relevance
#     list below is preceded by its own workflow file: a change to how a suite
#     runs runs the suite.
#  2. A change to the root `package.json`, the lockfile, `nx.json` or a root
#     tsconfig runs everything. Every project's checks read them, so no list
#     can be narrower than they are.
#  3. A failure of change detection runs everything, and never skips. This
#     script answers `true` for a base that is not a commit (a new branch, or
#     the all-zero SHA `ci-last-green-sha.sh` prints when it cannot read the
#     runs) and for any event that is neither a push nor a pull request. A
#     `changes` job that fails outright is covered in the workflow instead: the
#     gated job's `if` carries `needs.changes.result != 'success'`, so a failed
#     detection runs the job.
#  4. A push that skips a suite inherits the last green result for it. That is
#     correct only because the range starts at the last push THIS WORKFLOW
#     passed on (`ci-last-green-sha.sh`), not at the push before it: a doc-only
#     push after a red one re-tests the red change and is red too.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: ci-push-scope.sh <workflow file> <event name> <pull-request base> <push base>" >&2
  exit 2
fi

workflow=$1
event=$2
pr_base=$3
push_base=$4

# Rule 1 and the one exclusion every list shares: no job below reads a Markdown
# file.
# shellcheck disable=SC2016 # awk source: `$0` is awk's whole record, not a shell variable.
prefix='
  /\.md$/ { next }
  $0 == workflow_file { print; next }
'

# Rule 2.
always='
  /^package\.json$/ ||
  /^bun\.lock$/ ||
  /^nx\.json$/ ||
  /^tsconfig[^\/]*\.json$/ { print }
'

# The paths whose change can change what the workflow decides.
#
# A package is listed whole, never by subdirectory - the rule the `changes` job
# of `browser-regressions.yml` follows: a package's exports reach past `src/`
# (`@traycer/protocol/utils/*` is `protocol/utils/`), so a subdirectory list
# goes stale the moment an export moves.
case "${workflow}" in
  # The released-peer compatibility gate dumps THIS tree's protocol surface,
  # checks it against every released baseline, and then drives the real client
  # transports
  # (`clients/shared/host-transport/__tests__/released-baseline-handshake.test.ts`)
  # against the baseline manifests. So: `@traycer/protocol`, which the surface
  # is built from and which holds the compat scripts and the governance files
  # the tripwire guards, and `@traycer-clients/shared`, whose transports the
  # last step runs. The protected baseline set comes from the remote's release
  # tags at run time, never from the tree, so no path here can shrink it.
  protocol-compat.yml)
    program='
      /^protocol\// ||
      /^clients\/shared\// { print }
    '
    ;;
  # The CLI's real-launchd provisioning and readiness rows
  # (`clients/traycer-cli/src/host/__tests__/lifecycle-probe-real-launchd.optional.integration.test.ts`),
  # which drive the CLI's own `lifecycle-probe` and `bootstrap-log` and
  # `@traycer-clients/shared`'s `host-lifecycle`, which in turn reaches
  # `@traycer/protocol`. The macOS runner is the scarce one in this workflow,
  # and a push to a client that is not the CLI touches none of the three.
  real-supervisor.yml)
    program='
      /^clients\/traycer-cli\// ||
      /^clients\/shared\// ||
      /^protocol\// { print }
    '
    ;;
  # Every committed `gradle-wrapper.jar` is checked against the checksums Gradle
  # publishes. The action finds the jars itself, anywhere in the tree, so this
  # list is the wrapper files rather than one project's path: a new Gradle
  # project brings a jar and a `gradlew` with it. The build scripts
  # (`build.gradle`, `settings.gradle`, `variables.gradle`) are deliberately
  # absent, because the action reads none of them.
  gradle-wrapper.yml)
    program='
      /gradle-wrapper\.jar$/ ||
      /\/gradle\/wrapper\// ||
      /(^|\/)gradlew(\.bat)?$/ { print }
    '
    ;;
  *)
    echo "ci-push-scope.sh: no relevance list for ${workflow}" >&2
    exit 2
    ;;
esac

answer() {
  echo "$2" >&2
  echo "$1"
  exit 0
}

case "${event}" in
  pull_request) range="${pr_base}...HEAD" ;;
  push)
    if [ -z "${push_base}" ] || ! git cat-file -e "${push_base}^{commit}" 2>/dev/null; then
      answer true "No earlier commit to diff against: running ${workflow} in full."
    fi
    range="${push_base}..HEAD"
    ;;
  *) answer true "A ${event} run always runs ${workflow} in full." ;;
esac

# `--no-renames` reports a moved file at both its old path and its new one, so a
# file moved out of a listed path still counts; rename detection would also
# fetch the contents a blobless clone left out.
relevant="$(git diff --name-only --no-renames "${range}" \
  | awk -v workflow_file=".github/workflows/${workflow}" -- "${prefix}${always}${program}")"

if [ -n "${relevant}" ]; then
  printf 'Running %s in full; it reaches:\n%s\n' "${workflow}" "${relevant}" >&2
  echo true
else
  echo "Nothing ${workflow} reads changed: skipping it." >&2
  echo false
fi
