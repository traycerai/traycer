import "../../../../../__tests__/test-browser-apis";
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import { BrowserOverlayCoordinatorBridge } from "@/components/epic-canvas/browser-overlay-coordinator-bridge";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-overlay-bridge";
import {
  registerBrowserOverlay,
  registerBrowserOverlayTile,
  rectsIntersect,
  setBrowserOverlayTileMotion,
  updateBrowserOverlayTileRect,
  type BrowserOverlayRect,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";

/**
 * Ticket 08's property/fuzz suite: invariant 5 ("a tile is never un-parked
 * while any registered rect intersects it") proved against randomized
 * open/close/nest/move sequences instead of the hand-picked scenarios the
 * bridge suite pins. Design in short: a seeded mulberry32 PRNG drives the
 * 8-action alphabet the ticket names against the REAL coordinator registry
 * and the REAL `<BrowserOverlayCoordinatorBridge/>`, batching 1-2 actions
 * per step (so an overlay handoff - one closing exactly as another opens -
 * can land in the SAME scan) and flushing the mocked-rAF/microtask queue to
 * quiescence between steps; the checker then asserts, for every currently
 * registered tile, that geometric intersection (via the coordinator's own
 * `rectsIntersect`) with any still-open overlay, OR the tile being in
 * motion, implies the fake main-process bridge already recorded that tile
 * as parked.
 */

// ── seeded PRNG (mulberry32) ─────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickInt(random: () => number, maxExclusive: number): number {
  return Math.floor(random() * maxExclusive);
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[pickInt(random, items.length)];
  if (item === undefined) throw new Error("pick from empty array");
  return item;
}

function randomRect(random: () => number): BrowserOverlayRect {
  // A small coordinate space (0-60) with small extents makes overlap -
  // partial, corner-clipping, full-cover, and no-overlap - all common, which
  // is what a geometry-only invariant needs exercised.
  const left = pickInt(random, 40);
  const top = pickInt(random, 40);
  const width = 5 + pickInt(random, 25);
  const height = 5 + pickInt(random, 25);
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

function setElementRect(element: HTMLElement, rect: BrowserOverlayRect): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }),
  });
}

// ── alphabet ──────────────────────────────────────────────────────────────

interface OverlayHandle {
  readonly element: HTMLElement;
  readonly deregister: () => void;
  rect: BrowserOverlayRect;
}

interface TileHandle {
  readonly key: BrowserViewTileKey;
  readonly deregister: () => void;
  rect: BrowserOverlayRect;
  moving: boolean;
}

interface FuzzState {
  readonly overlays: OverlayHandle[];
  readonly tiles: TileHandle[];
  nextTileId: number;
}

const ACTIONS = [
  "openOverlay",
  "closeOverlay",
  "moveOverlay",
  "registerTile",
  "moveTile",
  "unregisterTile",
  "tileEntersMotion",
  "tileReachesRest",
] as const;
type Action = (typeof ACTIONS)[number];

