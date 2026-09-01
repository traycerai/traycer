/**
 * `openTile` is the wiring, not the policy: the resolver owns placement
 * (`resolve-tile-open.test.ts`) and the executor owns dispatch
 * (`execute-tile-open.test.ts`). What this suite pins is that the hook feeds
 * both the RIGHT inputs - the placement settings, the target tab's canvas, and
 * the live viewport - and commits through the nested-focus boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import {
  DEFAULT_TILE_PLACEMENT_SETTINGS,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import {
  CHAT_A,
  SPEC_A,
  SPEC_B,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";

const navigateNested = vi.fn<NavigateNestedFocus>((_epicId, _tabId, prepare) =>
  prepare(),
);
const isMobile = vi.fn(() => false);

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => navigateNested,
}));

vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  isMobileViewport: () => isMobile(),
  useIsMobileViewport: () => isMobile(),
}));

const EPIC_ID = "epic-open-tile";

function intentFor(
  overrides: Partial<TileOpenIntent> & Pick<TileOpenIntent, "target">,
): TileOpenIntent {
  return {
    node: SPEC_A,
    gesture: "single",
    modifiers: null,
    placement: null,
    dedupe: true,
    source: "direct_ui",
    ...overrides,
  };
}

function canvasFor(tabId: string): EpicCanvasState {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) throw new Error(`expected canvas for ${tabId}`);
  return canvas;
}

function openTile(): (intent: TileOpenIntent) => NestedFocusTarget | null {
  const { result } = renderHook(() => useEpicTileNavigation());
  return result.current.openTile;
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useSettingsStore.setState({
    tilePlacement: DEFAULT_TILE_PLACEMENT_SETTINGS,
  });
  navigateNested.mockClear();
  isMobile.mockReturnValue(false);
});

describe("useEpicTileNavigation openTile", () => {
  it("previews a single click into the active pane and commits the route", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Open Tile");
    useEpicCanvasStore.getState().openTileInTab(tabId, SPEC_B);

    const target = openTile()(intentFor({ target: { tabId } }));

    const canvas = canvasFor(tabId);
    if (target === null) throw new Error("expected a focus target");
    expect(target.paneId).toBe(canvas.activePaneId);
    const instanceId = target.tileInstanceId;
    if (instanceId === undefined) throw new Error("expected a focused tile");
    // The pane opener remints `instanceId`, so identity is checked by content.
    expect(canvas.tilesByInstanceId[instanceId]?.id).toBe(SPEC_A.id);
    expect(findPaneById(canvas.root, target.paneId)?.previewTabId).toBe(
      instanceId,
    );
    expect(navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      tabId,
      expect.any(Function),
    );
  });

  it("resolves an { epicId } target to that epic's header tab", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Open Tile");

    const target = openTile()(intentFor({ target: { epicId: EPIC_ID } }));

    expect(navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      tabId,
      expect.any(Function),
    );
    const instanceId = target?.tileInstanceId;
    if (instanceId === undefined) throw new Error("expected a focused tile");
    expect(canvasFor(tabId).tilesByInstanceId[instanceId]?.id).toBe(SPEC_A.id);
  });

  it("reads the placement setting: a split-configured category splits", () => {
    useSettingsStore.setState({
      tilePlacement: { ...DEFAULT_TILE_PLACEMENT_SETTINGS, content: "split" },
    });
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Open Tile");
    useEpicCanvasStore.getState().openTileInTab(tabId, CHAT_A);

    openTile()(intentFor({ target: { tabId } }));

    expect(collectPanes(canvasFor(tabId).root)).toHaveLength(2);
  });

  it("clamps a split to a tab on a single-tile viewport", () => {
    isMobile.mockReturnValue(true);
    useSettingsStore.setState({
      tilePlacement: { ...DEFAULT_TILE_PLACEMENT_SETTINGS, content: "split" },
    });
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Open Tile");
    useEpicCanvasStore.getState().openTileInTab(tabId, CHAT_A);

    openTile()(intentFor({ target: { tabId } }));

    expect(collectPanes(canvasFor(tabId).root)).toHaveLength(1);
  });
});
