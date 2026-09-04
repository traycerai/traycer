# ADR 0001 — Browser tile rendering architecture

Status: accepted, 2026-09-02.
Companion: [0001-browser-tile-rendering-tickets.md](0001-browser-tile-rendering-tickets.md) cites these requirement ids as `R<n>`.
Source spec: `specs/browser-overlay-coexistence/browser-overlay-coexistence.md` (internal repo).

## Context

A browser tile on the canvas is a native Electron `WebContentsView`, not a DOM iframe.
The canvas also renders DOM overlays on top of tiles: dialogs, popovers, selects, dropdown menus, tooltips, context menus, toasts.
This document is the decision record for how those two rendering worlds coexist, and the numbered requirements that later tickets and code comments cite.

## Physics and foundation

A `WebContentsView` composites above all renderer DOM.
No z-index interleaving exists between a native view and the DOM tree it sits over; this is Electron's compositing model, not a bug (`electron#15899`, closed not-planned).
A native view also has no clip primitive: `setBounds` is placement, not a crop, so a partially clipped tile reflows to the smaller viewport rather than showing a cropped page.

Two alternatives were considered and rejected.

**OSR shared-texture.**
Off-screen rendering into a shared GPU texture would let a tile become an ordinary DOM-composited element.
Rendering itself is viable on the pinned Electron 42.
Rejected anyway: IME composition has no path (`GetTextInputClient()` returns null), the accessibility tree is not exposed, cursor updates and focus semantics are architecturally absent, the API is experimental, and no shipping product renders a browser this way.
Half of the problem (pixels) being solvable does not make the whole solvable.

**Transparent overlay-`WebContentsView` for popovers.**
Moving popovers into their own native view above the tile was considered as a way to sidestep compositing order entirely.
Rejected: Radix portals live in the main renderer's React tree.
Moving that tree's rendered output into a second `webContents` breaks React state, context, and styling — a portal cannot leave the renderer it was mounted in.

**Decision: the native `WebContentsView` stays the primary local plane.**
Coexistence is solved by an occlusion coordinator that swaps the native view for a frozen stand-in whenever a DOM overlay would otherwise be invisibly covered by it, not by changing how the tile renders.

## Occlusion coordinator design

- **Explicit registry, not a selector scan.**
  Mounting an overlay primitive (dialog, popover, select, dropdown menu, tooltip, context menu, toast) registers a live rect; unmounting deregisters.
  The shadcn wrappers in `src/components/ui/` are the only registration seam — feature code gets registration for free by using them, never by importing a Radix portal primitive directly.
- **Paint-signals-only predicate.**
  The visibility predicate reads `hidden`, `data-state="closed"`, computed display/visibility/opacity, and positive-area rect.
  It never reads `aria-hidden` — that is an assistive-tech signal, and reading it as a paint signal is exactly the defect that caused a settings-panel flash.
- **Pure intersection, level-triggered.**
  The native view is on-screen iff no registered rect currently intersects the tile rect, recomputed against the full current layer set on every scan.
  Never edge-triggered on a single overlay's open/close.
- **Refcounted owners, including synthetic ones.**
  Each thing that can freeze a tile — an overlay, or canvas motion — is an owner with its own id; a tile stays frozen while any owner holds it.
  Motion registers as a synthetic owner (`browser-overlay-motion:<tileKey>`) through the same registry, so freeze/unfreeze is one state machine for both overlay occlusion and motion, not two.
- **Occlude before release, within a scan.**
  A tile is never un-parked while any registered rect still intersects it, including across ownership handoff between two overlays (e.g. a dialog handing off to a nested select).
  Releasing before occluding is the second defect this coordinator closes.
- **Stand-in source: `capturePage`, warm cache as the deadline fallback.**
  The stand-in is a frozen frame captured at swap time via `capturePage`, gated by the entry paint-ack.
  A rolling warm cache (~2 frames old) is the fallback if the deadline (`CAPTURE_STANDIN_DEADLINE_MS`) elapses first — overlay correctness beats stand-in freshness, so the deadline always wins over waiting.
- **Symmetric exit handshake.**
  The hide edge already required a paint-ack before parking.
  The restore edge is now the same shape: the stand-in stays mounted until the un-parked native view's first composited frame (from the same `beginFrameSubscription` the frame cache already attaches), with a small frame-budget liveness escape for a view that never delivers one.
  Disabling this handshake exposes a parked-view hole at ownership handoff (the dialog-to-nested-select release path); it is load-bearing, not defense-in-depth.
- **Toast anchor avoidance.**
  Non-modal transients (sonner toasts) prefer positions that do not overlap registered tile rects, so a tile freezing mid-typing is rare by construction.
