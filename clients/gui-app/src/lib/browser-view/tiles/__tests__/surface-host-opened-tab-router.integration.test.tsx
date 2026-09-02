import "../../../../../__tests__/test-browser-apis";
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import { renderNestedFocusFixture } from "@/__tests__/nested-focus-router-harness";
import { createSingleTileCanvas } from "@/stores/epics/canvas/actions";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import {
  DEFAULT_TILE_PLACEMENT_SETTINGS,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import {
  setEpicSurfaceVisibility,
  surfaceHostOpenedTab,
} from "../surface-host-opened-tab";

const EPIC = "epic-router-surfacing";
const HOST = "host-1";
const SESSION = "session-popup";
const PRESENTING_TAB = "view-presenting";
const OTHER_TAB = "view-other";

let navigateNested: NavigateNestedFocus | null = null;

function NestedFocusProbe(): null {
  navigateNested = useEpicNestedFocusNavigation();
  return null;
}

function seedCanvases(): {
  readonly paneId: string;
  readonly otherCanvas: EpicCanvasState;
  readonly sourceInstanceId: string;
} {
  const source = makeBrowserSessionTileRef({
    hostId: HOST,
    sessionId: SESSION,
    tabId: "tab-source",
  });
  const presentingCanvas = createSingleTileCanvas(source);
  const pane = collectPanes(presentingCanvas.root).at(0);
  if (pane === undefined) throw new Error("expected presenting pane");

  const otherCanvas = createSingleTileCanvas(
    makeBrowserSessionTileRef({
      hostId: HOST,
      sessionId: "other-session",
      tabId: "other-tab",
    }),
  );
  useEpicCanvasStore.setState({
    tabsById: {
      [PRESENTING_TAB]: {
        tabId: PRESENTING_TAB,
        epicId: EPIC,
        name: "Presenting",
      },
      [OTHER_TAB]: { tabId: OTHER_TAB, epicId: EPIC, name: "Other" },
    },
    openTabOrder: [PRESENTING_TAB, OTHER_TAB],
    activeTabId: OTHER_TAB,
    canvasByTabId: {
      [PRESENTING_TAB]: presentingCanvas,
      [OTHER_TAB]: otherCanvas,
    },
  });
  return {
    paneId: pane.id,
    otherCanvas,
    sourceInstanceId: source.instanceId,
  };
}

describe("surfaceHostOpenedTab with the real nested-focus router", () => {
  beforeEach(() => {
    cleanup();
    navigateNested = null;
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useSettingsStore.setState({
      agentTabSurfacing: "off",
      tilePlacement: DEFAULT_TILE_PLACEMENT_SETTINGS,
    });
    setEpicSurfaceVisibility(EPIC, PRESENTING_TAB, true);
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    setEpicSurfaceVisibility(EPIC, PRESENTING_TAB, false);
  });

  it("mutates the presenter canvas and commits its popup focus to persistent history", async () => {
    const { paneId, otherCanvas, sourceInstanceId } = seedCanvases();
    const { router } = renderNestedFocusFixture(
      EPIC,
      PRESENTING_TAB,
      createElement(NestedFocusProbe),
    );
    await waitFor(() => {
      expect(navigateNested).not.toBeNull();
    });
    const navigate = navigateNested;
    if (navigate === null) throw new Error("expected router navigator");

    expect(
      surfaceHostOpenedTab({
        epicId: EPIC,
        viewTabId: PRESENTING_TAB,
        hostId: HOST,
        sessionId: SESSION,
        tabId: "tab-popup",
        source: "page",
        navigateNested: navigate,
      }),
    ).toBe(true);

    await waitFor(() => {
      const presenterCanvas = useEpicCanvasStore.getState().canvasByTabId[
        PRESENTING_TAB
      ];
      if (presenterCanvas === undefined) throw new Error("missing presenter");
      const presenterPane = collectPanes(presenterCanvas.root).at(0);
      if (presenterPane === undefined) throw new Error("missing presenter pane");
      const popupInstanceId = presenterPane.activeTabId;
      expect(presenterCanvas.activePaneId).toBe(paneId);
      expect(popupInstanceId).not.toBe(sourceInstanceId);
      expect(
        presenterCanvas.tilesByInstanceId[popupInstanceId ?? ""],
      ).toMatchObject({
        hostId: HOST,
        sessionId: SESSION,
        tabId: "tab-popup",
      });
      expect(useEpicCanvasStore.getState().canvasByTabId[OTHER_TAB]).toBe(
        otherCanvas,
      );
      expect(router.state.location.search).toMatchObject({
        focusPaneId: paneId,
        focusTileInstanceId: popupInstanceId,
      });
    });
  });
});
