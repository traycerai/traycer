# ADR 0001 — Browser tile rendering architecture

**Status:** Proposed (interview-derived; not yet ratified)
**Scope:** `clients/desktop` electron-main `browser-view/*`, `clients/gui-app` epic-canvas browser renderers
**Date:** 2026-08-21

---

## 1. Context

Browser tiles (user panes, agent durable tabs, screencast mirrors) are rendered by
main-process `WebContentsView`s owned by `BrowserViewManager`, positioned via IPC
bounds updates computed in the renderer (`useBrowserViewBoundsBridge`), with DOM
overlap handled by an occlusion system that hides the native view and paints a
cold-captured screenshot.

Two product-visible defects exist today:

1. **Resize overlap** — during a pane resize drag the bounds bridge *freezes*
   (`PANEL_RESIZING_CLASS_NAME` gate, `use-browser-view-bounds-bridge.ts:44-76`),
   so the native view keeps its pre-drag rect and paints over neighboring tiles
   until pointer-up forces a refresh.
2. **Occlusion staleness/latency** — popover/menu overlap triggers a cold
   pipeline (rAF scan → IPC → `capturePage` → base64 → paint) that takes
   hundreds of ms and freezes animated content into a stale frame.
3. **Keyboard loss** — renderer-registered bindings (command palette etc.) do
   not fire while a guest has focus.
4. **No hidden-guest eviction** — hidden panes live forever; the declared
   `releaseGraceMs` option is vestigial (never read).

### Superset comparison

Superset (in-app browser, studied at commit of 2026-08) uses renderer-side
Electron `<webview>` tags created imperatively by a module-level singleton
(`BrowserRuntimeRegistry`), parked under a `position:fixed; z-index:0`
body-level container and aligned to React-rendered placeholder rects via
ResizeObserver. Because the tags are ordinary DOM, resize follows live with no
freeze machinery and popovers simply stack above them with zero occlusion code.
Hidden guests are LRU-evicted past 3, rebuilt from persisted URL/title/favicon.

Their own documentation records the costs of that choice: hidden webviews
present no compositor frames (capture hangs → an "agent wake" un-hide system),
keystroke interception via `before-input-event` replay, drag-event swallowing,
a workspace-switch destruction race (documented postmortem plan), total guest
loss on host-renderer reload/crash, Electron-default security posture for
guests, and a shared cookie jar whose script-injection exposure they flag as
the real new risk.

## 2. Requirements (from architecture review interview)

| #  | Requirement                                                                 |
|----|-----------------------------------------------------------------------------|
| R1 | Resize/drag follows the handle **live**; ≤1-frame trail acceptable, measure-first |
| R2 | Occlusion must be **instant + crisp**; brief freeze of animated content tolerable |
| R3 | Opening an agent-created background tab as a tile must **adopt the same live guest** (no recreate-with-reload) |
| R4 | Guest state must survive host-renderer crashes and HMR (**prod-critical**) |
| R5 | True multi-window: simultaneous browser tiles across windows               |
| R6 | App chords win over guest keystrokes (reserved-chord interception)         |
| R7 | One shared persistent user cookie jar; agent partitions never see it; crypto-gated durability stays |
| R8 | Hidden guests LRU-capped (~3), agent-active exempt, silent reload on revisit |
| R9 | App chrome always paints above page content (no page-over-chrome case)     |
| R10| One visible surface per session at a time                                   |
| R11| Full three-platform parity (macOS/Linux/Windows release-blocking)           |
| R12| Clean replace on ship (no parallel-path flags); feature unreleased, schemas may grow additively |
| R13| Add an Electron-driver E2E suite covering native-paint behavior             |
| R14| Unify native + screencast pixel sources under one occlusion/frame story     |
| R15| Chrome-feature polish (context menu, find UI, downloads/certs UX) deferred behind this pass |

## 3. Decision

**Stay on main-process `WebContentsView`. Rebuild the interaction layer in place.**

Superset's architecture is better only at the two axes where we feel pain —
DOM-native z-order and free resize follow — and strictly worse at R3, R4, R6
enforcement, and the security surface of R7. Its simplicity was bought with
eviction state loss, capture-hang wake machinery, keystroke replay, a
destruction-race postmortem, and full guest loss on renderer reset. Our defects
are interaction-layer gaps (freeze heuristic, cold capture pipeline, missing
chord bridge, missing eviction), not consequences of guest ownership. Migrating
would trade fixable symptoms for structural losses.

### Alternatives considered

- **A. Full `<webview>` migration (superset parity).** Rejected: breaks R3
  (agent background tabs cannot re-parent into renderer tags without recreate),
  R4 (registry dies with its renderer), weakens R7 enforcement (guest policy
  fragments across renderers), imports their documented cost set.
- **B. Hybrid (tags for user tiles, headless views for agents).** Rejected:
  adoption across the seam degrades to capture-and-recreate exactly where R3 is
  load-bearing; two of every subsystem for marginal gain.
- **C. Status quo + point fixes only.** Rejected: leaves R6/R8 unserved and R2
  stale-prone; the freeze machinery would survive as permanent complexity.

## 4. Phased plan (each phase lands independently revertable)

### Phase 1 — Live bounds streaming (delete the freeze)

- `gui-app/src/components/epic-canvas/renderers/use-browser-view-bounds-bridge.ts`
  - Remove the `PANEL_RESIZING_CLASS_NAME` gate and its MutationObserver.
  - Keep ResizeObserver + window-resize sources; rAF-coalesce sends during
    gestures; keep updating the overlay rect registry every frame.
