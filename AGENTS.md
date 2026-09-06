# AGENTS.md

Default branch: `main`.
Bun 1.3.12 workspaces + Nx.

Open-source **clients, CLI, and protocol**.
The Traycer Host and cloud backends are **not** here - the CLI provisions a signed host from GitHub Releases.
See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Nested docs

Nested `AGENTS.md` files load with the tree they sit in - read them when the task enters that tree.
`CLAUDE.md` is always a symlink to `AGENTS.md` in the same directory (`ln -s AGENTS.md CLAUDE.md`).
Never a copy.

- [`clients/gui-app/AGENTS.md`](clients/gui-app/AGENTS.md)
- [`clients/desktop/AGENTS.md`](clients/desktop/AGENTS.md)
- [`clients/mobile/AGENTS.md`](clients/mobile/AGENTS.md)

## Tooling

Type-check with `bun run compile`, never `tsc`.
`pre-commit` already runs the affected workspace checks (build, compile, lint, format).
Do not re-run those before committing.
Tests run in CI (`test.yml`), not in the hook.
Re-run a check only when diagnosing a hook or CI failure.
Commits need DCO (`git commit -s`).

`make dev-desktop` talks to the **production** cloud - no local backends.
Details: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).
Commands live in `package.json` and the Makefile.

## Domain

**Protocol** - `@traycer/protocol` uses per-method `{ major, minor }` RPC versions negotiated at handshake (not npm semver).
CLI **inlines** protocol at build time.
See `protocol/README.md`.

**Host identity** (GUI) - `hostId` is canonical; tabs bind a `hostId` for life.
Read `clients/gui-app/src/hooks/host/AGENTS.md` when changing host addressing, pins, or composer placement.

**Shared code** - transport / auth in `clients/shared/`; wire contract in `protocol/`.
Do not duplicate.

## Type safety (ESLint - do not bypass)

```ts
// BAD                         // GOOD
fn(x?: T)                      fn(x: T | undefined)
fn(x = 1)                      fn(x: number)  // caller passes explicitly
...args: [T?] | []             // no rest-tuple optionals
as any / as unknown / chained  // narrow or define a real type
ReturnType<typeof fn>          // name the concrete type
```

## Skills

Use a skill when the task matches.
GUI skills: `clients/gui-app/AGENTS.md`.
