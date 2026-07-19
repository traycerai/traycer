# AGENTS.md - clients/desktop

This workspace contains the Electron desktop shell that hosts the `gui-app`
renderer.

## Purpose

`desktop` hosts the production Electron app that:

1. Loads the `gui-app` renderer.
2. Delegates host lifecycle (install / start / stop / restart / doctor) to the
   bundled Traycer CLI - Desktop never spawns the host directly. It reads
   `~/.traycer/host[/dev]/pid.json` to discover the host's websocket URL,
   and tails `~/.traycer/host[/dev]/host.log` for startup diagnostics.
3. Exposes the `IRunnerHost` surface from
   `@traycer-clients/shared/platform/runner-host` through a `contextBridge` /
   `ipcMain.handle` bridge.

The shell is transport-agnostic: it never proxies host RPC traffic. `gui-app`
talks directly to the host's localhost HTTP/WebSocket URLs once they are
discovered from `LocalHostSnapshot`.

## Layout

- `src/electron-main/` - Electron main process. Entrypoint: `main-process.ts`.
  Feature subfolders: `app/` (logger/updater/about/support cross-cutting
  services), `auth/` (deep-link, sessions, secure storage), `host/`
  (local-host lifecycle/paths/log piper), `windows/` (window factory +
  registry + per-window state), `menu/`, `tray/`, and `ipc/` (per-feature IPC
  handlers split out of the former `runner-ipc.ts` monolith - see
  `ipc/register-runner-ipc.ts` for the composer entry).
- `src/electron-preload/` - Context-isolated preload exposing
  `window.runnerHost`. Entrypoint: `preload-bridge.ts`. Per-feature bridges live
  in sibling `*-bridge.ts` files (auth, host, tray, windows, ownership,
  per-window-state, menu, support, lifecycle); the entry composes them after
  their module-load `ipcRenderer.on` subscriptions register.
- `src/renderer-shell/` - Thin React shell (`main.tsx`, `index.html`,
  `desktop-runner-host.ts`). The actual UI is `@traycer-clients/gui-app`,
  consumed as a workspace library via vite aliases.
- `src/ipc-contracts/` - Plain-data types shared by all three Electron processes
  (channel names, window/host/auth-session types, lifecycle types). Keep these
  in sync with the canonical shared module.
- `scripts/` - Build helpers, grouped by purpose: `dev/` (dev-main,
  write-main-entry), `prepack/` (bundled CLI + tray asset prechecks, macOS
  bundled-CLI signing verification), `assets/` (tray-icon generator).
- `resources/host/` - Empty placeholder kept solely because `package.json`'s
  `build.extraResources` still references the path. Desktop **never** bundles a
  host binary, host runtime, or developer Node binary; host lifecycle is fully
  owned by the Traycer CLI subprocess, and the host itself is provisioned as a
  signed release binary - it is not shipped inside Desktop. The one exception
  is macOS **production** packaging: `scripts/prepack/inject-host-launch-agent.cjs`
  (electron-builder `afterPack`; no `afterSign` - electron-builder's own
  signing pass already deep-signs the injected helper) stages a helper `.app`
  wrapping the bundled CLI plus an SMAppService LaunchAgent plist (`BundleProgram`, relative
  path, `NumberOfFiles = 8192`) into the bundle so Login Items attribution and
  the host's descriptor limit work out of the box; unstamped/dev builds no-op.
  The `extraResources` filter is restricted to `README.md` + `.gitkeep`. No live
  `src/` code reads from this directory, and the removed symbols
  `resolveHostBinaryPath` / `TRAYCER_HOST_BINARY` no longer exist anywhere in
  this workspace.
- `resources/cli/` - Bundled Traycer CLI staging directory. The CLI ships as a
  single-file Node SEA per `<platform>-<arch>`. CI release workflows stage the
  CLI binary into `resources/cli/<platform>-<arch>/traycer[.exe]`;
  `electron-builder`'s `extraResources` (`resources/cli` → `cli`) maps that into
  `process.resourcesPath/cli/`. First-launch Setup self-heals the bundled CLI
  into the per-user stable path `~/.traycer/cli/bin/traycer`.
- `resources/tray/` - Tray icon PNGs (`trayTemplate.png` + `@2x` for the macOS
  template image; `tray.png` + `@2x` for Windows / Linux). Committed to source
  control and regenerated via `scripts/assets/generate-tray-icons.cjs`. Mapped
  into `process.resourcesPath/tray/` by `extraResources` for packaged builds;
  resolved repo-relative in `bun run dev` via the helper in
  `src/electron-main/tray/tray.ts` (`resolveTrayIconPath`). The build precheck
  `scripts/prepack/check-tray-assets.cjs` (`prepack:check-tray`) fails fast if
  any required variant is missing or corrupted, preventing an invisible-tray
  regression from shipping.

## Commands

```bash
bun run dev          # Launch gui-app dev server + Electron against it (this workspace only)
bun run build        # Build TS main + renderer + staged assets (no packaging)
bun run package      # Produce a packaged Electron binary via electron-builder
bun run package:dir  # Unpacked package (faster smoke-test)
bun run compile      # Type-check only (no emit)
```