function applyAction(
  random: () => number,
  action: Action,
  state: FuzzState,
): void {
  switch (action) {
    case "openOverlay": {
      const element = document.createElement("div");
      const rect = randomRect(random);
      setElementRect(element, rect);
      document.body.append(element);
      const deregister = registerBrowserOverlay({ element });
      state.overlays.push({ element, deregister, rect });
      return;
    }
    case "closeOverlay": {
      if (state.overlays.length === 0) return;
      const index = pickInt(random, state.overlays.length);
      const [overlay] = state.overlays.splice(index, 1);
      overlay.deregister();
      overlay.element.remove();
      return;
    }
    case "moveOverlay": {
      if (state.overlays.length === 0) return;
      const overlay = pick(random, state.overlays);
      overlay.rect = randomRect(random);
      setElementRect(overlay.element, overlay.rect);
      // Unlike every other action, moving an overlay touches neither the
      // registry (`registerBrowserOverlay*`) nor an observed attribute - its
      // rect is read live off the DOM each scan - so nothing here reaches
      // `subscribeBrowserOverlayLayout` or the `MutationObserver` on its
      // own. A real drag reaches the bridge's own `resize`/`scroll`
      // listeners; a `resize` dispatch is the production-safe way to force
      // the same rescan here.
      window.dispatchEvent(new Event("resize"));
      return;
    }
    case "registerTile": {
      const key: BrowserViewTileKey = {
        viewTabId: "view-1",
        paneId: "pane-1",
        tileInstanceId: `tile-${state.nextTileId}`,
        pageSessionId: "page-1",
      };
      state.nextTileId += 1;
      const rect = randomRect(random);
      const deregister = registerBrowserOverlayTile({ key, rect });
      state.tiles.push({ key, deregister, rect, moving: false });
      return;
    }
    case "moveTile": {
      if (state.tiles.length === 0) return;
      const tile = pick(random, state.tiles);
      tile.rect = randomRect(random);
      updateBrowserOverlayTileRect(tile.key, tile.rect);
      return;
    }
    case "unregisterTile": {
      if (state.tiles.length === 0) return;
      const index = pickInt(random, state.tiles.length);
      const [tile] = state.tiles.splice(index, 1);
      tile.deregister();
      return;
    }
    case "tileEntersMotion": {
      const resting = state.tiles.filter((tile) => !tile.moving);
      if (resting.length === 0) return;
      const tile = pick(random, resting);
      tile.moving = true;
      setBrowserOverlayTileMotion(tile.key, true);
      return;
    }
    case "tileReachesRest": {
      const moving = state.tiles.filter((tile) => tile.moving);
      if (moving.length === 0) return;
      const tile = pick(random, moving);
      tile.moving = false;
      setBrowserOverlayTileMotion(tile.key, false);
      return;
    }
  }
}

const FLUSH_MAX_ROUNDS = 20;

/** Lets the mocked rAF (see `beforeEach`) and the bridge's chained
 * occlude/release/ack promises settle to quiescence before the next
 * invariant check. A fixed round count under-flushes a cascade that needs
 * more than a couple of rAF/microtask rounds - `ackWhenPainted` alone spans
 * two mocked-rAF (macrotask) hops plus several microtask hops, and a scan
 * that touches several overlapping owners can chain more than one of those.
 * So this keeps pumping macrotask+microtask rounds until the bridge's own
 * call tallies stop growing, not a hardcoded count. */
async function flush(bridge: FakeBrowserViewBridge): Promise<void> {
  await act(async () => {
    let previousActivity = -1;
    for (let round = 0; round < FLUSH_MAX_ROUNDS; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let tick = 0; tick < 6; tick += 1) {
        await Promise.resolve();
      }
      const activity =
        bridge.occludeCalls.length +
        bridge.releaseCalls.length +
        bridge.paintAckCalls.length +
        bridge.restoreReports.length;
      if (activity === previousActivity) return;
      previousActivity = activity;
    }
  });
}

function tileMustBeParked(tile: TileHandle, state: FuzzState): boolean {
  const coveringOverlay = state.overlays.find((overlay) =>
    rectsIntersect(overlay.rect, tile.rect),
  );
  return coveringOverlay !== undefined || tile.moving;
}

/**
 * Invariant 5, checked geometrically against the coordinator's OWN
 * `rectsIntersect` rather than a hand-rolled comparison, and extended to
 * invariant 8 (motion is a second freeze input through the same machine):
 * a tile that intersects any still-open overlay, or that is itself moving,
 * must already be parked in the fake main process - and, the converse
 * (liveness direction): a tile that intersects NOTHING and is not moving
 * must not be left parked once the scan has settled.
 */
function assertInvariant(
  bridge: FakeBrowserViewBridge,
  state: FuzzState,
  context: string,
): void {
  state.tiles.forEach((tile) => {
    const mustBeParked = tileMustBeParked(tile, state);
    if (mustBeParked) {
      expect(
        bridge.isTileParked(tile.key),
        `${context}: ${tile.key.tileInstanceId} must be parked`,
      ).toBe(true);
    } else {
      expect(
        bridge.isTileParked(tile.key),
        `${context}: ${tile.key.tileInstanceId} must not be parked`,
      ).toBe(false);
    }
  });
}

function tileKeyId(key: BrowserViewTileKey): string {
  return `${key.viewTabId}:${key.paneId}:${key.tileInstanceId}:${key.pageSessionId}`;
}

function renderCoordinator(bridge: FakeBrowserViewBridge): void {
  const runnerHost = Object.assign(
    new MockRunnerHost({
      signInUrl: "https://example.com",
      authnBaseUrl: "https://auth.example.com",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    }),
    { browserView: bridge },
  );
  render(
    createElement(RunnerHostProvider, {
      runnerHost,
      children: createElement(BrowserOverlayCoordinatorBridge),
    }),
  );
}

