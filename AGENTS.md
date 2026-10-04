# AGENTS.md

Default branch: `main`. Bun 1.3.14 workspaces + Nx.

Open-source **clients, CLI, and protocol**. The Traycer Host and cloud backends
are **not** here — the CLI provisions a signed host from GitHub Releases; see
[`clients/traycer-cli/README.md`](clients/traycer-cli/README.md). Setup,
toolchain and pre-commit hooks: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Nested docs (read when editing there)

- [`clients/gui-app/AGENTS.md`](clients/gui-app/AGENTS.md)
- [`clients/desktop/AGENTS.md`](clients/desktop/AGENTS.md)
- [`clients/mobile/AGENTS.md`](clients/mobile/AGENTS.md)
- [`mintlify/AGENTS.md`](mintlify/AGENTS.md) — public docs site
  (docs.traycer.ai); every page there is published

## Map

| Path                   | Package                        | Role                             |
| ---------------------- | ------------------------------ | -------------------------------- |
| `protocol/`            | `@traycer/protocol`            | Client⇄host wire contract        |
| `clients/traycer-cli/` | `@traycer-clients/traycer-cli` | CLI (host install, auth, agents) |
| `clients/shared/`      | `@traycer-clients/shared`      | Transport / auth / formatting    |
| `clients/gui-app/`     | `@traycer-clients/gui-app`     | GUI renderer                     |
| `clients/desktop/`     | `@traycer-clients/desktop`     | Electron shell                   |
| `mintlify/`            | —                              | Public docs site (Mintlify)      |

## Commands

```bash
bun install
bun scripts/lint-changed-files.mjs origin/main  # lint the files your branch changed
bunx nx run @traycer-clients/traycer-cli:build   # single package; only when changing packaging

make dev-desktop                # signed host from Releases + HMR desktop
make dev-desktop VERSION=1.2.3  # pin host release
```

`make dev-desktop` talks to the **production** cloud — no local backends.

**Never run a full compile, lint, format, test or build locally.** That means
`bun run compile`, `bun run lint`, `bun run format`, `bun run test`,
`bun run build`, `make test-affected` (every test of each affected project), a
project's whole `lint` (`bun run --cwd clients/gui-app lint`), and
`pre-commit run --all-files`. gui-app's whole-project type-aware lint alone
needs about 9 GB and its type-check about 5 GB, and two agents running them at
once have stalled a 24 GB Mac. The checks still run, just not by hand: the
pre-commit hook lints, formats and compiles what each commit affects (below),
and CI lints, compiles and builds every project a change affects and runs every
project's tests. When CI runs is in "When CI runs" below.

To check work while you write it, narrow the check to what you touched:

- lint the changed files with `bun scripts/lint-changed-files.mjs origin/main`,
  or `bun run lint:files <paths>` inside a project. The first widens itself
  when a lint config, tsconfig or `package.json` changed, or over 200 files
  did: if it prints `linting every affected project` or `$ bun run lint`, stop
  it and use `lint:files`;
- run one test file with `bunx vitest run <path>` from its project;
- run one package's `compile` only to diagnose that package's failure. Never
  run `tsc` directly; `compile` is the type-check.

**Commits:** nothing needs running by hand before a commit, and a full
`compile` / `build` / `lint` / `format` never does; the narrow checks above are
feedback while you work, not a gate. `pre-commit` already runs the local
checks: lint on the files your branch changed, format, and an incremental
compile of the affected projects. It takes one machine-wide slot, so
concurrent commits from other worktrees queue rather than stacking multi-GB
type-checks. CI lints each affected project whole and runs the affected
`build` targets. Tests run in CI (`test.yml`), not in the hook. Commits need
DCO (`git commit -s`).

## When CI runs

