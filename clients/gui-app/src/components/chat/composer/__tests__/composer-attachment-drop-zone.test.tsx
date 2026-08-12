import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useDraggable } from "@dnd-kit/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { ComposerAttachmentDropZone } from "@/components/chat/composer/composer-attachment-drop-zone";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "@/components/chat/composer/composer-prompt-editor";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "@/components/chat/composer/picker/composer-picker-store";
import {
  TERMINAL_TILE_DND_TYPE,
  WORKSPACE_FILE_DND_TYPE,
  type EpicCanvasDragSourceData,
} from "@/components/epic-canvas/dnd/dnd";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";

const { snapCenterToCursorSpy } = vi.hoisted(() => ({
  snapCenterToCursorSpy: vi.fn(),
}));

vi.mock("@dnd-kit/modifiers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/modifiers")>();
  return {
    ...actual,
    snapCenterToCursor: (
      args: Parameters<typeof actual.snapCenterToCursor>[0],
    ) => {
      snapCenterToCursorSpy(args.active?.data.current?.kind);
      return actual.snapCenterToCursor(args);
    },
  };
});

const VIEW_TAB_ID = "view-1";
const TARGET_HOST_ID = "host-1";

const FILE_SOURCE: EpicCanvasDragSourceData = {
  kind: WORKSPACE_FILE_DND_TYPE,
  epicId: "epic-1",
  viewTabId: VIEW_TAB_ID,
  ref: {
    id: "file-tab",
    instanceId: "file-instance",
    type: "workspace-file",
    name: "app.ts",
    hostId: "host-1",
    workspacePath: "/repo",
    filePath: "src/app.ts",
  },
};

const TERMINAL_SOURCE: EpicCanvasDragSourceData = {
  kind: TERMINAL_TILE_DND_TYPE,
  epicId: "epic-1",
  viewTabId: VIEW_TAB_ID,
  tile: {
    id: "terminal-1",
    instanceId: "terminal-instance",
    type: "terminal",
    name: "Terminal",
    titleSource: "default",
    hostId: "host-1",
    cwd: "/repo",
  },
};

afterEach(() => {
  cleanup();
  snapCenterToCursorSpy.mockClear();
  useEpicDndStore.getState().dragEnded();
});

describe("ComposerAttachmentDropZone root DnD contract", () => {
  it("drags a workspace file through RootDndProvider into the real editor", async () => {
    const { handleRef, source, target } = await renderHarness(FILE_SOURCE);

    await dragToTarget(source, target, true);

    await waitFor(() => {
      const nodes = handleRef.current?.getJSON().content?.[0]?.content ?? [];
      expect(nodes[0]).toMatchObject({
        type: "mention",
        attrs: {
          contextType: "file",
          path: "src/app.ts",
          absolutePath: "/repo/src/app.ts",
        },
      });
      expect(nodes[1]).toEqual({ type: "text", text: " " });
    });
    expect(snapCenterToCursorSpy).toHaveBeenCalledWith(WORKSPACE_FILE_DND_TYPE);
  });

  it("keeps raw terminals out while applying the shared overlay modifier", async () => {
    const { handleRef, source, target } = await renderHarness(TERMINAL_SOURCE);

    await dragToTarget(source, target, false);

    expect(handleRef.current?.isEmpty()).toBe(true);
    expect(snapCenterToCursorSpy).toHaveBeenCalledWith(TERMINAL_TILE_DND_TYPE);
  });

  it("keeps paths from another host out of a tab-bound composer", async () => {
    const { handleRef, source, target } = await renderHarness({
      ...FILE_SOURCE,
      ref: { ...FILE_SOURCE.ref, hostId: "host-2" },
    });

    await dragToTarget(source, target, false);

    expect(handleRef.current?.isEmpty()).toBe(true);
  });
});

async function renderHarness(sourceData: EpicCanvasDragSourceData): Promise<{
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
  readonly source: HTMLElement;
  readonly target: HTMLElement;
}> {
  const handleRef: { current: ComposerPromptEditorHandle | null } = {
    current: null,
  };
  const rootRoute = createRootRoute({
    component: () => <Harness source={sourceData} handleRef={handleRef} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => {
    expect(handleRef.current?.isReady()).toBe(true);
  });
  const source = screen.getByTestId("drag-source");
  const target = screen.getByTestId("drop-target").parentElement;
  if (target === null) throw new Error("Expected composer drop-zone wrapper");
  return { handleRef, source, target };
}

function Harness(props: {
  readonly source: EpicCanvasDragSourceData;
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
}): ReactNode {
  return (
    <RootDndProvider>
      <DragSource source={props.source} />
      <EditorDropTarget handleRef={props.handleRef} />
    </RootDndProvider>
  );
}

function DragSource(props: {
  readonly source: EpicCanvasDragSourceData;
}): ReactNode {
  const { listeners, setNodeRef } = useDraggable({
    id: "drag-source",
    data: props.source,
  });
  return (
    <button ref={setNodeRef} data-testid="drag-source" {...listeners}>
      drag
    </button>
  );
}

function EditorDropTarget({
  handleRef,
}: {
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
}): ReactNode {
  const [pickerStore] = useState<ComposerPickerStore>(() =>
    createComposerPickerStore(),
  );
  const setHandle = (handle: ComposerPromptEditorHandle | null): void => {
    handleRef.current = handle;
  };
  return (
    <ComposerAttachmentDropZone
      viewTabId={VIEW_TAB_ID}
      hostId={TARGET_HOST_ID}
      editorRef={handleRef}
    >
      <div data-testid="drop-target">
        <ComposerPromptEditor
          ref={setHandle}
          initialContent={emptyContent()}
          initialSelection={null}
          pickerStore={pickerStore}
          placeholder="test"
          editorClassName={undefined}
          isActive={false}
          disabled={false}
          slashProviderId="claude"
          hasPastedImageBytes={null}
          ingestPastedComposerImages={null}
          stabilizeImageAttachmentCaret={false}
          onDocumentChange={() => undefined}
          onSelectionChange={() => undefined}
          onSubmit={() => undefined}
          onPaste={() => undefined}
          onDragOver={() => undefined}
          onDrop={() => undefined}
          onKeyDown={undefined}
          onFocus={() => undefined}
          onBlur={() => undefined}
          onEditorReady={null}
        />
      </div>
    </ComposerAttachmentDropZone>
  );
}

async function dragToTarget(
  source: HTMLElement,
  target: HTMLElement,
  expectAttachmentOverlay: boolean,
): Promise<void> {
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
    rect(200, 0, 400, 100),
  );
  act(() => {
    fireEvent.pointerDown(source, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
  });
  act(() => {
    fireEvent.pointerMove(source, {
      pointerId: 1,
      clientX: 30,
      clientY: 10,
    });
  });
  act(() => {
    fireEvent.pointerMove(source, {
      pointerId: 1,
      clientX: 300,
      clientY: 20,
    });
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByText("Drop to attach") !== null).toBe(
    expectAttachmentOverlay,
  );
  act(() => {
    fireEvent.pointerUp(source, {
      pointerId: 1,
      clientX: 300,
      clientY: 20,
    });
  });
}

function rect(left: number, top: number, right: number, bottom: number) {
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

function emptyContent(): JsonContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}