- **Light-dismiss semantics.**
  A click on the uncovered region of an overlay-frozen tile dismisses the overlay only; it is never forwarded to the guest.
  A motion-frozen tile with no overlay open has no swallow at all — the freeze is purely visual, input flows to the still-live guest, and the tile catches up visually within ~2 frames of rest.

## Requirements

| Id  | Requirement                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The native `WebContentsView` is the primary local compositing plane. Bounds stream continuously, including through drag gestures; the resulting one-frame IPC trail mid-drag is accepted physics of this architecture, not a bug to eliminate. |
| R2  | The stand-in's pixel source is `capturePage`, gated by paint-ack; the rolling warm cache is the deadline fallback (`CAPTURE_STANDIN_DEADLINE_MS`). Overlay correctness beats stand-in freshness.                                               |
| R3  | Visibility is level-triggered: a pure function of the full current registered-rect set, recomputed on every scan, never edge-triggered on a single overlay's open/close.                                                                       |
| R4  | Pure geometric intersection is the only trigger, for every overlay kind. Non-overlapping overlays cause nothing.                                                                                                                               |
| R5  | The visibility predicate reads paint signals only (`hidden`, `data-state`, computed display/visibility/opacity, positive-area rect). `aria-hidden` must never enter it.                                                                        |
| R6  | Both swap edges are pixel-atomic: hide waits for paint-ack before parking, restore keeps the stand-in mounted until the un-parked view's first composited frame. No frame may show native-above-overlay or a stand-in gap on either edge.      |
| R7  | A tile is never un-parked while any registered rect still intersects it, including across ownership handoff between overlays.                                                                                                                  |
| R8  | While occluded, nothing streams to the stand-in; it is a frozen frame. Input keeps flowing to the parked (still-live) guest.                                                                                                                   |
| R9  | Canvas motion (scroll, pane animation, resize) freezes a tile to the stand-in and restores at rest, as a synthetic owner through the same coordinator as overlay occlusion.                                                                    |
| R10 | A frozen tile's light-dismiss click dismisses the covering overlay only, never forwarded to the guest. A motion-only freeze has no swallow: input flows unchanged.                                                                             |
| R11 | Toast placement prefers positions that avoid registered tile rects.                                                                                                                                                                            |
| R12 | Discovery is an explicit registry (mount/unmount), not a DOM selector scan, enforced by an import ban on raw Radix portal primitives outside `src/components/ui/` plus a dev-build tripwire for unregistered portal mounts.                    |

## Measured numbers (ticket 09, live CDP compositor probe)

Captured 2026-09-02, macOS, Electron 42.11, display dpr 2, against the shipped hide/restore handshake.

- **`capturePage` resolution.**
  Full native resolution, not CSS pixels: a 592.625×799.75 CSS-px tile returned a 1186×1600 px capture, ratio 2.001 on both axes, consistent across every run.
  Ticket 03's decision to ship no DPR handling is correct as shipped — no correction is needed anywhere in the capture path.
- **`capturePage` freshness.**
  Verified live: the stand-in reflects the guest's latest paint at capture time, not a stale one.
- **Click-to-standin-set latency** (dropdown click → stand-in image observed), n=24 runs × 4 sessions.
  Median 94–106 ms, p95 ≈105–120 ms.
  `CAPTURE_STANDIN_DEADLINE_MS` (~33 ms) is a small fraction of that round trip, so the warm-cache deadline fallback is likely the **common** path in practice, not the exception.
  Accepted as-is; revisit only if stand-in staleness ever becomes user-visible.
- **Motion rest latency** (drag-stop → un-park), n=24 runs × 4 sessions.
  Median 22–25 ms, p95 ≈29 ms, max 62 ms observed.
  `MOTION_REST_FRAME_THRESHOLD` (6 frames) stands unchanged.
- **Edge correctness.**
  No native-above-overlay frame and no stand-in-gap frame observed on either edge, from a harness independently proven to go red: restore-ack sabotage produced real stand-in-gap violations, and disabling occlude-before-release produced real parked-view holes.
- **Exit handshake is load-bearing.**
  Disabling it reproduces the parked-view hole at the dialog-to-nested-select ownership handoff.
  It is not defense-in-depth.
- **Entry paint-ack gate is not pixel-observable on this platform.**
  A parked `WebContentsView` stays composited and retains its last frame, so park/un-park read as visually atomic even with the gate disabled — 120fps capture showed zero intermediate frames either way.
  The gate is kept as defense-in-depth for a platform or condition where a parked view stops painting; it is not currently provable by pixels, and that limitation is recorded here rather than papered over with a synthetic test.
