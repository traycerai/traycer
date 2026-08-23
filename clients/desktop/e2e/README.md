# Browser tile E2E suite (BT-501 … BT-504)

Playwright `_electron` specs covering the behavior that lives BELOW the unit
seam: native bounds streaming, overlay occlusion, reserved-chord routing,
hidden-guest eviction, and multi-window geometry (ADR 0001 R13).

## One-time setup

```bash
# 1. Runner dependency — deps live ONLY in the root package.json (AGENTS.md):
cd <internal-repo-root>
bun add -d @playwright/test
npx playwright install chromium   # electron driver needs no browser download

# 2. Build the desktop shell (main + preload):
cd traycer/clients/desktop
bun run build

# 3. Run gated:
TRAYCER_E2E=1 \
TRAYCER_E2E_EXECUTABLE=$(which electron) \
bunx playwright test -c e2e/playwright.config.ts
```

Without `TRAYCER_E2E=1` every spec self-skips, so plain CI/vitest runs stay
green on machines without the driver.

## Debug surface

Specs read native truth through `app.evaluate()` against
`globalThis.__traycerBrowserViewManagerDebug`, installed by
`browser-view-ipc.ts` ONLY when `TRAYCER_E2E=1`
(see `src/electron-main/browser-view/browser-view-manager-debug.ts`):

- `boundsByKeyId()` — applied native rect per entry key id
- `occludedKeyIds()` — entries parked under an overlay owner
- `frameCacheStats()` — frame-cache counters (BT-205)
- `evictedKeyIds()` — guests evicted by the hidden-guest LRU (BT-403)

## First-live-run TODOs

The specs were authored without a live driver; during the first run:

1. Replace placeholder `data-testid`s (`canvas-pane-splitter`,
   `browser-tab-menu`, `browser-tile-surface`, `new-browser-tile-input`,
   `switch-pane-group`, `reopen-first-browser-tile`) with the real hooks.
2. Pack A: add the renderer probe hook that reports the DOM surface rect so
   mid-drag native-vs-DOM delta can be asserted numerically (≤1-frame trail,
   ADR 0001 R1) instead of the current "bounds kept flowing" check.
3. Confirm the palette dialog's accessible name for Pack B.
4. Wire the linux+macos required / windows periodic CI jobs (mirror
   `host-tests.yaml` shape in the internal repo).
