# ADR 0001 — Browser tile rendering architecture

Status: accepted, 2026-09-03 (supersedes the 2026-09-02 native-view record).
Companion: [0001-browser-tile-rendering-tickets.md](0001-browser-tile-rendering-tickets.md) cites historical requirement ids from the previous native-view record.
Source spec: `specs/browser-overlay-coexistence/browser-overlay-coexistence.md` (internal repo).

## Context

A co-located Electron browser tile is a renderer-owned `<webview>` element, not a native `WebContentsView` and not a DOM iframe.
The canvas also renders DOM overlays on top of tiles: dialogs, popovers, selects, dropdown menus, tooltips, context menus, toasts.

The previous record kept a main-process `WebContentsView` as the local plane and solved overlay coexistence with an occlusion coordinator: capture a stand-in, park the native view, restore after paint-ack.
That physics is what produced the GitHub divider stall: motion registered as a synthetic occlusion owner, the live guest was replaced with a stale `object-contain` screenshot, and the site reflowed only after six idle frames.

## Physics and foundation

A `<webview>` participates in the trusted renderer's DOM compositor.
Ordinary `z-index`, stacking contexts, and CSS anchors apply.
No native-above-DOM interleaving remains for the local visible tile (`electron#15899` no longer describes this plane).

Guest birth is still main-owned for security.
The renderer receives identity and the granted partition only.
Main mints a one-use window-scoped attach grant, admits the blank guest at `will-attach-webview` / `did-attach-webview`, seeds cookies and localStorage, installs policy/CDP, then navigates.
`seedStorageState` never crosses into the renderer heap.

Placement is CSS, not bounds IPC.
Each tile surface publishes `anchor-name: --traycer-bv-<registrationId>`.
The persistent guest wrapper uses `position: fixed`, `position-anchor`, `anchor()`, and `anchor-size()`.
The guest is never reparented; pane and tile movement change only the assigned anchor.

Presentation states:

- selected and visible: anchored, opaque, interactive;
- retained (mounted tile, not presented): `display: none`, inert;
- live but surface-less (agent/CDP/PiP): fixed offscreen viewport, opacity 0, inert, still composited.

Electron documents `<webview>` as a tag Chromium may change.
Traycer accepts that platform risk in exchange for CSS-native resize, ordinary overlay stacking, and the deletion of the native geometry/occlusion subsystem.
Fail-closed attach hardening, incarnation-safe mount/release, crash rematerialization, and reserved-chord forwarding are load-bearing, not optional.

Two alternatives remain rejected.

**OSR shared-texture.**
Rejected for the same reasons as before: IME, accessibility, cursor, and focus have no path; the API is experimental.

**Transparent overlay-`WebContentsView` for popovers.**
Rejected: Radix portals live in the main renderer's React tree.

**Native `WebContentsView` with live bounds and no motion freeze.**
That would have fixed the divider stall with a smaller blast radius.
Rejected as the product plane: overlay stacking, CSS placement, and the deletion of the native geometry/occlusion subsystem require the `<webview>` cutover, not a motion-only patch.

Remote JPEG/WebRTC viewers and host-local/headless placement are unchanged.
A non-co-located GUI never creates a `<webview>`.

This cutover does not claim to fix the independent intermittent image-network failure.
Both planes use Chromium's network/session stack.

## Requirements

| Id  | Requirement                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The local compositing plane is a persistent renderer-owned `<webview>`. Geometry follows CSS anchors continuously, including through divider drag. There is no bounds IPC and no accepted one-frame native-view trail. |
| R2  | DOM overlays paint and receive input above the guest through ordinary stacking. There is no `capturePage` stand-in, paint-ack, or park/restore handshake for overlay coexistence.                                      |
| R3  | Guest identity (`webContentsId` and DOM parent) survives pane reorder, split reversal, tab selection, and tile transfer. Only the CSS `position-anchor` assignment changes.                                            |
| R4  | Focusing or clicking the guest activates its owning canvas pane. App and browser shortcuts target that pane.                                                                                                           |
| R5  | A presented guest is interactive. A retained guest is inert and not displayed. An unbound paintable guest cannot appear or receive user input, but remains composited for CDP/capture.                                 |
| R6  | Main admits only a blank guest matching a pending one-use grant for the same window, partition, and registration. Privilege stripping, request gating, and seed secrecy are unchanged.                                 |
| R7  | Host-local, headless, and remote JPEG/WebRTC selection plus `browser.sessions` protocol behavior remain unchanged.                                                                                                     |
| R8  | Toast placement may prefer positions that avoid live tile rects. That is UX, not native occlusion.                                                                                                                     |
| R9  | Canvas motion does not freeze, hide, or snapshot the guest.                                                                                                                                                            |
| R10 | Light-dismiss clicks on overlays behave as ordinary DOM. There is no parked native view to swallow or forward input into.                                                                                              |
| R11 | Portal primitives stay behind the shadcn wrappers in `src/components/ui/`.                                                                                                                                             |
| R12 | No runtime flag and no supported `WebContentsView` fallback ship.                                                                                                                                                      |

Historical R2–R10 from the 2026-09-02 native-view record (paint-ack, frame cache, six-frame motion hysteresis, `capturePage` stand-ins) are withdrawn.
The measured numbers in that record described the deleted native handshake and are not physics of the current plane.