A team pull request into `main` (a branch in this repository) runs **no CI**:
every job is skipped, so every required check reports as passed, and the merge
button is available as soon as review passes. Nothing tests such a PR before
it merges, so **the local commit hook is the only automatic check before
merge**. No job is exempt, `guarded-files-tripwire` in `protocol-compat.yml`
included: it runs only on a pull request that runs CI, so a team edit to a
guarded protocol file is not flagged before it merges, and the merge run
reports an edit only to `host-v1.1.5-mutation-v20.ts` (the regenerate-and-compare
test in `test.yml`'s `@traycer/protocol` leg).

A pull request from a fork, a pull request from a bot (Dependabot), and a pull
request into any other branch (a release or integration branch, which has no
run on push) run every check, as before.

The full suite runs once on the merged commit, on every push to `main`, and a
later merge never cancels an earlier merge's run. A failed merge run is rerun
once (`trunk-red.yml`, failed jobs only, because the test suites have known
flakes); if the rerun fails too it is posted to Slack with the commit, its
author and the run. So when `main` goes red, the failure is a break to fix or
revert, not a flake.

A merge run that narrows to what changed (`nx affected` in `pre-commit.yml`, the
`changes` job of `browser-regressions.yml`) compares against the last push its
own workflow passed on, found by `scripts/ci-last-green-sha.sh`, not against
the push before it. So a red merge is not forgotten: the next merge's range
still holds the break, its run stays red, and `main` stays red until a run
covering everything since the last green push passes.

To test a branch before merging it, run the workflow on the branch: the
Actions tab, or `gh workflow run test.yml --ref <branch>` (likewise
`pre-commit.yml`, `protocol-compat.yml`, `browser-regressions.yml` and
`real-supervisor.yml`). Do this for a risky change the hook does not cover:
packaging, the protocol, the CLI's launchd path.

A red `main` also holds up releases: the internal repository's nightly staging
train and its promotion to production both refuse a pinned commit of this
repository whose push checks are not all green.

The rule is one expression, copied into the `if:` of every job in the eight
workflows that trigger on `pull_request` (`test`, `pre-commit`,
`protocol-compat`, `browser-regressions`, `real-supervisor`, `codeql`,
`secret-scan`, `dco`), and pinned by `scripts/__tests__/ci-pull-request-gate.test.mjs`:

```
github.event_name != 'pull_request'
  || github.base_ref != 'main'
  || github.event.pull_request.head.repo.full_name != github.repository
  || github.event.pull_request.user.type == 'Bot'
```

The gate asks "is the head repository this repository", not "is it a fork": a
deleted fork reports no head repository, and that answer must fail toward
running CI. No job is exempt: `guarded-files-tripwire`, which only makes sense
on a pull request, is `github.event_name == 'pull_request' && (<expression>)`.
A new workflow with a `pull_request` trigger carries the
gate on every job; an
aggregator that uses `always()` is `always() && (<expression>)`, so it is
skipped, not failed, on a team PR. The `main` ruleset requires `tests` (the
single check for `test.yml`'s matrix), not the individual matrix names: a
matrix job skipped by a job-level `if` is never expanded, so its names never
report.

After pushing a fork or bot PR, or a PR into another branch, watch the checks
(`gh pr checks --watch`) and fix what they report.

**nx runs without its daemon** (`useDaemonProcess: false` in `nx.json`). A
daemon exits only after three hours without an nx command, so every worktree
that agents keep committing in held one: one machine carried 18 of them,
3.26 GB, each saving under a second per nx command. Don't turn it back on.

## Non-negotiable

**Protocol** — `@traycer/protocol` uses per-method `{ major, minor }` RPC versions
negotiated at handshake (not npm semver). CLI **inlines** protocol at build time.
See `protocol/README.md`.

**Host identity** (GUI):

1. `hostId` is canonical; "device" is UI copy — no parallel `deviceId` field.
2. Tabs bind a `hostId` for life (`<TabHostProvider>` → `useTabHostId()`). Never
   use `useAddressableHostId()` inside a tab. Cross-host = **clone-not-migrate**.
   Reachability checked at tab-open only.

**Shared code** — transport/auth in `clients/shared/`; wire contract in
`protocol/`. Don't duplicate.

One deliberate exception: the **remote session core** (`RemoteSession`, the
relay socket, logical streams, the scheduler, Noise channel and mux chunking)
lives in `protocol/src/host-transport/remote/`, not `clients/shared/`. It is
runtime-neutral and is driven by two peers — the desktop client dialing a
host, and a host dialing another host for cross-host agent calls — so it
cannot depend on anything client-only. What stays in `clients/shared/` is
the client-specific edge: grant acquisition (`grant-client`, which needs
fetch + bearer + entitlement), the per-render session cache
(`active-remote-sessions`), and the thin `RemoteSession` adapter that binds
those in. Put a change in `protocol/` if both peers need it; in
`clients/shared/` if only the desktop does.

## Type safety (ESLint — do not bypass)

```ts
// BAD                         // GOOD
fn(x?: T)                      fn(x: T | undefined)
fn(x = 1)                      fn(x: number)  // caller passes explicitly
...args: [T?] | []             // no rest-tuple optionals
as any / as unknown / chained  // narrow or define a real type
ReturnType<typeof fn>          // name the concrete type
```

## Skills

Use when the task matches. GUI skills: see `clients/gui-app/AGENTS.md`.
