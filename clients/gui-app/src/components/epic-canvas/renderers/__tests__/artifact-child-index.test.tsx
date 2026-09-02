import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nestedFocusBoundaryMock } from "@/__tests__/nested-focus-boundary-mock";
import { ArtifactChildIndex } from "@/components/epic-canvas/renderers/artifact-child-index";
import { readEpicCanvasDragSourceData } from "@/components/epic-canvas/dnd/dnd";
import { openTileWithNavigation } from "@/lib/canvas/tile-open/open-tile";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

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
  openTile: vi.fn((_intent: TileOpenIntent): NestedFocusTarget | null => null),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useChildIdsOf: (parentId: string) =>
    projection.childIdsByParent[parentId] ?? [],
  useTreeNodeById: (nodeId: string) => projection.nodesById[nodeId] ?? null,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({
    openTile: navigation.openTile,
  }),
}));

// `importOriginal` so the real `tilePlacement` defaults (and the module's
// other exports) survive: the click path runs the real `openTile` seam, which
// reads placement off `useSettingsStore.getState()`.
vi.mock("@/stores/settings/settings-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/settings/settings-store")>();
  const state = {
    artifactIconColorMode: "byType",
    artifactIconColors: {
      spec: "#fbbf24",
      ticket: "#a78bfa",
      story: "#34d399",
      review: "#fb7185",
    },
    tilePlacement: actual.DEFAULT_TILE_PLACEMENT_SETTINGS,
  };
  return {
    ...actual,
    useSettingsStore: Object.assign(
      (selector: (settingsState: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

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
    nestedFocusBoundaryMock.navigateNested.mockClear();
    navigation.openTile.mockImplementation(
      (intent: TileOpenIntent): NestedFocusTarget | null =>
        openTileWithNavigation(intent, nestedFocusBoundaryMock.navigateNested),
    );
    projection.childIdsByParent = {};
    projection.nodesById = {};
    navigation.openTile.mockClear();
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

    // A revert to a raw canvas `prepareOpenTilePreviewInTabFocusTarget` call
    // would still mutate the store, but would not hit this route-aware
    // boundary spy.
    expect(navigation.openTile).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: viewTabId },
        gesture: "single",
        dedupe: true,
        modifiers: { shift: false, alt: false, middle: false },
        placement: null,
        node: expect.objectContaining({
          id: "child-story",
          type: "story",
          name: "Child Story",
          hostId: "host-1",
        }) as EpicCanvasTileRef,
      }),
    );
    expect(nestedFocusBoundaryMock.navigateNested).toHaveBeenCalledWith(
      "epic-1",
      viewTabId,
      expect.any(Function),
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
