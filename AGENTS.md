- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.

## Project Overview

Traycer is an AI-powered pair-programming platform. This repository holds the
**open-source clients, CLI, and protocol** — the parts that run on a developer's
machine and talk to the Traycer host. It uses **Bun workspaces** and **Nx** for
task orchestration.

The Traycer Host and cloud backend are **not** part of this repo: the CLI
provisions a signed **host** binary from GitHub Releases, and the clients run
against the production cloud. See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

### Workspaces

| Path | Package | Responsibility |
|---|---|---|
| `protocol/` | `@traycer/protocol` | Versioned, runtime-negotiated client⇄host wire contract (schemas, RPC). |
| `clients/traycer-cli/` | `@traycer-clients/traycer-cli` | The `traycer` CLI — provisions/upgrades the host, auth, agent & workspace commands. |
| `clients/shared/` | `@traycer-clients/shared` | Transport (WebSocket/RPC), auth (PKCE/bearer), and formatting shared across clients. |
| `clients/gui-app/` | `@traycer-clients/gui-app` | GUI renderer (React + Vite + TanStack Router/Query + Zustand + shadcn/ui). |
| `clients/desktop/` | `@traycer-clients/desktop` | Electron shell around `gui-app`. |

### Workspace-Specific Agent Docs

- `clients/gui-app/` — read [`clients/gui-app/AGENTS.md`](clients/gui-app/AGENTS.md)
  before app-specific changes; it lists the GUI-focused skills in
  `.agents/skills/` to prefer there.
- `clients/desktop/` — read [`clients/desktop/AGENTS.md`](clients/desktop/AGENTS.md).

## Common Commands

```bash
bun install
bun run build      # build the publishable packages (Nx)
bun run compile    # type-check every package
bun run test       # Vitest
bun run lint       # ESLint
bun run format     # Prettier

pre-commit run --all-files   # hygiene + workspace checks
```

Nx caches and only rebuilds what changed. Target a single package with e.g.
`bunx nx run @traycer-clients/traycer-cli:build`.

### Running the desktop locally

```bash
make dev-desktop                 # download the latest released host + run the HMR desktop shell
make dev-desktop VERSION=1.2.3   # pin a specific host release
```

This downloads the signed host from GitHub Releases, verifies it against the
trust key committed in `clients/traycer-cli/src/config.ts`, and runs the Electron
dev shell against the production cloud — no secrets or local backend services.
macOS / Linux. See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Architecture

### Protocol

`@traycer/protocol` is the **versioned, runtime-negotiated** client⇄host wire
contract — per-method `{ major, minor }` compatibility negotiated at the
handshake, not npm semver. Clients and the host can ship independently as long as
their versions stay compatible. The CLI **inlines** the protocol at build time,
so the published CLI has no runtime protocol dependency.

### Host identity model

Two domain rules govern how the renderer addresses hosts:

1. **`hostId` ≡ `deviceId`.** The same identifier names a physical machine and the
   host process running on it. `hostId` is canonical in code and schemas;
   "device" is UI-only copy. Don't introduce a parallel `deviceId` field that
   maps 1:1 to an existing `hostId`.

2. **Tabs are bound to a host for life.** Every chat tab and every terminal tab
   carries a `hostId` persisted in its artifact schema. The React tree projects
   this with `<TabHostProvider hostId>`; consumers read `useTabHostId()` from
   context, never `useReactiveActiveHostId()`. Cross-host continuation is
   **clone-not-migrate**:
   - **Chat**: continuing on a different host clones the artifact (new id, copied
     history).
   - **Terminal**: bound for life — a PTY can't migrate. If the host is
     unreachable, the tab is permanently dead until that host returns.

   Reachability is checked **at tab-open time only**, not reactively. There is no
   "swap host" affordance.

The renderer addresses **two host scopes** simultaneously:

- **Default host**: machine-local host for app-wide features (Epic list, opening
  artifacts, notifications, host-status footer). Accessed via
  `useReactiveActiveHostId()` / `useHostClient()`.
- **Tab-scoped host**: per-tab binding from the artifact schema. Accessed via
  `useTabHostId()` from `<TabHostProvider>`.

When adding a query/mutation hook, decide explicitly which scope it serves. Don't
write a hook that silently switches scopes based on render context.

## Skills Usage

When working in a workspace, search its `.agents/` or `.claude/` folder for
relevant skills and use them for the task at hand. The GUI workspace
(`clients/gui-app/`) ships local skills (shadcn, Tailwind v4, TanStack
Router/Query, Zustand) — see its `AGENTS.md`.

## Style Guide

- Keep things in one function unless composable or reusable.
- Avoid `try`/`catch` except at boundaries where you can handle or add context.
- Avoid the `any` type.
- Rely on type inference; avoid explicit annotations/interfaces unless needed for
  exports or clarity.
- Prefer functional array methods (`flatMap`, `filter`, `map`) over for-loops; use
  type guards on `filter` to keep type inference downstream.

## Code Guidelines

- **Naming**: files `kebab-case`, classes/types `PascalCase`, functions
  `camelCase`, constants `UPPER_SNAKE_CASE`.
- **Strict typing**: avoid `any` and unsafe assertions. Do not use `as any`,
  `as unknown`, or chained assertions like `as unknown as`.
- **Function signatures**: do not use optional parameters (`?:`). Use explicit
  unions such as `value: T | undefined` or `value: T | null`.
- **Required arguments**: do not use default parameter values; every argument is
  passed explicitly by the caller.
- **No pseudo-optionals**: do not use rest-parameter tuple/union shims such as
  `...args: [value: T | undefined]`.
- **Explicit types**: do not use utility aliases like `ReturnType<...>` to infer
  another function's return type; define the concrete type directly.
- **Lint policy**: these type-safety rules apply to production code and tests. Do
  not bypass them with `eslint-disable` / `eslint-ignore` or equivalent
  suppressions.
- **Shared code**: put transport/auth/formatting shared across clients in
  `clients/shared/`, and the client⇄host wire contract in `protocol/`. Don't
  duplicate.
- **Error handling**: catch only at boundaries where you can handle or add
  context.
- **Logging**: log at task/transport boundaries. Never log secrets or user code.
  Don't "log + rethrow" deep in the stack.
- **Sizing (UI)**: no fixed pixel/rem widths or heights for layout surfaces. Use
  fluid constraints — `w-full`, `max-w-*`, `min-h-*`, `max-h-*`, `%`,
  `vw`/`vh`/`dvh`, `clamp()`, `min()`, `max()`, flex/grid sizing. For
  popovers/dialogs/sheets cap with viewport-aware values like `w-[min(90vw,Nrem)]`,
  `max-h-[min(70vh,Nrem)]`. Hardcoded sizes only for inherently fixed elements:
  icons, hairlines, badges, touch targets.

## Type Checking

- Always run `bun run compile` for the workspaces containing your changes, never
  `tsc` directly.
