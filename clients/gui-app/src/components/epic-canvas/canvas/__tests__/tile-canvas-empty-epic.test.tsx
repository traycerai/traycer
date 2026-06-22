import "../../../../../__tests__/test-browser-apis";
import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import type { SplitPaneComponentProps } from "@/components/epic-canvas/canvas/split-container";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";

const EPIC_ID = "epic-empty";
const TAB_ID = "tab-empty";

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({ setNodeRef: () => undefined }),
}));

vi.mock(
  "@/components/epic-canvas/snapshots/snapshot-loading-context-value",
  () => ({
    useSnapshotLoading: () => ({
      snapshotLoaded: true,
      snapshotFetchError: null,
    }),
  }),
);

vi.mock("@/lib/epic-selectors", () => ({
  useEpicHasArtifactRecords: () => false,
}));

vi.mock("@/components/epic-canvas/canvas/split-container", () => ({
  SplitContainer: (props: {
    readonly root: SplitPaneComponentProps["pane"] | null;
    readonly PaneComponent: ComponentType<SplitPaneComponentProps>;
  }) =>
    props.root === null ? null : (
      <div data-testid="split-container" data-root-kind={props.root.kind}>
        <props.PaneComponent pane={props.root} />
      </div>
    ),
}));

vi.mock("@/components/epic-canvas/canvas/tab-group-view", () => ({
  TabGroupView: (props: { readonly pane: SplitPaneComponentProps["pane"] }) => (
    <div
      data-testid="tab-group-view"
      data-tab-count={props.pane.tabInstanceIds.length}
      data-active-tab={props.pane.activeTabId ?? ""}
    />
  ),
}));

import { TileCanvas } from "@/components/epic-canvas/canvas/tile-canvas";

function resetCanvasStore(): void {
  useEpicCanvasStore.setState({
    tabsById: {},
    canvasByTabId: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    artifactTreeByEpicId: {},
    selfDeletedArtifactIds: new Set<string>(),
    preAckRootCreatesByEpic: {},
    pendingRootCreatesByEpic: {},
  });
  useEpicCanvasStore
    .getState()
    .seedEpic(EPIC_ID, { tabId: TAB_ID, name: "Empty Epic" }, []);
}

beforeEach(() => {
  resetCanvasStore();
  useInitialChatHandoffStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
});

describe("<TileCanvas /> empty epic", () => {
  it("seeds the blank new-tab opener for a brand-new epic", async () => {
    render(
      <StrictMode>
        <TileCanvas epicId={EPIC_ID} tabId={TAB_ID} />
      </StrictMode>,
    );

    await waitFor(() => {
      const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
      if (canvas === undefined) {
        throw new Error("expected a seeded canvas");
      }
      const root = canvas.root;
      if (root?.kind !== "pane") {
        throw new Error("expected a seeded root pane");
      }
      expect(root.tabInstanceIds).toHaveLength(1);
      const tabId = root.tabInstanceIds[0];
      const tab = canvas.tilesByInstanceId[tabId];
      expect(tab?.type).toBe("blank");
      expect(tab?.name).toBe("New tab");
    });

    expect(screen.getByTestId("tab-group-view")).not.toBeNull();
  });
});
