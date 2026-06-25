import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { ForkedChatLinkSegment } from "@/components/chat/segments/forked-chat-link-segment";

const SOURCE_CHAT: EpicNodeRef = {
  id: "source-chat-1",
  instanceId: "source-chat-instance",
  type: "chat",
  name: "Original chat",
  hostId: "source-host-1",
};

const FORK_CHAT: EpicNodeRef = {
  id: "fork-chat-1",
  instanceId: "fork-chat-instance",
  type: "chat",
  name: "Forked chat",
  hostId: "fork-host-1",
};

describe("<ForkedChatLinkSegment />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
  });

  it("focuses the source chat in the current view tab without creating a duplicate epic tab", () => {
    const store = useEpicCanvasStore.getState();
    const viewTabId = store.openEpicTab("epic-1", "Epic");
    store.openTileInTab(viewTabId, SOURCE_CHAT);
    store.openTileInTab(viewTabId, FORK_CHAT);

    render(
      <ForkedChatLinkSegment
        viewTabId={viewTabId}
        sourceChatId={SOURCE_CHAT.id}
        sourceChatTitle={SOURCE_CHAT.name}
        sourceHostId={SOURCE_CHAT.hostId}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `Open source conversation ${SOURCE_CHAT.name}`,
      }),
    );

    const state = useEpicCanvasStore.getState();
    expect(state.openTabOrder).toEqual([viewTabId]);
    expect(Object.keys(state.tabsById)).toEqual([viewTabId]);

    const canvas = state.canvasByTabId[viewTabId];
    if (canvas === undefined) throw new Error("expected view tab canvas");
    const panes = collectPanes(canvas.root);
    expect(panes).toHaveLength(1);
    const pane = panes[0];

    expect(paneTabRefs(canvas, pane).map((tab) => tab.id)).toEqual([
      SOURCE_CHAT.id,
      FORK_CHAT.id,
    ]);
    expect(pane.activeTabId).toBe(SOURCE_CHAT.instanceId);
  });
});
