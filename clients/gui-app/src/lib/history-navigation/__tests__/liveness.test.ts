import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHistoryEntryDead } from "@/lib/history-navigation/liveness";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicViewTab,
  TilePane,
} from "@/stores/epics/canvas/types";
import { TILE_KIND_BLANK } from "@/stores/epics/canvas/tile-kinds";

function tab(tabId: string, epicId: string): EpicViewTab {
  return { tabId, epicId, name: "Epic" };
}

function artifactTile(instanceId: string): EpicCanvasTileRef {
  return {
    id: `artifact-${instanceId}`,
    instanceId,
    type: "spec",
    name: instanceId,
    hostId: "host-1",
  };
}

function blankTile(instanceId: string): EpicCanvasTileRef {
  return {
    id: instanceId,
    instanceId,
    type: TILE_KIND_BLANK,
    name: "New tab",
    hostId: "host-1",
  };
}

function pane(
  paneId: string,
  tabInstanceIds: ReadonlyArray<string>,
  activeTabId: string | null,
): TilePane {
  return {
    kind: "pane",
    id: paneId,
    tabInstanceIds,
    activeTabId,
    previewTabId: null,
    activationHistory: activeTabId === null ? [] : [activeTabId],
  };
}

function canvas(
  root: TilePane,
  tilesByInstanceId: Record<string, EpicCanvasTileRef | undefined>,
): EpicCanvasState {
  return {
    root,
    activePaneId: root.id,
    tilesByInstanceId,
    sizesByGroupId: {},
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
});

afterEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
});

describe("isHistoryEntryDead — conservative liveness", () => {
  it("keeps routes no store can prove dead", () => {
    for (const href of [
      "/",
      "/onboarding",
      "/draft/new",
      "/epics",
      "/settings",
      "/settings/general",
      "/settings/keybindings",
      "/totally-unknown/route/shape",
      "",
    ]) {
      expect(isHistoryEntryDead(href)).toBe(false);
    }
  });

  it("keeps an epic-tab href whose tab still maps to the epic", () => {
    useEpicCanvasStore.setState({ tabsById: { t1: tab("t1", "e1") } });
    expect(isHistoryEntryDead("/epics/e1/t1")).toBe(false);
    // Query string / hash are ignored when matching the path.
    expect(isHistoryEntryDead("/epics/e1/t1?focusArtifactId=a#frag")).toBe(
      false,
    );
  });

  it("prunes a gone-tab href when the epic has no resolvable sibling", () => {
    // tabsById holds t1 but openTabOrder is empty, so resolveTabIdForEpic("e1")
    // finds nothing to redirect to → the stale entry is dead.
    useEpicCanvasStore.setState({ tabsById: { t1: tab("t1", "e1") } });
    expect(isHistoryEntryDead("/epics/e1/tGONE")).toBe(true);
  });

  it("keeps a gone-tab href when the epic still has a sibling tab", () => {
    // The exact tab is gone, but resolveTabIdForEpic("e1") resolves sibling t1
    // (present in openTabOrder), so the route's beforeLoad would redirect a back
    // step there instead of failing — prune must not drop it.
    useEpicCanvasStore.setState({
      tabsById: { t1: tab("t1", "e1") },
      openTabOrder: ["t1"],
    });
    expect(isHistoryEntryDead("/epics/e1/tGONE")).toBe(false);
  });

  it("prunes a gone-tab nested href even when the epic still has a sibling tab", () => {
    useEpicCanvasStore.setState({
      tabsById: { t1: tab("t1", "e1") },
      openTabOrder: ["t1"],
    });

    expect(
      isHistoryEntryDead(
        "/epics/e1/tGONE?focusPaneId=pane-1&focusTileInstanceId=tile-1",
      ),
    ).toBe(true);
  });

  it("prunes an epic-tab href whose tab now belongs to a different epic", () => {
    useEpicCanvasStore.setState({ tabsById: { t1: tab("t1", "e1") } });
    expect(isHistoryEntryDead("/epics/e2/t1")).toBe(true);
  });

  it("keeps a nested href whose pane and tile still resolve in the exact tab canvas", () => {
    useEpicCanvasStore.setState({
      tabsById: { t1: tab("t1", "e1") },
      canvasByTabId: {
        t1: canvas(pane("pane-1", ["tile-1"], "tile-1"), {
          "tile-1": artifactTile("tile-1"),
        }),
      },
    });

    expect(
      isHistoryEntryDead(
        "/epics/e1/t1?focusPaneId=pane-1&focusTileInstanceId=tile-1",
      ),
    ).toBe(false);
  });

  it("prunes nested hrefs whose pane is missing from the exact tab canvas", () => {
    useEpicCanvasStore.setState({
      tabsById: { t1: tab("t1", "e1") },
      canvasByTabId: {
        t1: canvas(pane("pane-live", ["tile-1"], "tile-1"), {
          "tile-1": artifactTile("tile-1"),
        }),
      },
    });

    expect(
      isHistoryEntryDead(
        "/epics/e1/t1?focusPaneId=pane-stale&focusTileInstanceId=tile-1",
      ),
    ).toBe(true);
  });

  it("prunes nested hrefs whose tile is not in the target pane", () => {
    useEpicCanvasStore.setState({
      tabsById: { t1: tab("t1", "e1") },
      canvasByTabId: {
        t1: canvas(pane("pane-1", ["tile-1"], "tile-1"), {
          "tile-1": artifactTile("tile-1"),
          "tile-other": artifactTile("tile-other"),
        }),
      },
    });

    expect(
      isHistoryEntryDead(
        "/epics/e1/t1?focusPaneId=pane-1&focusTileInstanceId=tile-other",
      ),
    ).toBe(true);
  });

  it("keeps pane-only nested hrefs while the pane exists, even when empty", () => {
    useEpicCanvasStore.setState({
      tabsById: { t1: tab("t1", "e1") },
      canvasByTabId: {
        t1: canvas(pane("pane-empty", [], null), {}),
      },
    });

    expect(isHistoryEntryDead("/epics/e1/t1?focusPaneId=pane-empty")).toBe(
      false,
    );
  });

  it("keeps nested hrefs targeting a live blank tile", () => {
    useEpicCanvasStore.setState({
      tabsById: { t1: tab("t1", "e1") },
      canvasByTabId: {
        t1: canvas(pane("pane-1", ["blank-1"], "blank-1"), {
          "blank-1": blankTile("blank-1"),
        }),
      },
    });

    expect(
      isHistoryEntryDead(
        "/epics/e1/t1?focusPaneId=pane-1&focusTileInstanceId=blank-1",
      ),
    ).toBe(false);
  });

  it("keeps a draft href whose id is present in the landing-draft store", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    expect(isHistoryEntryDead(`/draft/${draftId}`)).toBe(false);
  });

  it("prunes a draft href whose id is absent from the store", () => {
    expect(isHistoryEntryDead("/draft/missing-draft-id")).toBe(true);
  });

  it("never prunes the /draft/new route even with an empty store", () => {
    expect(isHistoryEntryDead("/draft/new")).toBe(false);
  });
});
