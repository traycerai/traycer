# AGENTS.md

Default branch: `main`. Bun 1.3.12 workspaces + Nx.

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
bun run build
bun run compile                 # never tsc directly
bun run lint && bun run format
make test-affected              # optional targeted run; CI owns the test gate
bunx nx run @traycer-clients/traycer-cli:build   # single package
pre-commit run --all-files      # explicit full-repo static validation

make dev-desktop                # signed host from Releases + HMR desktop
make dev-desktop VERSION=1.2.3  # pin host release
```

`make dev-desktop` talks to the **production** cloud — no local backends. Details:
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

**Commits:** do **not** manually run `compile` / `build` / `lint` / `format`
before committing. `pre-commit` already runs the affected workspace checks
(build, compile, lint, format). Tests run in CI (`test.yml`), not in the hook —
only re-run checks yourself when diagnosing a hook or CI failure. Commits need
DCO (`git commit -s`).

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
