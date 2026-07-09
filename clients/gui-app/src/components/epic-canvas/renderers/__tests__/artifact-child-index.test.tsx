import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactChildIndex } from "@/components/epic-canvas/renderers/artifact-child-index";
import { readEpicCanvasDragSourceData } from "@/components/epic-canvas/dnd/dnd";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasTileRef,
  EpicNodeRef,
} from "@/stores/epics/canvas/types";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";

type TestTreeNode = {
  readonly type: string | null;
  readonly title: string;
  readonly status: number | null;
};

type CapturedDraggable = {
  readonly id: string;
  readonly disabled: boolean;
  readonly data: unknown;
};

const projection = vi.hoisted<{
  childIdsByParent: Record<string, readonly string[]>;
  nodesById: Record<string, TestTreeNode>;
}>(() => ({
  childIdsByParent: {},
  nodesById: {},
}));

const dnd = vi.hoisted(() => ({
  draggables: [] as CapturedDraggable[],
  setNodeRef: vi.fn(),
}));

const navigation = vi.hoisted(() => ({
  openTilePreviewInTab: vi.fn(
    (_tabId: string, _node: EpicCanvasTileRef): NestedFocusTarget | null =>
      null,
  ),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useChildIdsOf: (parentId: string) =>
    projection.childIdsByParent[parentId] ?? [],
  useTreeNodeById: (nodeId: string) => projection.nodesById[nodeId] ?? null,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({
    openTilePreviewInTab: navigation.openTilePreviewInTab,
    openTileInTab: vi.fn(),
    openTileInEpic: vi.fn(),
    openTilePreviewInEpic: vi.fn(),
  }),
}));

vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (
    selector: (state: {
      artifactIconColorMode: "byType";
      artifactIconColors: Record<string, string>;
    }) => unknown,
  ) =>
    selector({
      artifactIconColorMode: "byType",
      artifactIconColors: {
        spec: "#fbbf24",
        ticket: "#a78bfa",
        story: "#34d399",
        review: "#fb7185",
      },
    }),
}));

vi.mock("@/lib/logger", () => ({
  appLogger: {
    warn: vi.fn(),
  },
}));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    useDraggable: (input: CapturedDraggable) => {
      dnd.draggables.push({
        id: input.id,
        disabled: input.disabled,
        data: input.data,
      });
      return {
        attributes: { "data-dnd-attached": "true" },
        listeners: {},
        setNodeRef: dnd.setNodeRef,
        isDragging: false,
      };
    },
  };
});

describe("<ArtifactChildIndex />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    navigation.openTilePreviewInTab.mockImplementation(
      (tabId: string, node: EpicCanvasTileRef): NestedFocusTarget | null =>
        useEpicCanvasStore
          .getState()
          .prepareOpenTilePreviewInTabFocusTarget(tabId, node),
    );
    projection.childIdsByParent = {};
    projection.nodesById = {};
    navigation.openTilePreviewInTab.mockClear();
    dnd.draggables = [];
    dnd.setNodeRef.mockClear();
  });

  afterEach(cleanup);

  it("emits a draggable artifact payload while preserving click-to-preview", () => {
    const viewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-1", "Epic");
    projection.childIdsByParent.parent = ["child-story"];
    projection.nodesById["child-story"] = {
      type: "story",
      title: "Child Story",
      status: null,
    };

    render(
      <ArtifactChildIndex
        epicId="epic-1"
        parentId="parent"
        viewTabId={viewTabId}
        hostId="host-1"
      />,
    );

    const row = screen.getByRole("button", { name: "Child Story" });
    expect(row.getAttribute("data-dnd-attached")).toBe("true");
    expect(dnd.draggables).toHaveLength(1);
    expect(dnd.draggables[0].id).toMatch(/^chat-artifact:/);
    expect(dnd.draggables[0].disabled).toBe(false);
    expect(readEpicCanvasDragSourceData(dnd.draggables[0].data)).toEqual({
      kind: "chat-artifact",
      epicId: "epic-1",
      viewTabId,
      artifact: {
        id: "child-story",
        type: "story",
        name: "Child Story",
        hostId: "host-1",
      },
    });

    fireEvent.click(row);

    // A revert to a raw canvas `openTilePreviewInTab` call would still mutate
    // the store, but would not hit this route-aware boundary spy.
    expect(navigation.openTilePreviewInTab).toHaveBeenCalledWith(
      viewTabId,
      expect.objectContaining({
        id: "child-story",
        type: "story",
        name: "Child Story",
        hostId: "host-1",
      }),
    );
    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    if (canvas?.root?.kind !== "pane") throw new Error("expected pane");
    const activeTile =
      canvas.tilesByInstanceId[canvas.root.activeTabId ?? ""] ?? null;
    expect(activeTile).toMatchObject({
      id: "child-story",
      type: "story",
      name: "Child Story",
      hostId: "host-1",
    } satisfies Partial<EpicNodeRef>);
  });

  it("does not render or enable drag for non-artifact child nodes", () => {
    const viewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-1", "Epic");
    projection.childIdsByParent.parent = ["child-chat"];
    projection.nodesById["child-chat"] = {
      type: "chat",
      title: "Child Chat",
      status: null,
    };

    render(
      <ArtifactChildIndex
        epicId="epic-1"
        parentId="parent"
        viewTabId={viewTabId}
        hostId="host-1"
      />,
    );

    expect(screen.queryByRole("button", { name: "Child Chat" })).toBeNull();
    expect(dnd.draggables).toHaveLength(1);
    expect(dnd.draggables[0].disabled).toBe(true);
    expect(dnd.draggables[0].data).toBeUndefined();
  });
});
