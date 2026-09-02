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

One scoped, sunsetted exception: the v1.2.0 `host.*` maintenance projections
in `host-management-ipc.ts` ("The maintenance-RPC projections") answer four
protocol response shapes from main for a LOCAL host too old to serve them
(negotiated away at handshake). Nothing is proxied — there is no host wire
surface to forward to; main is the _origin_, because only main can shell the
bundled CLI and read the on-disk install records the answers come from. The
block comment there carries the full rationale; delete the lane when the
fleet floor reaches 1.2.0.

A second, permanent exception: the **`browser.sessions` stream is main's**
(browser-security-hardening H10). Main opens it, answers every cookie-bearing
frame on it, and forwards only the opaque UX projection to the renderer over
`browserViewSessions*`. This is not transport proxying for its own sake - it is
the whole point. That stream carries the master cookie jar: capture answers,
seeded storage state, the store-key handshake, the forget ledger and its ack.
A renderer that can read those frames is a fully trusted principal over every
login on the machine, which is what root cause C of
`specs/browser-security-review.md` found it to be; after H10 no cookie value
exists in a renderer process at all. `gui-app` still talks to the host directly
for everything else, including every other browser RPC.

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
- **Keyboard input while a native browser tile has focus is ONE declarative
  policy, not a pile of accidents.** With a `WebContentsView` guest focused,
  keys go guest `before-input-event` → macOS app-menu accelerator → the page;
  the app renderer's keybinding registry is never in the chain. So a menu item
  with a custom `click` is focus-BLIND (Cmd+W once closed the app's task tab
  over a focused browser), and a renderer-only chord is silently swallowed.
  Every chord that must still mean something in that state lives in
  `clients/gui-app/src/lib/browser-view/reserved-chords-registration.ts` and
  nowhere else; the renderer pushes that table to main, which decides in the
  guest seam (`browser-view-entry-factory.ts` → `browser-view-chords.ts`) and
  always `preventDefault`s so the menu equivalent cannot double-fire. Two
  dispositions: browser-scoped (main names a tile command back to the focused
  tile - Cmd+W/T/L) and app-forwarded (main replays the keystroke into the host
  renderer - Cmd+K, ⇧⌘W, ⌘/⇧⌘ brackets). Adding a chord means adding a row
  there; do not add a focus check to a menu item instead. Electron ROLE items
  (reload, cut/copy/paste, select-all) already act on the focused web contents
  and are correct as they are - leave them alone.
- **Browser-tile occlusion coordinator invariants** (`docs/adr/0001-browser-tile-rendering.md`,
  `browser-view-overlay.ts`). Both swap edges are two-phase and pixel-atomic:
  hide waits for the entry paint-ack before parking; restore keeps the stand-in
  mounted until the un-parked view's first composited frame (the restore ack,
  same shape as `paintAck`, with a frame-budget liveness escape for a view
  that never delivers one). The stand-in's pixel source is `capturePage`,
  gated by paint-ack; the rolling frame cache (`tile-frame-cache.ts`) is only
  the deadline fallback, never the primary source. A tile must never be
  un-parked while any registered rect still intersects it, including across
  ownership handoff between two overlays - occlude before release, always.
- **Login import** (`electron-main/browser-view/storage/login-import/`)
  reads other browsers' cookie jars on this machine into the durable
  `persist:traycer-browser` partition. Every reader is a pure function over
  bytes plus an injected secret provider, so the suites run on fixtures and
  never touch a keystore. Three rules are load-bearing: the SCAN never opens
  a keystore (the only OS prompt fires on Import, after the dialog has said
  which one); every failure is a RESULT VALUE with a closed reason, because
  a rejected invoke's message reaches the WARN log and Sentry and a cookie,
  a profile path, or a keychain's answer must never travel that way (the
  service logs an errno code and a stage, nothing else); and the import runs
  under the `BrowserJarSerializer`'s whole-jar barrier FROM THE KEYSTORE
  PROMPT ON (the one forget-all takes, so a forget confirmed while the
  prompt is up or the write is running queues behind it instead of clearing
  the jar, reporting done, and having the import write the logins back - and
  a queued barrier whose own budget runs out while it waits GIVES UP, its
  action never runs, so that forget fails and is retried after the import
  rather than emptying the jar late under no barrier; the import passes its
  own 10-minute budget, and reads the barrier's abort signal between rows so
  an import the barrier gives up on STOPS before the queued work is
  admitted) and, inside that, under
  `suppressAllBrowserPrimaryProfileDeltas` plus one coalescing window -
  held through the failure path too - because the per-site removals would
  otherwise reach the host as `removedKeys` and evict the site from every
  live session. That mute also skips the observer's `onLocalCookieWrite`,
  so the import hands the desktop ownership of the keys it wrote by hand
  (`releaseHeadlessOriginCookieKeys`) - in a `finally`, so an import a row
  or the barrier's abort ended still releases every key it DID write, and
  still inside the barrier, after the mute lifts, or a merge queued behind
  the barrier could observe an older value back over the import the moment
  the gate opens. A scan answers with its own opaque `scanId` and the
  import must quote it: two Settings windows scanning one source each keep
  their scan (up to a small retained set), and each import is checked
  against the list ITS window rendered. The Import click may open only a
  keystore that scan announced for some chosen site; a source that gained
  an encrypted row since answers `source-changed` and drops that scan. A
  site is written BEFORE anything of it is removed: the source's cookies go
  in first, and only a site with at least one written cookie has what the
  source did not CARRY removed after - keyed by the source's rows, not by
  what was written, so a row that fails to decrypt or to set leaves the
  jar's cookie at that key alone, and a kept cookie that a same-name
  removal reached anyway is put back from the pre-write listing - so a
  source whose every row Electron rejects leaves the jar's slice as it was.
  A written site's localStorage goes too (`clearBrowserSiteLocalStorage`
  plus the coordinator's prune, the same pair the site clear runs, over
  `clearableOrigins()`, which names an origin whose read is still in flight
  as well): the source carries cookies only, and a site that keeps account
  state in localStorage would otherwise run the previous identity on the
  imported cookies. The import is CONFIRMED IN MAIN like a site clear and
  forget-all (`confirmDestructiveInMain`, naming the registered source and
  the validated site count) before anything is read: a compromised renderer
  can list, scan and import every site a profile holds, and a plaintext
  import raises no other prompt; a declined dialog answers `cancelled` and
  the Choose step stays.
  A decrypted value exists only between the `readValue` inside that write
  loop and the `cookies.set` it feeds, never in a list; an imported SESSION
  cookie is given a bounded expiry, since a `persist:` partition drops one
  without at quit. SQLite snapshots are copied with the source's size and
  mtime checked before and after (a moving source retries, then reads as
  `locked`), live under a `0700` userData directory and are unlinked the
  moment they are open on POSIX. `node:sqlite` is the reader:
  it ships with Electron's Node and needs no native module, which is why the
  "no Electron-native SQLite" rule below is about REBUILDS, not the builtin.
  Because that suppression means no delta reaches a host on its own, the
  import handler pushes the jar itself — `capturePrimaryProfileOnEveryHost()`
  on the sessions registry, beside `forgetLoginsOnEveryHost()` and for the
  same reason: a jar frame is main's to send, never a renderer's.
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
