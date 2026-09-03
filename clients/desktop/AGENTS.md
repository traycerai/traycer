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
  service logs an errno code and a stage, nothing else; every file the
  import buffers - a picked export, Safari's jar, `Local State`,
  `profiles.ini` - goes through `readBoundedFile`, which opens the path
  non-blocking (so a FIFO cannot hold the open) and then, on the HANDLE and
  never on the path beforehand, refuses anything that is not a regular file
  (`not-a-file`), a regular file over `MAX_LOGIN_IMPORT_FILE_BYTES`
  (`too-large`, which the import answers as `file-too-large`) and one whose
  size or mtime moved under the read (`unreadable`: a complete prefix of an
  export is still a valid export), since the picker offers "All files"; a
  `Local State` `info_cache` key is
  joined under User Data only if it is a plain directory name; and the
  Windows DPAPI provider spawns PowerShell by its absolute System32 path,
  never a name `PATH` resolves); and the import runs under the
  `BrowserJarSerializer`'s
  whole-jar barrier FROM THE USER'S CONFIRMATION ON - the source read, the
  keystore prompt and the write all inside it (the barrier forget-all takes,
  so a forget confirmed after the import's "Import" - while the jar is being
  read, the prompt is up or the write is running - queues behind it instead
  of clearing the jar, reporting done, and having the import write the
  logins back; the read is inside because a large jar takes seconds to copy
  and parse, which is the same window as the prompt, only shorter - and
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
  source did not CARRY removed after - keyed by EVERY source row for the
  site, not by what was written, so a row that fails to decrypt or to set,
  or that the reader never opens (an app-bound `v20` row, a partitioned
  one), leaves the jar's cookie at that key alone; one step wider, BY NAME,
  a source row that did not land - or was never opened - and whose name no
  landed row shares leaves the jar's cookies of that name alone under any
  scope (the host-only `sid`
  beside the source's failed domain `sid` is the sign-in that row would have
  replaced); and a kept cookie that a same-name removal reached anyway is
  put back from the pre-write listing - every prior cookie of a name whose
  re-write was refused with no landed row left of that name, carried or
  not, and every reached cookie at all when NO written row survived its
  re-write, which also uncounts the site and skips its localStorage clear -
  so a source whose every row Electron rejects, on the first write or the
  re-write, leaves the jar's slice as it was. Those recovery passes run
  whatever ended the removals - a `remove` Electron rejected, the barrier
  giving up between two - over every name a removal REACHED, and only then
  is the failure thrown; they read no abort signal, since the serializer
  holds the gate through the action's settlement and a site left
  half-removed is a sign-out.
  A written site's localStorage goes too (`clearBrowserSiteLocalStorage`
  plus the coordinator's prune, the same pair the site clear runs, over
  `clearableOrigins()`, which names an origin whose read is still in flight
  as well, re-enumerated until nothing new turns up and reading the
  barrier's signal between origins so a tile that keeps landing on new
  origins cannot hold an expired import past its gate): the source carries
  cookies only, and a site that keeps account state in localStorage would
  otherwise run the previous identity on the imported cookies. Before the
  first cookie a site REMOVES - and not at all for a site that removes
  nothing, nor for one the write never REACHES, since a host away for the
  import would prune a site this machine still holds whole and lose a
  login only it had - THAT site is recorded in the FORGET LEDGER under its
  own revision (`recordForgottenBrowserSites([site])`, per site, never the
  batch up front) - the entry a site clear records, for its two effects: a
  host prunes the site and then takes the capture pushed after the write,
  so a host away for the import still ends with the source's slice rather
  than a union; and until a host has acked that revision its observations
  for the site are refused, since an observation of a cookie the import
  REMOVED would find the name free in the jar and put it straight back for
  the next capture to sync everywhere (the written keys' release covers
  only what the import wrote). The streams are told ONCE, when the write
  ends and before the push (`deferBrowserForgetLedgerNotifications` holds
  the per-record digest edge; the records themselves land in memory and on
  disk as they are made), and the ledger's local side is marked cleared for
  every revision together (`markBrowserForgetLedgerClearedMany`) once the
  writes have ended, however they ended. That deferral is process-wide, so
  a Clear site or Forget all confirmed in another window during the import
  rides the same digest - which is fine, because prune-then-capture is
  kept by the CAPTURE, not by the digest's timing: every whole-jar capture
  is read as the ledger says the jar will be (`withoutUnclearedForgets`
  over `browserForgetLedgerUnclearedForgets()`, applied on both capture
  lanes in `browser-view-ipc.ts`), with an uncleared site's cookies and
  origins left out and nothing at all under an uncleared forget-all. The
  forget recorded its revision before queueing its clear behind the
  import's barrier, and the import's own push reads from INSIDE that
  barrier, so without the filter the push would re-teach every host the
  site it had just pruned - deferred digest or not, since the push follows
  the digest either way; an import of more sites than the
  ledger keeps at once
  (`BROWSER_FORGET_LEDGER_MAX_DOMAINS`) is refused as `too-many-sites`
  before the keystore is opened, since a trimmed scope never reaches a
  host's digest. A row refused on its re-write leaves `writtenKeys` too, so
  the desktop takes no ownership of the prior cookie the restore puts back;
  the jar is pushed once anything of the import's is in it OR the ledger has
  told the hosts to prune, even a site the write then put back as it was. A write that ends early AFTER a cookie has reached the jar -
  the barrier's budget, a refused removal, a failed localStorage clear, a
  `flushStore` that rejects - is
  answered `incomplete`, not `unreadable`: what landed is kept, counted (per
  row, so a site stopped mid-way counts what it has) and pushed, and Import
  again finishes the rest; only a write that put nothing in the jar answers
  with what stopped it. The serializer keeps that answer reachable: a
  barrier whose timer fires MID-ACTION aborts the signal and then waits,
  within its settle grace, for the action to settle, answering the caller
  with the action's own result - only a barrier still waiting for the work
  ahead, or an action that has not settled by the end of the grace (the
  wedge the timer exists for), is answered with the expiry. The import is
  CONFIRMED IN MAIN like a site clear and
  forget-all (`confirmDestructiveInMain`, naming the registered source and
  the validated site count) before anything is read: a compromised renderer
  can list, scan and import every site a profile holds, and a plaintext
  import raises no other prompt; a declined dialog answers `cancelled` and
  the Choose step stays. The saved-logins pref is re-read INSIDE the
  import's barrier, first thing, before the source is read, and the pref
  flip itself takes the same barrier (the pref only, not the tab recreation
  after it), so a window turning saving off while the import sits on the
  confirmation cannot have the durable jar written where nothing reads it,
  and one that did turn it off costs no read and no prompt.
  The site's localStorage is cleared LAST, after the cookie recovery, so a
  clear that fails leaves the cookie slice whole.
  A decrypted value exists only between the `readValue` inside that write
  loop and the `cookies.set` it feeds, never in a list; an imported SESSION
  cookie is given a bounded expiry, since a `persist:` partition drops one
  without at quit. SQLite snapshots are copied with the source's size and
  mtime checked before and after (a moving source retries, then reads as
  `locked`), refused by size before a byte is copied (main file plus WAL
  over `MAX_SQLITE_SNAPSHOT_BYTES`) AND capped during the copy (a streamed
  `copySqliteFileBounded` under one per-attempt budget across the three
  files, one byte past it being the signal, so a source that grows between
  the size check and its copy cannot be followed past the bound) and by
  row count before a row is
  selected (`assertRowBudget`, many times any browser's cookie ceiling) -
  both `profile-too-large`, with an explainer that names the browser's
  own jar rather than a picked file - live under a `0700` userData
  directory and are unlinked the moment they are open on POSIX.
  `node:sqlite` is the reader:
  it ships with Electron's Node and needs no native module, which is why the
  "no Electron-native SQLite" rule below is about REBUILDS, not the builtin.
  Because that suppression means no delta reaches a host on its own, the
  import pushes the jar itself — `capturePrimaryProfileOnEveryHost()`
  on the sessions registry, beside `forgetLoginsOnEveryHost()` and for the
  same reason: a jar frame is main's to send, never a renderer's — and
  pushes it INSIDE its barrier, after the mute lifts and the written keys
  are released, because a saved-logins toggle queued behind the import
  would otherwise run first and move the capture's session to the ephemeral
  jar. A HOST-issued one-off capture reads behind any whole-jar barrier AND
  holds the serializer's read lease through its read
  (`BrowserJarSerializer.readBehindBarrier`: the gate captured and the read
  registered synchronously, the `runOnDomain` shape, so a barrier requested
  after the call waits behind the read rather than writing under it), so a
  host never takes a jar with some sites imported and some not. The FINAL
  capture at a window's close or at quit reads the same way, for at most
  its flush budget (`FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS`, ONE deadline
  over the barrier wait, the read and the ack - the ack gets what the
  barrier left, never a fresh budget): a barrier still held past it skips
  the capture rather
  than shipping a hybrid the close would make permanent, the import's own
  push inside its barrier being the capture of record - and it takes the
  direct path, not `capturePrimaryProfileNow`'s lane, since the import's
  push takes that lane from inside its barrier and a final capture queued
  ahead of it there would have the push wait on a capture that waits on
  the push. Main's own push does not wait, the import's being the barrier
  holder. That capture is four-state per
  stream (`acked` / `unacked` / `sent-no-jar` / `not-sent`), and `not-sent`
  is decided AFTER the asynchronous jar read: a frame the stream could not
  send (it closed underneath the read) or that quotes a standing id the host
  has since re-issued never left, so the registry tries the host's sibling
  stream; a frame that left with no jar in it (the read failed, the jar was
  unavailable) is `sent-no-jar`, its ack awaited for the slot order but
  counting for no host; only a frame that left WITH the jar and drew no ack
  is `unacked`. The ack budget starts when the frame leaves, and acks are
  attributed in SEND order under the standing id (the host acks every
  captured frame it receives, once, in order): a frame whose budget ran out
  keeps its slot until its late ack absorbs it, so that ack cannot satisfy
  the next capture's slot and count a host that never acked THAT jar.
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
