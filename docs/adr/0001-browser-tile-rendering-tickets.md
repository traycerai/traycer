# ADR 0001 — Implementation tickets

Companion to [0001-browser-tile-rendering.md](0001-browser-tile-rendering.md).
Requirement refs (R1–R15) point at that document's table. Each ticket lands
independently revertable; phases order only where dependencies say so.

Sequencing rule from the interview: **clean replace on ship (R12)** — no
runtime fallback flags; "prototype/gate" tickets are internal measurement
vehicles whose scaffolding is deleted before merge.

---

## Implementation status (post-implementation, pre-verification)

All code tickets implemented on branch `feat/browser-tile-runtime`
(submodule) / same-named internal branch. **Nothing is committed** pending
manual verification. Test state at authoring time:

| Suite                                                   | Result                                                  |
| ------------------------------------------------------- | ------------------------------------------------------- |
| desktop browser-view + ipc-contracts + agent ipc        | 304/304                                                 |
| gui-app browser renderers + lib/browser-view (targeted) | 175/175                                                 |
| desktop `tsc --noEmit` error set                        | identical to base branch (pre-existing only)            |
| gui-app full canvas run                                 | 26 failing — byte-identical failure list to base branch |

Known environment blocker (not code): `agent-browser-partition.test.ts`
spawns real Electron and fails in fresh worktrees until the SUID sandbox
helper is fixed:

```bash
sudo chown root:root traycer/node_modules/.bun/electron@42.9.1/*/electron/dist/chrome-sandbox
sudo chmod 4755   traycer/node_modules/.bun/electron@42.9.1/*/electron/dist/chrome-sandbox
```

### Manual verification owed before commit

