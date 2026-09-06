# AGENTS.md - clients/desktop

Electron shell around `@traycer-clients/gui-app`.
Read with repo-root `AGENTS.md`.

## Role

1. Load the `gui-app` renderer.
2. Delegate host lifecycle to the **Traycer CLI** - Desktop never spawns the host.
   Discover WS URL from `~/.traycer/host[/dev]/pid.json`; tail `~/.traycer/host[/dev]/host.log`.
3. Expose `IRunnerHost` via `contextBridge` / `ipcMain.handle`.

Do **not** proxy host RPC.
`gui-app` talks to the host's localhost HTTP / WS after `LocalHostSnapshot`.

Two exceptions:

- Sunsetted: v1.2.0 `host.*` maintenance projections in `host-management-ipc.ts` for a LOCAL host too old to serve them.
  Main is the origin (it shells the bundled CLI).
  The block comment there carries the rationale; delete the lane when the fleet floor reaches 1.2.0.
- Permanent: the **`browser.sessions` stream is main's** (H10).
  Main opens it, answers every cookie-bearing frame, and forwards only the opaque UX projection to the renderer.
  After H10 no cookie value exists in a renderer process.

## Tooling

`pre-commit` already runs affected compile / lint / format.
Do not re-run those before committing.
Tests are CI, not the hook.
`make dev-desktop` is the end-to-end loop (repo root; production cloud + released host).
Details: [`docs/DEVELOPMENT.md`](../../docs/DEVELOPMENT.md).
Commands live in `package.json`.

`resources/host/` is a placeholder only - **never** ship a host binary here.

## Invariants

- Bundle CLI only, not the host.
  Host lives under `~/.traycer/host/` via CLI.
- Main entry: `dist/main/index.js`.
- Preload stays CommonJS and imports only from `src/ipc-contracts/`, with one governed exception: `electron-preload/selection-authority-bridge.ts` also imports the selection-authority **contract parsers** and the **buffered / rotating client** from `clients/shared/host-selection/`.
  A new exception needs both reasons in that file's comment.
  Everything else still crosses as plain wire types through `src/ipc-contracts/`.
- **Browser-guest keyboard policy is one table.**
  Every chord that must still mean something while a `<webview>` is focused lives in `clients/gui-app/src/lib/browser-view/reserved-chords-registration.ts` and nowhere else.
  Do not add a focus check to a menu item instead.
  Electron ROLE items (reload, cut / copy / paste, select-all) already act on the focused web contents - leave them alone.
- **Local browser tiles are renderer-owned `<webview>` guests.**
  Placement is CSS `position-anchor` on a persistent DOM host.
  There is no native-view occlusion coordinator, bounds IPC, or snapshot stand-in.
  See `docs/adr/0001-browser-tile-rendering.md`.
- **Login import** - read `src/electron-main/browser-view/storage/login-import/AGENTS.md` before changing cookie-jar import.
- Never build `Tray` from `nativeImage.createEmpty()` (invisible tray).
- No Electron-native SQLite / `better-sqlite3` rebuilds in this shell - host owns app-assets DB.
- Signed releases are built in the **internal** repo; this repo has no signing secrets.
  Local: `bun run package` (unsigned) / `package:dir`.
- `prepack:check-cli` without `--platform` / `--arch` is host-lenient; CI passes both for matrix-strict checks.

## Boundaries

- Do not add host binaries or Node runtimes to the Desktop bundle.
- Do not proxy host RPC through Electron.
- Do not edit generated `dist/`.