### Dev loop: `make dev-desktop` (macOS / Linux)

For end-to-end work, the root `make dev-desktop` provisions a host and runs the
HMR Electron shell against the **production** cloud (this workspace's
`bun run dev` launches only the shell + renderer):

```bash
make dev-desktop                 # download + run against the LATEST released host
make dev-desktop VERSION=1.2.3   # pin a specific host release
```

This invokes `scripts/dev-desktop.js` at the repo root. The orchestrator stages a
dev CLI wrapper at `~/.traycer/cli/dev/bin/traycer` that exec's
`bun <repo>/clients/traycer-cli/src/index.ts "$@"`, then hands the host install
off to the CLI (which discovers the staged wrapper via the well-known
per-environment bin path):

```bash
traycer host install [--release <version>] --allow-self-invocation
```

The CLI **downloads the signed host from GitHub Releases**, verifies it against
the trust key committed in `clients/traycer-cli/src/config.ts`, stages the dev
install dir, writes `~/.traycer/host/dev/install/install.json`, registers the
`ai.traycer.host.dev` service (which invokes the staged wrapper with
`host start`), and starts the host. The Traycer Host is **not** built from source
in this repo - it is provisioned as a release binary.

After install, `concurrently` runs two foreground streams: the HMR Electron shell
(`bun run --cwd clients/desktop dev`) and a follower on
`~/.traycer/host/dev/host.log`. The clients talk to the **production** cloud
(`authn.traycer.ai`, `platform.traycer.ai`) and to the host over its localhost
WebSocket - there are no local backend services to run. The host is supervised by
the OS service manager (launchd / systemd-user), not a direct child of
`concurrently`; the `host` stream is a pure log follower.

Ctrl-C hands off to the CLI (`traycer host uninstall --all`): it stops the host,
deregisters the `ai.traycer.host.dev` service, and removes
`~/.traycer/host/dev/install/`. Your `~/.traycer/` user data (credentials,
config, epics, sqlite, logs) and any production host/CLI state are preserved.

The runtime ownership boundary is deliberate: Electron main owns shell state,
windows, tray, deep links, and secure token storage via `safeStorage`; the host
(external to this repo) is the only process that opens app-assets SQLite through
Prisma / `better-sqlite3`. Do not add Electron-specific native SQLite rebuilds or
custom binding-path environment variables to the desktop shell.

`make dev-desktop` uses `tail -F` (POSIX), so it targets macOS / Linux; the
packaged-app build (`bun run package`) remains cross-platform via
`electron-builder`.

## Release pipeline

Desktop releases (signed installers + update feeds) are built and signed in
Traycer's **internal** repository and published to this repo's
[Releases](../../releases) cross-repo; signing secrets never enter this repo. For
a local packaged build, use `bun run package` (unsigned) or `bun run package:dir`
(unpacked, faster smoke test).

> **CLI-resource precheck modes.** `prepack:check-cli` runs in two modes.
> `bun run --cwd clients/desktop package:dir` invokes it without
> `--platform`/`--arch`, so it runs in **host-lenient mode** - it only verifies
> the current host's `resources/cli/<platform>-<arch>/` triplet. The CI release
> pipeline passes explicit `--platform`/`--arch` flags so it runs in
> **matrix-strict mode**. If you run `package:dir` locally and CI later rejects
> the same tree, re-run with `--platform`/`--arch` to hit the stricter checks.

## Epic disk sync

When a user opens an epic in the GUI, the renderer subscribes with
`enableFileSync: true` and the host mirrors the epic's artifacts to disk:

```text
~/.traycer/epics/<epicId>/artifacts/<artifactId>/index.md
~/.traycer/epics/<epicId>/artifacts/<parent>/<child>/index.md
```

This on-disk layout is the host's contract (defined in the external
Traycer Host and consumed by its file watcher + system prompt; Desktop
only reads it). The folder name is the artifact's id (slug) on disk; folder
nesting expresses the parent-child relation. Frontmatter holds `title`, `kind`,
plus `status` and `assignee` for ticket/story kinds - internal metadata stays in
yjs. On open, yjs is the source of truth; the renderer's first sync overwrites
disk to match the cloud Y.Doc, then bidirectional propagation begins.

Background subscriptions (e.g. agent-only opens that pass `enableFileSync: false`
or omit the flag) never write to disk.

## Invariants

- Bundle output goes to `dist/`. The main process entry is `dist/main/index.js`.
- Desktop bundles only the Traycer CLI (`resources/cli/<platform>-<arch>/`), not
  a host binary. The CLI is resolved at runtime via `cli-discovery.ts`; the
  host is owned by the CLI under `~/.traycer/host/install/`.
- The tray icon is loaded from `process.resourcesPath/tray/` in packaged builds
  and from `<appPath>/resources/tray/` in development. `tray.ts` must never
  construct the `Tray` from `nativeImage.createEmpty()` - that path was removed
  because it produced an invisible system-tray entry on end-user machines.
- Preload must remain CommonJS and must only import from `src/ipc-contracts/`.
