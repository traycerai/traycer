# AGENTS.md

Default branch: `main`. Bun 1.3.14 workspaces + Nx.

Open-source **clients, CLI, and protocol**. The Traycer Host and cloud backends
are **not** here — the CLI provisions a signed host from GitHub Releases; see
[`clients/traycer-cli/README.md`](clients/traycer-cli/README.md). Setup,
toolchain and pre-commit hooks: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Nested docs (read when editing there)

- [`.github/AGENTS.md`](.github/AGENTS.md) — the pull-request CI gate and the
  merge run. Read it before editing a workflow or a CI script
  (`scripts/ci-*`, `scripts/__tests__/ci-pull-request-gate.test.mjs`)
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

## Local checks: narrow, never full

**Never run a full compile, lint, format, test or build by hand:**
`bun run compile`, `lint`, `format`, `test` or `build`, `make test-affected`,
a project's whole `lint`, or `pre-commit run --all-files`. gui-app's lint
needs about 9 GB and its type-check about 5 GB; two at once have stalled a
24 GB Mac. The commit hook and CI run them.

While you work, check only what you touched:

- Lint the changed files: `bun scripts/lint-changed-files.mjs origin/main`,
  or `bun run lint:files <paths>` inside a project. If the first prints
  `linting every affected project` or `$ bun run lint`, stop it and use
  `lint:files`.
- One test file: `bunx vitest run <path>` from its project.
- One package's `compile`, only to diagnose its failure. Never run `tsc`.

**Commits** need DCO (`git commit -s`) and nothing run by hand first. The
hook lints the changed files, formats, and type-checks the affected projects,
inside one machine-wide slot. Tests and builds run in CI. nx runs without its
daemon (`useDaemonProcess: false`): leave it off.

## When CI runs

A team pull request into `main`, an `integration/*` branch or a `land/*`
branch runs **no CI, on purpose**, except the CodeQL scan: every required
check reports passed, so a merge needs review only, and the commit hook is the
only other automatic check before merge. Work on those branches is tested by
the merge run once it reaches `main`. Pull requests from forks and bots, and
into any other branch, run every check; watch them with
`gh pr checks --watch` and fix what they report.

**CI does not run on a branch by default.** Check what you can locally with
the narrow checks above (one package's `build` for packaging); everything
else runs on the merge. Dispatch a workflow on a branch
(`gh workflow run <workflow> --ref <branch>`) sparingly: only when a check is
actually needed before the merge and no local check covers it, and name the
reason in the pull request.

The full suite runs once on every push to `main`. `trunk-red.yml` re-runs
failed jobs once; a failed `trunk-red` run means `main` is really red, a break
to fix or revert, not a flake. A red merge stays red until a run covering it
passes, and a red `main` blocks the internal repository's staging train and
promotion.

How the gate works and how a new workflow carries it:
[`.github/AGENTS.md`](.github/AGENTS.md).

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
`protocol/`. Don't duplicate. One exception: the remote session core
(`RemoteSession`, the relay socket, streams, the scheduler, Noise and mux
chunking) lives in `protocol/src/host-transport/remote/`, because a host
dialing another host drives it too. Put a change in `protocol/` if both peers
need it, in `clients/shared/` if only the desktop does.

**User-facing copy** — a setting description, label, tooltip, toast, error
message or docs row says what the thing does and what it costs the person, and
nothing else. Leave out how it is built: the model or library behind a
feature, its licence or version, per-engine language lists, the mechanism.
Test every sentence: does the reader need it to decide or to act? Keep to the
length of the neighbouring rows. When a reviewer calls copy inaccurate or
incomplete, cut the claim before adding words; never enumerate to make a broad
sentence true. A change that gives the person nothing new to configure changes
no copy. Licence and attribution text goes in a notices file, not in the
interface.

## Type safety (ESLint — do not bypass)

```ts
// BAD                         // GOOD
fn(x?: T)                      fn(x: T | undefined)
fn(x = 1)                      fn(x: number)  // caller passes explicitly
...args: [T?] | []             // no rest-tuple optionals
as any / as unknown / chained  // narrow or define a real type
ReturnType<typeof fn>          // name the concrete type
```

## Slop the sweep keeps finding

| BAD                                                             | GOOD                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Repeat the same input, path and assertion in another test.      | Keep one case; add coverage only for a distinct regression.                           |
| Let a test inherit mutable fixture state from another test.     | Reset shared fixture state for every test and restore temporary overrides in cleanup. |
| Leave A's contract above newly inserted B.                      | Keep each contract comment attached to the declaration or operation it describes.     |
| Assert only a constant or two aliases.                          | Assert its effect through the real consumer.                                          |
| Ticket BEGIN/END or review-round markers in source.             | Remove workflow markers; retain durable invariants.                                   |
| Carry state that no consumer reads.                             | Remove unused fields and the work that populates them.                                |
| Wrap one call or expression without a distinct contract.        | Keep the expression at its caller.                                                    |
| Describe access using a retired owner or cache policy.          | Match the current authorization boundary and freshness policy.                        |
| Export a module-only implementation with no external consumer.  | Keep it private; retain public and registered contracts.                              |
| Require port members that no consumer reads or calls.           | Keep only the members consumers use; remove fixture no-ops.                           |
| Repeat an assertion implied by an exact result check.           | Keep the exact check and assertions for distinct effects.                             |
| Assert only that a required field exists.                       | Exercise its effect through the real consumer.                                        |
| Keep comments that describe a retired contract.                 | Update or remove stale claims when the contract changes.                              |
| Assert only a test double's implementation.                     | Assert production behavior through the real consumer.                                 |
| Treat a sleep or fixed microtask count as operation completion. | Await the operation's completion or its observable outcome before asserting.          |
| Keep runtime declarations with no production consumer.          | Remove unused declarations and tests that exercise only them.                         |
| Check for a result the private implementation cannot return.    | Make its return type exact and remove the unreachable branch.                         |

## Skills

Use when the task matches. GUI skills: see `clients/gui-app/AGENTS.md`.