- `desktop/src/electron-main/browser-view/browser-view-manager.ts`
  - Coalesce `setBounds`: drop redundant identical rects; latest-wins under
    bursts; add perf stage logs (`kind:"bounds_stream"`) to the existing NDJSON lane.
- **Gate (R1 "measure first"):** prototype branch streams at display rate;
  measure trail/jank on all three platforms before choosing steady-state
  coalescing (display-rate vs 30–60fps mid-drag). Exact bounds always committed
  on gesture end. Delete the freeze path outright once green-lit (R12).

### Phase 2 — Live frame cache + unified occluder

- New `desktop/src/electron-main/browser-view/tile-frame-cache.ts`
  - `beginFrameSubscription` per visible entry; throttled ~10–15 fps; single
    latest-frame slot + timestamp; damage-skip identical frames; pause when
    hidden/occluded/dead; JPEG encode (quality ≈80) bounded by max dimension.
- Manager wiring
  - Start/stop subscriptions on visibility transitions.
  - Rewrite `occludeEntryForOverlay` internals to serve cached frames instead
    of cold `capturePage` (cold capture remains fallback for empty cache).
    While an occlusion is active, push refreshed frames at throttle rate so
    long-lived menus converge toward fresh.
  - **No IPC contract change**: `occludeForOverlay` keeps its result shape
    (`snapshots[].dataUrl`) — additive evolution only, honoring R12.
- Renderer
  - `lib/browser-view/browser-overlay-coordinator.ts` + `components/epic-canvas/browser-overlay-coordinator.tsx`:
    snapshot store unchanged (`set/markStale/clear`); detection loop unchanged.
  - Screencast tiles (`browser-session-tile`, `browser-peek-tile`) register
    their last stream frame as a self-supplied source behind the same store API
    (R14). DOM-mirror tiles need no hiding; registration reserves the seam.
- On-demand `capturePage` stays only for annotations and composer context chips.

### Phase 3 — Reserved-chord keyboard bridge

- New `desktop/src/ipc-contracts/reserved-chords.ts`: plain-data chord
  descriptors; single source of truth for renderer bindings and main matching.
- Main: attach `before-input-event` on every guest `webContents`; match
  normalized accelerators against the reserved set; on match `event.preventDefault()`
  and forward via `sendInputEvent` to the owning window's host `webContents`.
  Menu-accelerator chords keep working unchanged.
- Renderer: keybinding provider registers palette/app chords through a preload
  bridge call at startup (idempotent).
- Non-goals: IME/dead-key forwarding beyond the exact reserved set (manual CJK
  test pass instead).

### Phase 4 — Hidden-guest LRU eviction

- Manager: group eviction by webContents identity (`entriesByRuntimeKey`),
  MRU on last-visible transition, cap 3 hidden guests per manager instance,
  deferred macrotask sweep so detach→attach pairs re-adopt before counting.
- Exemptions: active control grant, debug session, PiP capture, annotation
  session, unreleased agent posture.
- Before evicting: capture `{url, title, favicon}` (status events already feed
  stores); reuse the sibling-handoff claim pattern to avoid races with durable
  tab teardown. Revisit recreates lazily via the background-tab priming path;
  tile chrome shows loading skeleton with correct title/favicon (silent reload).
- Implement or delete the vestigial `releaseGraceMs` option.

### Phase 5 — E2E suite (R13, R11)

- Playwright `_electron` driver smoke under `clients/desktop/e2e/`:
  1. Tile open → mid-drag bounds delta within threshold of DOM rect.
  2. Popover-overlap snapshot latency < budget; freshness proven by content
     hash change across repeated overlaps over animated content.
  3. ⌘K opens palette while guest focused; non-reserved chords reach the page.
  4. LRU cap enforcement + agent-active exemption + silent-reload revisit.
  5. Two windows, one tile each, simultaneous correct bounds.
- CI: linux+macos required, windows periodic; mirrors `host-tests.yaml` shape.

### Deferred queue (explicitly out of this pass, R15)

Native-feel context menu inside tiles; find-in-page UI parity; downloads and
certificate-error UX integration. The Phase 2 seam must not preclude them.

## 5. Risks

- **Frame-cache CPU/memory on many visible tiles** → throttling, damage skip,
  pause rules, per-tile single-slot storage; measured in the E2E perf scenario.
- **Resize streaming jank on low-end Windows** → adaptive mid-drag coalescing
  decided by the Phase 1 measurement gate, not assumed.
- **Chord forwarding fidelity** → restrict to exact reserved set; everything
  else passes natively; manual IME verification.
- **Eviction vs durable-tab races** → reuse sibling-handoff claim semantics.
- **Multi-window leakage** → occlusion scans are per-window documents; manager
  is windowId-keyed; covered by E2E scenario 5.

## 6. Decision log (interview record)

Origin incidental (not security-driven) · live-follow resize target · instant +
crisp occlusion · live adoption required · crash resilience prod-critical ·
correct > fast, unreleased feature, additive schemas · chrome-above-page always ·
single visible surface per session · true multi-window · app chords win ·
shared user jar, agents isolated · LRU ~3 with silent reload · full platform
parity · clean replace, no fallback flags · add E2E · unify screencast pixel
source · chrome-feature polish deferred · deliverable = this ADR.
