/**
 * The resolver IS the placement spec (plan §5.1 steps 1-7, decisions C3-C7,
 * C10), so this suite is the spec's executable form: one case per rule, built
 * on the real canvas fixtures the store suites use.
 */
import { describe, expect, it } from "vitest";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import type { TileLayoutNode, TilePane } from "@/stores/epics/canvas/tile-tree";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicNodeRef,
} from "@/stores/epics/canvas/types";
import {
  CHAT_A,
  SPEC_A,
  SPEC_B,
  TEST_HOST_ID,
  group,
  pane,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import {
  tileCategoryOf,
  type TileOpenGesture,
  type TileOpenIntent,
  type TileOpenMode,
  type TileOpenPlan,
  type TilePlacementSettings,
} from "../intent";
import { resolveTileOpen } from "../resolve-tile-open";

const TAB_ID = "view-tab-1";

const CHAT_B: EpicNodeRef = {
  id: "chat-b",
  instanceId: "inst-chat-b",
  type: "chat",
  name: "Chat B",
  hostId: TEST_HOST_ID,
};
const CHAT_C: EpicNodeRef = {
  id: "chat-c",
  instanceId: "inst-chat-c",
  type: "chat",
  name: "Chat C",
  hostId: TEST_HOST_ID,
};
const BROWSER_A = makeBrowserSessionTileRef({
  hostId: TEST_HOST_ID,
  sessionId: "session-1",
  tabId: "browser-tab-1",
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function canvasOf(input: {
  readonly root: TileLayoutNode | null;
  readonly activePaneId: string | null;
  readonly tiles: ReadonlyArray<EpicCanvasTileRef>;
}): EpicCanvasState {
  return {
    root: input.root,
    activePaneId: input.activePaneId,
    tilesByInstanceId: Object.fromEntries(
      input.tiles.map((tile) => [tile.instanceId, tile]),
    ),
    sizesByGroupId: {},
  };
}

/** `pane()` seeds activationHistory from the first tab; these cases need the
 * order spelled out. */
function paneWithHistory(
  id: string,
  tabInstanceIds: ReadonlyArray<string>,
  activationHistory: ReadonlyArray<string>,
): TilePane {
  return {
    kind: "pane",
    id,
    tabInstanceIds,
    activeTabId: activationHistory.at(0) ?? tabInstanceIds.at(0) ?? null,
    previewTabId: null,
    activationHistory,
  };
}

/** One pane holding SPEC_A, active. The neutral canvas for placement rules. */
const SINGLE_PANE_CANVAS = canvasOf({
  root: pane("p1", [SPEC_A.instanceId]),
  activePaneId: "p1",
  tiles: [SPEC_A],
});

const BASE_INTENT: TileOpenIntent = {
  node: SPEC_A,
  target: { tabId: TAB_ID },
  gesture: "explicit",
  modifiers: null,
  placement: null,
  dedupe: true,
  source: "direct_ui",
};

const NO_MODS = { shift: false, alt: false, middle: false } as const;

/** default + per-category, at the shipped defaults (C3). */
const DEFAULT_SETTINGS: TilePlacementSettings = {
  default: "per-category",
  content: "tab",
  conversation: "tab",
  browser: "split",
};

function resolve(input: {
  readonly intent: TileOpenIntent;
  readonly settings: TilePlacementSettings;
  readonly canvas: EpicCanvasState;
  readonly singleTileViewport: boolean;
}): TileOpenPlan {
  return resolveTileOpen({
    intent: input.intent,
    settings: input.settings,
    canvas: input.canvas,
    resolveTargetTabForEpic: (epicId) => `tab-for-${epicId}`,
    singleTileViewport: input.singleTileViewport,
  });
}

/** The common shape: default settings, desktop viewport, neutral canvas. */
function resolveDefault(intent: TileOpenIntent): TileOpenPlan {
  return resolve({
    intent,
    settings: DEFAULT_SETTINGS,
    canvas: SINGLE_PANE_CANVAS,
    singleTileViewport: false,
  });
}

// ---------------------------------------------------------------------------
// 1. Target tab
// ---------------------------------------------------------------------------

describe("target", () => {
  it("resolves an epic target through resolveTargetTabForEpic", () => {
    const plan = resolveDefault({
      ...BASE_INTENT,
      node: CHAT_B,
      target: { epicId: "epic-1" },
    });
    expect(plan.tabId).toBe("tab-for-epic-1");
  });
});

// ---------------------------------------------------------------------------
// 2. Dedupe (C6, B4)
// ---------------------------------------------------------------------------

describe("dedupe", () => {
  it("focuses the open instance wherever it lives", () => {
    const canvas = canvasOf({
      root: group("g1", "horizontal", [
        pane("p1", [CHAT_A.instanceId]),
        pane("p2", [SPEC_A.instanceId]),
      ]),
      activePaneId: "p1",
      tiles: [CHAT_A, SPEC_A],
    });
    expect(
      resolve({
        intent: { ...BASE_INTENT, node: SPEC_A },
        settings: DEFAULT_SETTINGS,
        canvas,
        singleTileViewport: false,
      }),
    ).toEqual({
      kind: "focus-existing",
      tabId: TAB_ID,
      paneId: "p2",
      instanceId: SPEC_A.instanceId,
    });
  });

  it("opens a fresh tab when the intent opts out", () => {
    const plan = resolveDefault({ ...BASE_INTENT, dedupe: false });
    expect(plan.kind).toBe("open-in-pane");
  });

  it("middle-click bypasses dedupe for a browser node", () => {
    const canvas = canvasOf({
      root: pane("p1", [BROWSER_A.instanceId]),
      activePaneId: "p1",
      tiles: [BROWSER_A],
    });
    expect(
      resolve({
        intent: {
          ...BASE_INTENT,
          node: BROWSER_A,
          gesture: "single",
          modifiers: { ...NO_MODS, middle: true },
        },
        settings: DEFAULT_SETTINGS,
        canvas,
        singleTileViewport: false,
      }),
    ).toEqual({
      kind: "open-in-pane",
      tabId: TAB_ID,
      paneId: "p1",
      mode: "background",
      index: null,
    });
  });

  it("middle-click still dedupes a non-browser node", () => {
    const plan = resolveDefault({
      ...BASE_INTENT,
      gesture: "single",
      modifiers: { ...NO_MODS, middle: true },
    });
    expect(plan.kind).toBe("focus-existing");
  });
});

// ---------------------------------------------------------------------------
// 3. Gesture -> mode (C4)
// ---------------------------------------------------------------------------

describe("gesture -> mode", () => {
  const CASES: ReadonlyArray<{
    readonly gesture: TileOpenGesture;
    readonly middle: boolean;
    readonly mode: TileOpenMode;
  }> = [
    { gesture: "single", middle: false, mode: "preview" },
    { gesture: "double", middle: false, mode: "permanent" },
    { gesture: "explicit", middle: false, mode: "permanent" },
    { gesture: "host", middle: false, mode: "background" },
    { gesture: "single", middle: true, mode: "background" },
    { gesture: "double", middle: true, mode: "background" },
  ];

  for (const testCase of CASES) {
    it(`${testCase.gesture}${testCase.middle ? " + middle" : ""} -> ${testCase.mode}`, () => {
      const plan = resolveDefault({
        ...BASE_INTENT,
        node: CHAT_B,
        gesture: testCase.gesture,
        modifiers: { ...NO_MODS, middle: testCase.middle },
      });
      expect(plan).toEqual({
        kind: "open-in-pane",
        tabId: TAB_ID,
        paneId: "p1",
        mode: testCase.mode,
        index: null,
      });
    });
  }

  it("never splits for a background open", () => {
    const plan = resolveDefault({
      ...BASE_INTENT,
      node: CHAT_B,
      gesture: "host",
      modifiers: { ...NO_MODS, shift: true },
    });
    expect(plan.kind).toBe("open-in-pane");
  });
});

// ---------------------------------------------------------------------------
// 4. Explicit placement (C7)
// ---------------------------------------------------------------------------

describe("explicit placement", () => {
  it("beats the category setting", () => {
    expect(
      resolveDefault({
        ...BASE_INTENT,
        node: BROWSER_A,
        placement: { kind: "tab", paneId: "p9", index: 2 },
      }),
    ).toEqual({
      kind: "open-in-pane",
      tabId: TAB_ID,
      paneId: "p9",
      mode: "permanent",
      index: 2,
    });
  });

  it("keeps the drop edge", () => {
    expect(
      resolveDefault({
        ...BASE_INTENT,
        node: CHAT_B,
        placement: { kind: "split", paneId: "p1", edge: "bottom" },
      }),
    ).toEqual({
      kind: "split",
      tabId: TAB_ID,
      paneId: "p1",
      edge: "bottom",
      mode: "permanent",
    });
  });

  it("clamps an explicit split on a single-tile viewport", () => {
    expect(
      resolve({
        intent: {
          ...BASE_INTENT,
          node: CHAT_B,
          placement: { kind: "split", paneId: "p1", edge: "bottom" },
        },
        settings: DEFAULT_SETTINGS,
        canvas: SINGLE_PANE_CANVAS,
        singleTileViewport: true,
      }),
    ).toEqual({
      kind: "open-in-pane",
      tabId: TAB_ID,
      paneId: "p1",
      mode: "permanent",
      index: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 4b. Setting + modifiers (C3, C4)
// ---------------------------------------------------------------------------

describe("setting and modifiers", () => {
  const SPLIT_EVERYWHERE: TilePlacementSettings = {
    default: "split",
    content: "tab",
    conversation: "tab",
    browser: "tab",
  };

  it("honors a flat (non-per-category) default", () => {
    const plan = resolve({
      intent: { ...BASE_INTENT, node: CHAT_B },
      settings: SPLIT_EVERYWHERE,
      canvas: SINGLE_PANE_CANVAS,
      singleTileViewport: false,
    });
    expect(plan.kind).toBe("split");
  });

  it("shift forces a split", () => {
    const plan = resolveDefault({
      ...BASE_INTENT,
      node: CHAT_B,
      modifiers: { ...NO_MODS, shift: true },
    });
    expect(plan).toEqual({
      kind: "split",
      tabId: TAB_ID,
      paneId: "p1",
      edge: "right",
      mode: "permanent",
    });
  });

  it("alt inverts tab -> split", () => {
    const plan = resolveDefault({
      ...BASE_INTENT,
      node: CHAT_B,
      modifiers: { ...NO_MODS, alt: true },
    });
    expect(plan.kind).toBe("split");
  });

  it("alt inverts split -> tab", () => {
    const plan = resolveDefault({
      ...BASE_INTENT,
      node: BROWSER_A,
      modifiers: { ...NO_MODS, alt: true },
    });
    expect(plan.kind).toBe("open-in-pane");
  });

  it("shift then alt lands back on a tab", () => {
    const plan = resolveDefault({
      ...BASE_INTENT,
      node: CHAT_B,
      modifiers: { ...NO_MODS, shift: true, alt: true },
    });
    expect(plan.kind).toBe("open-in-pane");
  });
});

// ---------------------------------------------------------------------------
// 5. Viewport clamp (C10) and pip
// ---------------------------------------------------------------------------

describe("single-tile viewport", () => {
  it("clamps a shift-split to the anchor pane", () => {
    expect(
      resolve({
        intent: {
          ...BASE_INTENT,
          node: CHAT_B,
          modifiers: { ...NO_MODS, shift: true },
        },
        settings: DEFAULT_SETTINGS,
        canvas: SINGLE_PANE_CANVAS,
        singleTileViewport: true,
      }),
    ).toEqual({
      kind: "open-in-pane",
      tabId: TAB_ID,
      paneId: "p1",
      mode: "permanent",
      index: null,
    });
  });

  it("clamps pip too", () => {
    const plan = resolve({
      intent: { ...BASE_INTENT, node: BROWSER_A },
      settings: {
        default: "per-category",
        content: "tab",
        conversation: "tab",
        browser: "pip",
      },
      canvas: SINGLE_PANE_CANVAS,
      singleTileViewport: true,
    });
    expect(plan.kind).toBe("open-in-pane");
  });
});

describe("pip", () => {
  const PIP_SETTINGS: TilePlacementSettings = {
    default: "per-category",
    content: "tab",
    conversation: "tab",
    browser: "pip",
  };

  it("floats a browser tile", () => {
    expect(
      resolve({
        intent: { ...BASE_INTENT, node: BROWSER_A },
        settings: PIP_SETTINGS,
        canvas: SINGLE_PANE_CANVAS,
        singleTileViewport: false,
      }),
    ).toEqual({ kind: "pip", tabId: TAB_ID });
  });

  it("never floats a non-browser tile under the same settings", () => {
    const plan = resolve({
      intent: { ...BASE_INTENT, node: CHAT_B },
      settings: PIP_SETTINGS,
      canvas: SINGLE_PANE_CANVAS,
      singleTileViewport: false,
    });
    expect(plan.kind).toBe("open-in-pane");
  });
});

// ---------------------------------------------------------------------------
// 6. Category affinity (C5)
// ---------------------------------------------------------------------------

describe("category affinity", () => {
  // p1 (active) holds content only; p2 holds a chat buried behind a spec;
  // p3's chat is its current tab.
  const AFFINITY_CANVAS = canvasOf({
    root: group("g1", "horizontal", [
      pane("p1", [SPEC_A.instanceId]),
      paneWithHistory(
        "p2",
        [SPEC_B.instanceId, CHAT_A.instanceId],
        [SPEC_B.instanceId, CHAT_A.instanceId],
      ),
      paneWithHistory("p3", [CHAT_B.instanceId], [CHAT_B.instanceId]),
    ]),
    activePaneId: "p1",
    tiles: [SPEC_A, SPEC_B, CHAT_A, CHAT_B],
  });

  const SPLIT_CONVERSATIONS: TilePlacementSettings = {
    default: "per-category",
    content: "tab",
    conversation: "split",
    browser: "split",
  };

  it("groups into the pane whose same-category tile is most recent", () => {
    expect(
      resolve({
        intent: { ...BASE_INTENT, node: CHAT_C },
        settings: SPLIT_CONVERSATIONS,
        canvas: AFFINITY_CANVAS,
        singleTileViewport: false,
      }),
    ).toEqual({
      kind: "open-in-pane",
      tabId: TAB_ID,
      paneId: "p3",
      mode: "permanent",
      index: null,
    });
  });

  it("prefers the active pane when it already hosts the category", () => {
    const plan = resolve({
      intent: { ...BASE_INTENT, node: CHAT_C },
      settings: SPLIT_CONVERSATIONS,
      canvas: { ...AFFINITY_CANVAS, activePaneId: "p2" },
      singleTileViewport: false,
    });
    expect(plan).toEqual({
      kind: "open-in-pane",
      tabId: TAB_ID,
      paneId: "p2",
      mode: "permanent",
      index: null,
    });
  });

  it("splits right of the active pane when no pane hosts the category", () => {
    expect(
      resolve({
        intent: { ...BASE_INTENT, node: BROWSER_A },
        settings: SPLIT_CONVERSATIONS,
        canvas: AFFINITY_CANVAS,
        singleTileViewport: false,
      }),
    ).toEqual({
      kind: "split",
      tabId: TAB_ID,
      paneId: "p1",
      edge: "right",
      mode: "permanent",
    });
  });

  it("falls back to a plain open on an empty canvas", () => {
    expect(
      resolve({
        intent: { ...BASE_INTENT, node: BROWSER_A },
        settings: SPLIT_CONVERSATIONS,
        canvas: canvasOf({ root: null, activePaneId: null, tiles: [] }),
        singleTileViewport: false,
      }),
    ).toEqual({
      kind: "open-in-pane",
      tabId: TAB_ID,
      paneId: null,
      mode: "permanent",
      index: null,
    });
  });
});

// ---------------------------------------------------------------------------
// tileCategoryOf (C2)
// ---------------------------------------------------------------------------

describe("tileCategoryOf", () => {
  it("maps conversations, browsers and content", () => {
    expect(tileCategoryOf(CHAT_A)).toBe("conversation");
    expect(tileCategoryOf(BROWSER_A)).toBe("browser");
    expect(tileCategoryOf(SPEC_A)).toBe("content");
    // `blank` is keyboard-only and never routed through an intent; the arm
    // exists to keep the switch total.
    expect(
      tileCategoryOf({
        id: "blank-1",
        instanceId: "inst-blank-1",
        type: "blank",
        name: "New tab",
        hostId: TEST_HOST_ID,
      }),
    ).toBe("content");
  });
});