1. **BT-103 measurement gate** — drag-resize a video-playing tile on each of
   macOS/Linux/Windows; record trail/jank; tune `use-browser-view-bounds-bridge`
   coalescing only if display-rate streaming janks (thresholds live in the
   hook's rAF path; main-side coalescing already drops redundant rects).
2. **BT-304 IME/dead-key pass** — CJK composition + dead keys inside a
   focused tile on all three platforms; confirm reserved-chord forwarding
   never intercepts non-reserved keys (`reserved-chords.ts` refuses chords we
   cannot replay).
3. **Keyboard smoke** — ⌘K/Ctrl+K opens the palette while a tile is focused;
   typing in a page search box still works; zoom shortcuts unchanged.
4. **Eviction smoke** — open 4 tiles, hide them, confirm the oldest closes
   (log: `evicting hidden guests`) and revisit silently reloads with correct
   title/favicon.
5. **Occlusion feel** — popovers over tiles should paint instantly from the
   frame cache (no blank flash); long-lived menus keep converging toward
   fresh content (view parks offscreen-visible instead of hiding).
6. **BT-50x first live run** — follow `clients/desktop/e2e/README.md`: add
   `@playwright/test` at the ROOT, replace placeholder testids, wire CI.

Per-ticket deltas below are as designed; deviations found during the manual
pass should be recorded inline.

---

## Phase 1 — Live bounds streaming

### BT-101 · Main-side bounds coalescing + perf marks · M

Main-process prep so renderer streaming has something cheap to hit.

- **Files:** `clients/desktop/src/electron-main/browser-view/browser-view-manager.ts` (`applyEntryBounds` / setBounds path)
- **Tasks:**
  - Latest-wins coalescing under bursts; skip identical rects (DIP-rounded compare).
  - Perf stage logs on the existing NDJSON lane: `kind:"bounds_stream"` with rect deltas + call rate.
  - Unit tests in the `browser-view-manager.test.ts` harness style.
- **Accepts:** burst of N updates → ≤N setsBounds, no duplicate-rect sets; logs observable in dev run.
- **Depends:** nothing.

### BT-102 · Stream bounds during gestures; stop freezing · M

The actual fix for the overlap bug.

- **Files:** `clients/gui-app/src/components/epic-canvas/renderers/use-browser-view-bounds-bridge.ts`
- **Tasks:**
  - Delete the `PANEL_RESIZING_CLASS_NAME` freeze branch + its MutationObserver.
  - Keep RO/window-resize sources; rAF-coalesce sends mid-gesture; keep
    `updateBrowserOverlayTileRect` fresh every frame (occlusion correctness).
  - Exact commit on gesture end (final force-send retained).
- **Accepts:** resizing a pane never lets the native view overlap a neighbor at
  any sampled frame; unit test simulates frozen-class removal path gone.
- **Depends:** BT-101.

### BT-103 · Measurement gate: trail/jank report, pick steady-state rate · S (gate)

R1 said measure-first; this is the decision vehicle.

- **Tasks:**
  - Dev build streams at display rate; record trail (ms between handle move
    and view settle) + main-thread jank on macOS/Linux/Windows, incl. one
    heavy page (video) and one light page.
  - Output: short written verdict choosing display-rate vs 30–60fps mid-drag
    coalescing; fold chosen thresholds into BT-102 constants.
- **Accepts:** numbers exist per platform; threshold constant committed; probe
  scaffolding deleted (R12).
- **Depends:** BT-102 (branch).

---

## Phase 2 — Live frame cache + unified occluder

### BT-201 · `tile-frame-cache` module · M

New main-process subsystem; no consumers yet.

- **Files:** new `clients/desktop/src/electron-main/browser-view/tile-frame-cache.ts`
- **Tasks:**
  - `beginFrameSubscription` per entry: ~10–15 fps throttle, single latest-frame
    slot + timestamp, damage-skip identical frames, JPEG q≈80, max-dimension bound.
  - Pause rules: hidden / already-occluded / dead entries unsubscribe.
  - Full vitest coverage with fake subscription sources (repo type-safety rules apply).
- **Accepts:** frame delivery rate capped; paused states verified; memory bounded
  to one slot per entry.
- **Depends:** nothing.

### BT-202 · Manager wiring: occlusion serves cached frames · M

Kills the cold pipeline.

- **Files:** `browser-view-manager.ts` (`ensureDebugSession`-adjacent lifecycle, `occludeEntryForOverlay`)
- **Tasks:**
  - Start/stop subscriptions on visibility transitions.
  - `occludeForOverlay` returns cached frame (dataUrl shape unchanged); cold
    `capturePage` only as empty-cache fallback; refresh pushes at throttle rate
    while occlusion active.
  - Existing suite green without contract change (additive only, R12).
- **Accepts:** overlap snapshot latency < 1 IPC hop + decode (no capture);
  stale flag still propagates via `onSnapshotInvalidated`.
- **Depends:** BT-201.

### BT-203 · Renderer occluder consumption audit · S

- **Files:** `lib/browser-view/browser-overlay-coordinator.ts`, `components/epic-canvas/browser-overlay-coordinator.tsx`, `use-browser-view-snapshot.ts`
- **Tasks:** verify snapshot store semantics against new latency profile
  (stale-mark timing, clear-on-release); drop any cold-capture-era tuning;
  tests updated where they encode old timing assumptions.
- **Accepts:** coordinator suites green; no behavior change beyond freshness.
- **Depends:** BT-202.

### BT-204 · Screencast tiles register as self-supplied frame sources (R14) · S

- **Files:** `renderers/browser-session-tile.tsx`, `renderers/browser-peek-tile.tsx`, small adapter in `lib/browser-view/browser-overlay-coordinator.ts`
- **Tasks:** last stream frame registers into the shared store API; DOM-mirror
  tiles need no hiding today — registration reserves the seam for unified
  occlusion later.
- **Accepts:** screencast tile overlapping a native tile triggers correct
  occlusion of the NATIVE side only; mirror untouched.
- **Depends:** BT-203.

### BT-205 · Cache instrumentation + caps · S

- **Tasks:** counters (entries, pause reasons, encode ms, slot bytes) onto the
  NDJSON lane; hard cap on concurrent subscriptions with documented eviction of
  lowest-priority (non-focused) caches.
- **Accepts:** limits provable in test; counters visible in dev run.
- **Depends:** BT-202.

---

## Phase 3 — Reserved-chord keyboard bridge

### BT-301 · Reserved-chord contract module · S

- **Files:** new `clients/desktop/src/ipc-contracts/reserved-chords.ts`
- **Tasks:** plain-data chord descriptors (key + modifier mask), accelerator
  normalization helper shared by both sides; consumed later by renderer
  keybinding provider and main matcher. No Electron imports (preload boundary).
- **Accepts:** normalization unit tests (order, case, dual-modifier forms).
- **Depends:** nothing.

### BT-302 · Main intercept + forward · M

- **Files:** `browser-view-manager.ts` (entry creation), possibly new `guest-key-forwarder.ts`
- **Tasks:**
  - `before-input-event` on guest webContents; match normalized chord set;
    `preventDefault` + replay into owning window's host webContents via
    `sendInputEvent`. Menu accelerators unaffected (already win).
  - Matcher unit tests; forwarding covered in E2E pack B (BT-503).
- **Accepts:** ⌘K/Ctrl+K fires palette with guest focused; unreserved keys reach page.
- **Depends:** BT-301.

### BT-303 · Renderer registration bridge · S

- **Files:** gui-app keybinding provider + desktop preload bridge channel
- **Tasks:** idempotent startup call registering current binding set as
  reserved chords; HMR-safe (re-register replaces, never duplicates).
- **Accepts:** re-register after HMR keeps exactly one authoritative set.
- **Depends:** BT-301, BT-302.

### BT-304 · IME/dead-key manual pass · S (manual QA)

- **Tasks:** CJK IME composition, dead keys, browser-reserved combos (⌘L etc.)
  verified untouched across all three platforms; results appended to ADR log.
- **Depends:** BT-302.

---

## Phase 4 — Hidden-guest LRU eviction

### BT-401 · Hidden tracking, MRU sweep, cap enforcement · M

- **Files:** `browser-view-manager.ts`
- **Tasks:**
  - Group by webContents identity (`entriesByRuntimeKey`); bump last-visible on transitions.
  - Cap 3 hidden guests per manager instance; deferred macrotask sweep so
    detach→attach pairs re-adopt before counting (superset's ordering lesson).
  - Implement or delete vestigial `releaseGraceMs`.
- **Accepts:** 5th hidden guest evicts oldest; switch-storm doesn't evict the just-hidden pane.
- **Depends:** nothing.

### BT-402 · Exemption registry · S

- **Files:** `browser-view-manager.ts` + hooks off debug session / control grants / PiP / annotation session / agent posture release flag
- **Tasks:** single predicate consulted by the sweep; agent-active panes survive.
- **Accepts:** each exempt state proven to block eviction in unit tests.
- **Depends:** BT-401.

### BT-403 · Capture-before-evict + silent reload revisit · M

- **Files:** manager (eviction path + background-tab priming reuse), gui-app tile chrome (`browser-tile-status-panels.tsx`)
- **Tasks:**
  - Persist `{url,title,favicon}` before destroy using the sibling-handoff claim
    pattern (race-safe vs durable-tab teardown).
  - Revisit recreates lazily via priming path; skeleton shows loading with
    persisted title/favicon (silent reload, no interstitial).
- **Accepts:** evicted→revisit restores URL; chrome never flashes stale title; claim race test added.
- **Depends:** BT-401, BT-402.

---

## Phase 5 — E2E suite (R13, R11)

### BT-501 · Harness scaffold + CI wiring · M

- **Files:** new `clients/desktop/e2e/`; CI workflow mirroring `host-tests.yaml` shape (internal repo)
- **Tasks:** Playwright `_electron` driver against packaged dev shell; linux+macos
  required, windows periodic job; fixtures for a local static site.
- **Accepts:** one trivial smoke green in CI on both required platforms.
- **Depends:** nothing.

### BT-502 · Pack A: resize + occlusion scenarios · M

- **Scenarios:** mid-drag bounds delta within threshold of DOM rect; popover
  overlap snapshot latency budget; content-hash freshness over animated page;
  release restores live view.
- **Depends:** BT-102, BT-202, BT-501.

### BT-503 · Pack B: keyboard scenarios · S

- **Scenarios:** reserved chord opens palette with guest focused; unreserved
  chord reaches page; menu accelerators still fire; HMR re-registration safe.
- **Depends:** BT-302, BT-303, BT-501.

### BT-504 · Pack C: eviction + multi-window scenarios · M

- **Scenarios:** cap enforcement, agent-active exemption, silent-reload revisit,
  two windows × one tile simultaneous bounds correctness.
- **Depends:** BT-401–BT-403, BT-501.

---

## Deferred backlog (out of scope by decision, R15)

Design seam only — must remain possible after Phases 1–2:

- Native-feel in-tile context menu (main-side menu, open-as-new-tile, inspect).
- Find-in-page UI parity (match count, highlight nav, ⌘F focus routing).
- Downloads/certificate-error UX integration replacing default-Electron flows.

## Dependency sketch

```
BT-101 ── BT-102 ── (BT-103 gate)
BT-201 ── BT-202 ── BT-203 ── BT-204
                 └─ BT-205
BT-301 ── BT-302 ── BT-303        (BT-304 manual)
BT-401 ── BT-402 ── BT-403
BT-501 ── {BT-502, BT-503, BT-504}   (packs wait on their phases)
```

Phases 1–4 are mutually independent; only the E2E packs serialize behind them.
