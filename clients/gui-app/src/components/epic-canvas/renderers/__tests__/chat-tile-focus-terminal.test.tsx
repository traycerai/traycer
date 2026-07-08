import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nestedFocusBoundaryMock } from "@/__tests__/nested-focus-boundary-mock";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useFocusEpicTerminalSession } from "@/components/epic-canvas/renderers/chat-tile-focus-terminal";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

const EPIC_ID = "epic-1";
const HOST_ID = "host-1";

const EXISTING_TERMINAL: EpicTerminalRef = {
  id: "term-existing",
  instanceId: "inst-term-existing",
  type: "terminal",
  name: "shell",
  titleSource: "manual",
  hostId: HOST_ID,
  cwd: "/work/repo",
};

function renderFocusHook(viewTabId: string) {
  return renderHook(() => useFocusEpicTerminalSession(viewTabId), {
    wrapper: (props: { children: React.ReactNode }) => (
      <TabHostProvider hostId={HOST_ID}>{props.children}</TabHostProvider>
    ),
  });
}

describe("useFocusEpicTerminalSession", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    nestedFocusBoundaryMock.navigateNested.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("routes focusing an already-open terminal through the nested-focus boundary", () => {
    const store = useEpicCanvasStore.getState();
    const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
    store.openTileInTab(viewTabId, EXISTING_TERMINAL);
    // Steal focus onto a second tile so the click has to move it back.
    const otherTerminal: EpicTerminalRef = {
      ...EXISTING_TERMINAL,
      id: "term-other",
      instanceId: "inst-term-other",
    };
    store.openTileInTab(viewTabId, otherTerminal);

    const { result } = renderFocusHook(viewTabId);
    act(() => {
      result.current(EXISTING_TERMINAL.id, EXISTING_TERMINAL.cwd);
    });

    // A revert to raw `setActiveTilePane`/`setActiveTileTab` calls would never
    // invoke this spy, so this assertion fails against the pre-fix code path.
    expect(nestedFocusBoundaryMock.navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      viewTabId,
      expect.any(Function),
    );

    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    if (canvas === undefined) throw new Error("expected view tab canvas");
    const pane = collectPanes(canvas.root)[0];
    expect(pane.activeTabId).toBe(EXISTING_TERMINAL.instanceId);
  });

  it("routes opening a not-yet-open terminal through the nested-focus boundary", () => {
    const store = useEpicCanvasStore.getState();
    const viewTabId = store.openEpicTab(EPIC_ID, "Epic");

    const { result } = renderFocusHook(viewTabId);
    act(() => {
      result.current("term-new", "/work/new-repo");
    });

    expect(nestedFocusBoundaryMock.navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      viewTabId,
      expect.any(Function),
    );

    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    if (canvas === undefined) throw new Error("expected view tab canvas");
    const pane = collectPanes(canvas.root)[0];
    const activeTile = canvas.tilesByInstanceId[pane.activeTabId ?? ""] ?? null;
    expect(activeTile?.id).toBe("term-new");
    if (activeTile === null || activeTile.type !== "terminal") {
      throw new Error("expected an active terminal tile");
    }
    expect(activeTile.hostId).toBe(HOST_ID);
    expect(activeTile.cwd).toBe("/work/new-repo");
  });

  it("is a no-op for a null or empty session id", () => {
    const store = useEpicCanvasStore.getState();
    const viewTabId = store.openEpicTab(EPIC_ID, "Epic");

    const { result } = renderFocusHook(viewTabId);
    act(() => {
      result.current(null, "/work/repo");
      result.current("", "/work/repo");
    });

    expect(nestedFocusBoundaryMock.navigateNested).not.toHaveBeenCalled();
    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    expect(canvas?.root).toBeNull();
  });
});
