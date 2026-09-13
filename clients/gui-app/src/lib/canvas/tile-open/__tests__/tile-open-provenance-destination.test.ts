/**
 * WHICH tile instance an open marks as requested.
 *
 * The seam mints a fresh instance id for every intent, and dedupe then routes
 * the open to a tile that is ALREADY on the canvas under a different id. The
 * fresh id is the one the caller built; the resolved one is the tile the user
 * is about to be looking at. Only the second is a tile anything will read the
 * mark from.
 *
 * It matters because the mark is what tells a terminal-agent tile that its
 * sleeping agent may be started: a restored tile holds `adoptOnly` until
 * somebody asks for it, and an explicit Open that marked only the discarded id
 * left the agent asleep under copy promising the opposite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { tileIntent, type TileOpenIntent, type TileOpenPlan } from "../intent";

const RESOLVED_PLAN: { value: TileOpenPlan } = {
  value: { kind: "noop" },
};

vi.mock("../resolve-tile-open", () => ({
  resolveTileOpen: () => RESOLVED_PLAN.value,
}));
vi.mock("../execute-tile-open", () => ({
  executeTileOpen: () => null,
}));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  isMobileViewport: () => false,
}));
vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => ({ tilePlacement: {} }) },
}));
vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: {
    getState: () => ({
      canvasByTabId: {},
      tabsById: { "tab-1": { epicId: "epic-1" } },
      resolveTargetTabForEpic: () => "tab-1",
      resolveTabIdForEpic: () => "tab-1",
    }),
  },
}));

import {
  commitWithoutNavigation,
  MANUAL_TILE_OPEN,
  openTileWithNavigation,
} from "../open-tile";
import { wasTileOpenRequested } from "../tile-open-provenance";

const EXISTING_INSTANCE = "inst-already-mounted";

function intentForFreshInstance(instanceId: string): TileOpenIntent {
  return tileIntent(
    {
      id: "agent-1",
      instanceId,
      type: "terminal-agent",
      name: "claude",
      hostId: "host-1",
    },
    { tabId: "tab-1" },
    "single",
    "direct_ui",
  );
}

describe("openTileWithNavigation marks the RESOLVED destination", () => {
  beforeEach(() => {
    createEmptyCanvas();
  });

  it("marks the existing instance a dedupe resolved to, not only the discarded fresh id", () => {
    // The sidebar's open: a brand-new uuid on the intent, and a canvas that
    // already holds this agent under `EXISTING_INSTANCE`.
    RESOLVED_PLAN.value = {
      kind: "focus-existing",
      tabId: "tab-1",
      paneId: "pane-1",
      instanceId: EXISTING_INSTANCE,
      promote: false,
    };
    const freshId = "inst-fresh-uuid";
    expect(wasTileOpenRequested(EXISTING_INSTANCE)).toBe(false);

    openTileWithNavigation(
      intentForFreshInstance(freshId),
      commitWithoutNavigation,
      MANUAL_TILE_OPEN,
    );

    // THE CLAIM. Without it the mounted tile is never told, and the fresh id
    // it marked instead belongs to a tile that will never exist.
    expect(wasTileOpenRequested(EXISTING_INSTANCE)).toBe(true);
    // The intent's own id is still marked: when nothing dedupes, THAT is the
    // instance that mounts.
    expect(wasTileOpenRequested(freshId)).toBe(true);
  });

  it("marks the intent's instance for a plan that opens a new tile", () => {
    RESOLVED_PLAN.value = {
      kind: "open-in-pane",
      tabId: "tab-1",
      paneId: "pane-1",
      mode: "permanent",
      index: null,
    };
    openTileWithNavigation(
      intentForFreshInstance("inst-brand-new"),
      commitWithoutNavigation,
      MANUAL_TILE_OPEN,
    );
    expect(wasTileOpenRequested("inst-brand-new")).toBe(true);
  });
});
