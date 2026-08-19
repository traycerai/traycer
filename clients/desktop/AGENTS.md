# AGENTS.md — clients/desktop

Electron shell around `@traycer-clients/gui-app`. Read with repo-root
`AGENTS.md`.

## Role

1. Load the `gui-app` renderer.
2. Delegate host lifecycle to the **Traycer CLI** — Desktop never spawns the
   host. Discover WS URL from `~/.traycer/host[/dev]/pid.json`; tail
   `~/.traycer/host[/dev]/host.log`.
3. Expose `IRunnerHost` via `contextBridge` / `ipcMain.handle`.

Transport-agnostic: do **not** proxy host RPC. `gui-app` talks to the host's
localhost HTTP/WS after `LocalHostSnapshot`.

## Commands

```bash
# from clients/desktop/
bun run dev           # shell + renderer only
bun run compile       # type-check (no emit)
bun run build         # main + renderer (no package)
bun run package       # electron-builder
bun run package:dir   # unpacked smoke build
bun run test

# end-to-end (repo root, macOS/Linux) — production cloud + released host
make dev-desktop
make dev-desktop VERSION=1.2.3
```

Details: [`docs/DEVELOPMENT.md`](../../docs/DEVELOPMENT.md).

**Commits:** don't manually run `compile` / `build` / `lint` / `format` before
committing — repo-root `pre-commit` already runs the affected checks (see root
`AGENTS.md`). Tests are CI, not the hook. Re-run checks only when diagnosing
failures.

## Layout

| Path                    | Role                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/electron-main/`    | Main process (`main-process.ts`); feature folders under `app/`, `auth/`, `host/`, `windows/`, `menu/`, `tray/`, `ipc/` |
| `src/electron-preload/` | `window.runnerHost` bridges (`preload-bridge.ts` + `*-bridge.ts`)                                                      |
| `src/renderer-shell/`   | Thin React host; UI is `gui-app` via vite aliases                                                                      |
| `src/ipc-contracts/`    | Plain-data types shared across main/preload/renderer                                                                   |
| `scripts/`              | `dev/`, `prepack/`, `assets/`                                                                                          |
| `resources/cli/`        | Staged CLI SEA (`<platform>-<arch>/traycer`) → `process.resourcesPath/cli/`                                            |
| `resources/tray/`       | Tray icons (regenerate via `scripts/assets/generate-tray-icons.cjs`)                                                   |
| `resources/host/`       | Placeholder only — **never** ship a host binary here                                                                   |

## Invariants

- Bundle CLI only, not the host. Host lives under `~/.traycer/host/` via CLI.
- Main entry: `dist/main/index.js`.
- Preload stays CommonJS and imports only from `src/ipc-contracts/` — with one
  governed exception, `electron-preload/selection-authority-bridge.ts`, which
  also imports the selection-authority **contract parsers** and the
  **buffered/rotating client** from `clients/shared/host-selection/`. Two
  reasons, and a new exception needs both: (1) the attach/rotate choreography is
  identical for the Electron and browser/dev bindings, so a preload-local copy
  is a second implementation of a protocol that must not drift; (2) parsing at
  this hop is what makes same-major skew safety structural — renderer domain
  code never sees an unparsed envelope. The preload is esbuild-bundled to one
  CommonJS file, so a shared import is inlined and the CommonJS half of the rule
  is unaffected. Everything else still crosses as plain wire types through
  `src/ipc-contracts/`; do not read this as licence to move feature logic into
  preload.
- Never build `Tray` from `nativeImage.createEmpty()` (invisible tray).
- No Electron-native SQLite / `better-sqlite3` rebuilds in this shell — host owns
  app-assets DB.
- Signed releases are built in the **internal** repo; this repo has no signing
  secrets. Local: `bun run package` (unsigned) / `package:dir`.
- `prepack:check-cli` without `--platform`/`--arch` is host-lenient; CI passes
  both for matrix-strict checks.

## Boundaries

- Don't add host binaries or Node runtimes to the Desktop bundle.
- Don't proxy host RPC through Electron.
- Don't edit generated `dist/`.
