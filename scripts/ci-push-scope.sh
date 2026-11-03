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
#     the workflow that validates it (`gradle-wrapper.yml`). It reads the run's
#     conclusion and head SHA, never which of its jobs executed, so a skipped
#     `validate` job leaves the exemption in place; a filtered-out trigger does
#     not.
#
# FOUR RULES KEEP SELECTION A GATE, NOT A HOLE (root AGENTS.md, "When CI
# runs"). They hold for every workflow listed below.
#
#  1. A change to a workflow file runs that workflow in full: a change to how a
#     suite runs runs the suite. Enforced here, ahead of every list.
#  2. A change to the root `package.json`, the lockfile, `nx.json` or a root
#     tsconfig runs everything. Every project's checks read them, so no list
#     can be narrower than they are. Enforced here, ahead of every list.
#  3. A failure of change detection runs everything, and never skips. Half of
#     that is here: this script answers `true` for a base that is not a commit
#     (a new branch, or the all-zero SHA `ci-last-green-sha.sh` prints when it
#     cannot read the runs) and for any event that is neither a push nor a pull
#     request, and under `set -e` a failing `git diff` aborts it rather than
#     printing `false`. The other half is in the workflow: the gated job's `if`
#     carries `!cancelled()` and
#     `needs.<changes>.result != 'success' || needs.<changes>.outputs.run != 'false'`,
#     so a `changes` job that failed, or that somehow published no answer, runs
#     the job. Only an explicit `false` skips it.
#  4. A push that skips a suite inherits the last green result for it. That is
#     correct only because the range starts at the last push THIS WORKFLOW
#     passed on, and nothing here establishes that: the `changes` job hands this
#     script a base from `ci-last-green-sha.sh`, which is where the rule lives.
#     With the previous push as the base instead, a doc-only push after a red
#     one would narrow to the doc and look green.
#
# The diff is read NUL-delimited. `git diff --name-only` applies its display
# quoting (`core.quotePath`) to a path that is not plain ASCII, wrapping it in
# double quotes and escaping its bytes, and an anchored match against
# `"protocol/src/caf\303\251.ts"` fails - a suite skipped on a change to a file
# it reads. `-z` prints the raw bytes instead.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: ci-push-scope.sh <workflow file> <event name> <pull-request base> <push base>" >&2
  exit 2
fi

workflow=$1
event=$2
pr_base=$3
push_base=$4

# Rule 2.
is_root_file() {
  [[ $1 =~ ^(package\.json|bun\.lock|nx\.json|tsconfig[^/]*\.json)$ ]]
}

# Does this one path reach what the workflow reads? One definition per
# workflow.
#
# A package is named whole, never by subdirectory - the rule the `changes` job
# of `browser-regressions.yml` follows: a package's exports reach past `src/`
# (`@traycer/protocol/utils/*` is `protocol/utils/`), so a subdirectory list
# goes stale the moment an export moves.
#
# A `reaches` RUNS NO COMMAND: no command substitution, no pipe, no external
# tool. It is called as the condition of an `if`, and bash suspends `errexit`
# for the whole body of a function called there - so a command that failed
# inside one would not abort the script. It would leave its variable empty, the
# tests below would read that empty value, and the answer could be `false` on a
# path the workflow reads. Rule 3 says a failure runs everything; a `reaches`
# keeps that rule by having nothing in it that can fail. Pattern matching only.
# `scripts/__tests__/ci-push-scope.test.mjs` holds every definition to it.
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
  # Nothing either job runs reads a Markdown file.
  protocol-compat.yml)
    reaches() {
      case "$1" in
        *.md) return 1 ;;
      esac
      [[ $1 =~ ^(protocol|clients/shared)/ ]]
    }
    ;;
  # The CLI's real-launchd provisioning and readiness rows
  # (`clients/traycer-cli/src/host/__tests__/lifecycle-probe-real-launchd.optional.integration.test.ts`),
  # which drive the CLI's own `lifecycle-probe` and `bootstrap-log` and
  # `@traycer-clients/shared`'s `host-lifecycle`, which in turn reaches
  # `@traycer/protocol`. The macOS runner is the scarce one in this workflow,
  # and a push to a client that is not the CLI touches none of the three.
  # Nothing the suite runs reads a Markdown file.
  real-supervisor.yml)
    reaches() {
      case "$1" in
        *.md) return 1 ;;
      esac
      [[ $1 =~ ^(protocol|clients/shared|clients/traycer-cli)/ ]]
    }
    ;;
  # Every committed `gradle-wrapper.jar` is checked against the checksums Gradle
  # publishes. The action finds the jars itself, anywhere in the tree, so the
  # test is on the name rather than on one project's path: a new Gradle project
  # brings a jar and a `gradlew` with it.
  #
  # It matches generously on purpose, because the pinned action
  # (`gradle/actions@3f5f9ad`, `sources/src/wrapper-validation/find.ts`) selects
  # a jar by `unhomoglyph(name).endsWith("gradle-wrapper.jar")` - a lookalike
  # character can hide every token below, and the action's own fixtures include
  # one. So any path that is not plain ASCII runs the validation too. The build
  # scripts (`build.gradle`, `settings.gradle`, `variables.gradle`) match on
  # their name, not because the action reads them.
  gradle-wrapper.yml)
    reaches() {
      case "$1" in
        *[Jj][Aa][Rr]* | *[Gg][Rr][Aa][Dd][Ll][Ee]* | *[Ww][Rr][Aa][Pp][Pp][Ee][Rr]*)
          return 0
          ;;
      esac
      [[ ! $1 =~ ^[A-Za-z0-9._/+-]+$ ]]
    }
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

changed="$(mktemp)"
# shellcheck disable=SC2064 # the path is fixed now, and the trap must not re-read it.
trap "rm -f '${changed}'" EXIT

# `--no-renames` reports a moved file at both its old path and its new one, so a
# file moved out of a named package still counts; rename detection would also
# fetch the contents a blobless clone left out.
git diff -z --name-only --no-renames "${range}" >"${changed}"

relevant=""
while IFS= read -r -d '' path; do
  if [ "${path}" = ".github/workflows/${workflow}" ] \
    || is_root_file "${path}" \
    || reaches "${path}"; then
    relevant="${relevant}${path}
"
  fi
done <"${changed}"

if [ -n "${relevant}" ]; then
  printf 'Running %s in full; it reaches:\n%s' "${workflow}" "${relevant}" >&2
  echo true
else
  echo "Nothing ${workflow} reads changed: skipping it." >&2
  echo false
fi
