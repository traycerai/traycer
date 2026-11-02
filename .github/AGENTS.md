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

The full suite runs once on the merged commit, on every push to `main`, and a
later merge never cancels an earlier merge's run.

- A failed merge run is re-run once (`trunk-red.yml`, failed jobs only,
  because the test suites have known flakes). If the re-run fails too, the
  `trunk-red` run itself fails, with the commit, its author and the run in its
  summary. It sends nothing anywhere: a failed `trunk-red` run is the signal,
  and the one thing an alert has to watch.
- A merge run that narrows to what changed (`nx affected` in `pre-commit.yml`,
  the `changes` jobs of `browser-regressions.yml` and `formal-regressions.yml`)
  compares against the last push its own workflow passed on (`scripts/ci-last-green-sha.sh`), not the
  push before. So the next merge's range still holds a break, and `main`
  stays red until a run covering everything since the last green push passes.
- The internal repository's nightly staging train and its promotion to
  production both refuse a pinned commit of this repository whose push checks
  are not all green.
