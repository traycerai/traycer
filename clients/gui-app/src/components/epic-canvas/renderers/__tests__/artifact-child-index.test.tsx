import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactChildIndex } from "@/components/epic-canvas/renderers/artifact-child-index";
import { readEpicCanvasDragSourceData } from "@/components/epic-canvas/dnd/dnd";

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

const canvas = vi.hoisted(() => ({
  openTilePreviewInTab: vi.fn(),
}));

const resolveTabIdForEpic = vi.hoisted(() =>
  vi.fn((_state: typeof canvas, _epicId: string) => "resolved-tab"),
);

const dnd = vi.hoisted(() => ({
  draggables: [] as CapturedDraggable[],
  setNodeRef: vi.fn(),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useChildIdsOf: (parentId: string) =>
    projection.childIdsByParent[parentId] ?? [],
  useTreeNodeById: (nodeId: string) => projection.nodesById[nodeId] ?? null,
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (selector: (state: typeof canvas) => unknown) =>
    selector(canvas),
  resolveTabIdForEpic,
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
    projection.childIdsByParent = {};
    projection.nodesById = {};
    canvas.openTilePreviewInTab.mockClear();
    resolveTabIdForEpic.mockClear();
    dnd.draggables = [];
    dnd.setNodeRef.mockClear();
  });

  afterEach(cleanup);

  it("emits a draggable artifact payload while preserving click-to-preview", () => {
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
        viewTabId="view-tab-1"
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
      viewTabId: "view-tab-1",
      artifact: {
        id: "child-story",
        type: "story",
        name: "Child Story",
        hostId: "host-1",
      },
    });
    expect(resolveTabIdForEpic).not.toHaveBeenCalled();

    fireEvent.click(row);

    expect(canvas.openTilePreviewInTab).toHaveBeenCalledWith(
      "view-tab-1",
      expect.objectContaining({
        id: "child-story",
        type: "story",
        name: "Child Story",
        hostId: "host-1",
      }),
    );
  });

  it("does not render or enable drag for non-artifact child nodes", () => {
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
        viewTabId="view-tab-1"
        hostId="host-1"
      />,
    );

    expect(screen.queryByRole("button", { name: "Child Chat" })).toBeNull();
    expect(dnd.draggables).toHaveLength(1);
    expect(dnd.draggables[0].disabled).toBe(true);
    expect(dnd.draggables[0].data).toBeUndefined();
  });
});