const STEPS_PER_CASE = 40;
const CASE_COUNT = 5;
const BASE_SEED = 0xb2075;

let activeFuzzState: FuzzState | null = null;

async function runFuzzCase(seed: number): Promise<void> {
  const random = mulberry32(seed);
  const bridge = new FakeBrowserViewBridge();
  const state: FuzzState = { overlays: [], tiles: [], nextTileId: 1 };
  activeFuzzState = state;
  renderCoordinator(bridge);

  let seenRestoreReports = 0;
  for (let step = 0; step < STEPS_PER_CASE; step += 1) {
    const beforeParked = new Set(
      state.tiles
        .filter((tile) => tileMustBeParked(tile, state))
        .map((tile) => tileKeyId(tile.key)),
    );

    // A batch of 1-2 actions before flushing: this is what lets a
    // handoff (one overlay closing exactly as another, still covering the
    // same tile, opens) land inside a single scan - the exact shape
    // invariant 5's "occlude before release" ordering exists for.
    const batchSize = random() < 0.35 ? 2 : 1;
    for (let inBatch = 0; inBatch < batchSize; inBatch += 1) {
      const action = pick(random, ACTIONS);
      applyAction(random, action, state);
    }
    await flush(bridge);

    // A tile still covered (by geometry or motion) both before this step's
    // batch and after it settled was never actually uncovered in between -
    // it must not show up in any NEW `restoreReports` entry this step
    // produced. This is the async-race counterpart to `assertInvariant`'s
    // synchronous parked-flag check: `restoreReports` is what the
    // coordinator actually acts on (clearing the stand-in), so a spurious
    // entry there is the real, user-visible flicker bug even if the parked
    // flag itself briefly recovers.
    const afterParked = new Set(
      state.tiles
        .filter((tile) => tileMustBeParked(tile, state))
        .map((tile) => tileKeyId(tile.key)),
    );
    const newRestoreReports = bridge.restoreReports.slice(seenRestoreReports);
    seenRestoreReports = bridge.restoreReports.length;
    newRestoreReports.forEach((tile) => {
      const id = tileKeyId(tile);
      expect(
        beforeParked.has(id) && afterParked.has(id),
        `seed=${seed} step=${step}: ${tile.tileInstanceId} was continuously covered but appeared in a NEW restoreReports entry`,
      ).toBe(false);
    });

    assertInvariant(bridge, state, `seed=${seed} step=${step}`);
  }
}

describe("browser overlay coordinator: invariant 5 property/fuzz suite", () => {
  beforeEach(() => {
    let nextFrameId = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      setTimeout(() => {
        callback(performance.now());
      }, 0);
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      (_handle) => undefined,
    );
  });

  afterEach(() => {
    // The overlay/tile registries are module-level singletons, so a fuzz
    // case that stops mid-run (an assertion throw) leaks whatever it had
    // registered into the NEXT test's seed replay. Deregister everything
    // still standing before touching the DOM.
    if (activeFuzzState !== null) {
      activeFuzzState.overlays.forEach((overlay) => overlay.deregister());
      activeFuzzState.tiles.forEach((tile) => tile.deregister());
      activeFuzzState = null;
    }
    cleanup();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  // A seed given via env replays exactly that one failing case; otherwise
  // the suite runs CASE_COUNT fixed, logged seeds derived from BASE_SEED so
  // a CI failure is reproducible without needing the env var at all.
  const envSeed = process.env.BROWSER_OVERLAY_FUZZ_SEED;
  const seeds =
    envSeed !== undefined
      ? [Number(envSeed)]
      : Array.from(
          { length: CASE_COUNT },
          (_, index) => BASE_SEED + index * 104729,
        );

  seeds.forEach((seed) => {
    it(`never un-parks an intersected tile (seed=${seed})`, async () => {
      try {
        await runFuzzCase(seed);
      } catch (error) {
        // Replay hint on failure, per the ticket's "failing seed printed"
        // requirement.
        console.error(
          `[browser-overlay-coordinator-properties] failing seed: ${seed} (replay with BROWSER_OVERLAY_FUZZ_SEED=${seed})`,
        );
        throw error;
      }
    });
  });
});
