# CI internals

Read this before editing a workflow or a CI script. The rules every change
follows are in the root `AGENTS.md`, "When CI runs".

## The pull-request gate

A team pull request (a branch in this repository) into `main`, an
`integration/*` branch or a `land/*` branch runs no job but the CodeQL scan.
The rule is one expression, copied into the `if:` of every job but `analyze`
in the ten workflows that trigger on `pull_request` (`test`, `pre-commit`,
`protocol-compat`, `browser-regressions`, `formal-regressions`,
`real-supervisor`, `codeql`, `secret-scan`, `dco`, `gradle-wrapper`), and
pinned by `scripts/__tests__/ci-pull-request-gate.test.mjs`:

```
github.event_name != 'pull_request'
  || (github.base_ref != 'main' && !startsWith(github.base_ref, 'integration/') && !startsWith(github.base_ref, 'land/'))
  || github.event.pull_request.head.repo.full_name != github.repository
  || github.event.pull_request.user.type == 'Bot'
```

- `integration/*` and `land/*` branches have no push run. Their work reaches
  `main` through a pull request, so the merge run on `main` tests it once,
  the same as any other team change.
- The gate asks "is the head repository this repository", not "is it a
  fork": a deleted fork reports no head repository, and that answer must fail
  toward running CI.
- `codeql.yml`'s `analyze` is the one exempt job: it shows a new security
  alert on the pull request that introduces it, and it is not a required
  check.
- `guarded-files-tripwire` in `protocol-compat.yml` only makes sense on a pull
  request, so it is `github.event_name == 'pull_request' && (<expression>)`.
  A team edit to a guarded protocol file is therefore not flagged before it
  merges; the merge run reports an edit only to
  `host-v1.1.5-mutation-v20.ts` (the regenerate-and-compare test in
  `test.yml`'s `@traycer/protocol` leg).
- A new workflow with a `pull_request` trigger carries the gate on every job.
  An aggregator that uses `always()` is `always() && (<expression>)`, so it is
  skipped, not failed, on a team pull request.
- The `main` ruleset requires `tests` (the single check for `test.yml`'s
  matrix), not the matrix names: a matrix job skipped by a job-level `if` is
  never expanded, so its names never report.

## The merge run

Every push to `main` starts a run of every workflow, each running what the
merged commit reaches, once, and a later merge never cancels an earlier merge's
run.

- No test may need a retry: a test passes on its first attempt (owner ruling,
  3 Nov 2026). `trunk-red.yml` re-runs nothing. A failed merge run is red on
  attempt 1: the `trunk-red` run itself fails, with the commit, its author and
  the run in its summary, and the failure is fixed forward. It sends nothing
  anywhere: a failed `trunk-red` run is the signal, and the one thing an alert
  has to watch.
- A merge run that narrows to what changed (`nx affected` in `pre-commit.yml`,
  the `changes` jobs of `browser-regressions.yml`, `formal-regressions.yml`,
  `protocol-compat.yml`, `real-supervisor.yml` and `gradle-wrapper.yml`,
  `macos-packaging-changes` in `test.yml`)
  compares against the last push its own workflow passed on (`scripts/ci-last-green-sha.sh`), not the
  push before. So the next merge's range still holds a break, and `main`
  stays red until a run covering everything since the last green push passes.
  The four rules that keep narrowing a gate are in the root `AGENTS.md`,
  "When CI runs", and in the header of `scripts/ci-push-scope.sh`.
- A path list a CI decision reads from `git diff` is read with `-z` and
  `--no-renames`. `--name-only` alone applies git's display quoting to a path
  that is not plain ASCII, so the record arrives as
  `"protocol/src/caf\303\251.ts"`, quotes included, and every anchored match
  fails on it; rename detection prints only the new path, so a file moved out of
  a listed path escapes. Either way a suite is skipped on a change to a file it
  reads. `ci-pull-request-gate.test.mjs` holds every such site to both flags.
- Narrowing is a job-level skip, never a `paths:` filter on the trigger. Two
  readers outside this repository depend on the run existing at all: the
  internal release gate judges a pushed commit by every workflow's latest push
  run and refuses a commit whose own push started none, and Scorecard's
  Binary-Artifacts check exempts a committed `gradle-wrapper.jar` only while the
  latest commit has a successful run of `gradle-wrapper.yml`. A `changes` job
  that skips the rest of its workflow still leaves a run that concludes
  `success`, because the `changes` job itself passed.
- A job gated on a `changes` job carries `!cancelled()` and
  `needs.<changes>.result != 'success' || needs.<changes>.outputs.run != 'false'`
  in its `if`. Without `!cancelled()` GitHub skips a job whose dependency
  failed, and a skipped job satisfies a required check - so a failed detection
  would pass the gate instead of running it. The answer is tested for `'false'`
  rather than for `'true'`, so a missing or malformed output runs the job too.
  An explicitly cancelled run starts no job either way, and the release gate
  refuses a cancelled run.
- `pre-commit.yml`'s `lint` and `compile` jobs restore a cache only a passing
  push saves, so every run starts from the last green `main` entry. It holds
  `NX_CACHE_DIRECTORY`, the Nx database and gui-app's ESLint cache. A cached
  result replays as a pass, so a target's `inputs` must name everything its
  answer depends on: `lint` is type-aware and lists `^production`, and lists
  every source extension the linters read. A rule that reads another file
  (`components.json`, a stylesheet) goes in the cache key too, because ESLint
  hashes only the file it lints. `build` keeps the desktop renderer's
  React-compiled modules instead (`TRAYCER_REACT_COMPILER_CACHE_DIR`, read by
  `clients/desktop/scripts/react-compiler-plugin.ts`), keyed on each module's
  code, the compiler options and `bun.lock`, so a renderer change recompiles
  only the modules it changed. A failed compile is never stored.
- A protocol test file over 10 s fails the `test (@traycer/protocol)` leg
  unless `protocol/test-budget-allowlist.json` names it with a reason. It runs
  once more alone first, because a file's time on the runner moves by half
  between runs. A suite sized by case count runs the rest of its cases in
  `measurements.yml`, once a night, behind `HOST_MEASUREMENT_FULL`; nothing but
  that workflow's own run reports a failure there.
- The internal repository's nightly staging train and its promotion to
  production both refuse a pinned commit of this repository whose push checks
  are not all green.
