# AGENTS.md

Default branch: `main`. Bun 1.3.14 workspaces + Nx.

Open-source **clients, CLI, and protocol**. The Traycer Host and cloud backends
are **not** here — the CLI provisions a signed host from GitHub Releases; see
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Nested docs (read when editing there)

- [`clients/gui-app/AGENTS.md`](clients/gui-app/AGENTS.md)
- [`clients/desktop/AGENTS.md`](clients/desktop/AGENTS.md)

## Map

| Path                   | Package                        | Role                             |
| ---------------------- | ------------------------------ | -------------------------------- |
| `protocol/`            | `@traycer/protocol`            | Client⇄host wire contract        |
| `clients/traycer-cli/` | `@traycer-clients/traycer-cli` | CLI (host install, auth, agents) |
| `clients/shared/`      | `@traycer-clients/shared`      | Transport / auth / formatting    |
| `clients/gui-app/`     | `@traycer-clients/gui-app`     | GUI renderer                     |
| `clients/desktop/`     | `@traycer-clients/desktop`     | Electron shell                   |

## Commands

```bash
bun install
bun scripts/lint-changed-files.mjs origin/main  # lint the files your branch changed
bunx nx run @traycer-clients/traycer-cli:build   # single package

make dev-desktop                # signed host from Releases + HMR desktop
make dev-desktop VERSION=1.2.3  # pin host release
```

`make dev-desktop` talks to the **production** cloud — no local backends. Details:
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

**Never run a full compile, lint, format, test or build locally.** That means
`bun run compile`, `bun run lint`, `bun run format`, `bun run test`,
`bun run build`, `make test-affected` (every test of each affected project), a
project's whole `lint` (`bun run --cwd clients/gui-app lint`), and
`pre-commit run --all-files`. gui-app's whole-project type-aware lint alone
needs about 9 GB and its type-check about 5 GB, and two agents running them at
once have stalled a 24 GB Mac. The checks still run, just not by hand: the
pre-commit hook runs the affected ones on every commit (below), and CI runs
all of them on the PR. After pushing, watch the checks (`gh pr checks
--watch`) and fix what they report.

To check work before committing, narrow the check to what you touched:

- lint the changed files with `bun scripts/lint-changed-files.mjs origin/main`,
  or `bun run lint:files <paths>` inside a project;
- run one test file with `bunx vitest run <path>` from its project;
- run one package's `compile` only to diagnose that package's failure. Never
  run `tsc` directly; `compile` is the type-check.

**Commits:** do **not** manually run `compile` / `build` / `lint` / `format`
before committing. `pre-commit` already runs the local checks: lint on the
files your branch changed, format, and an incremental compile of the affected
projects. It takes one machine-wide slot, so concurrent commits from other
worktrees queue rather than stacking multi-GB type-checks. CI runs the
whole-project lint and the `build` targets. Tests run in CI (`test.yml`), not
in the hook; only re-run checks yourself when diagnosing a hook or CI failure.
Commits need DCO (`git commit -s`).

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
