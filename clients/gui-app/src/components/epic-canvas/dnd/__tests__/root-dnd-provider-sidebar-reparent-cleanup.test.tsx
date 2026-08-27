/**
 * Task 4.3a - the structural half of the fix, in `handleDragEnd`
 * (`root-dnd-provider.tsx`). Before the fix, the four end-of-drag cleanup
 * lines - `dragEnded()` included - sat AFTER the `commitSidebarReparentDrop`
 * call with no try/catch: a throw out of the commit (the doc-only
 * terminal-agent -> record-backed-chat pairing this ticket fixes, or any
 * future one) skipped every one of them and wedged the store mid-drag with
 * stale refs until the tree remounted.
 *
 * `commitSidebarReparentDrop` itself no longer throws for that specific
 * pairing (see `sidebar-reparent-commit-doc-projected-agreement.test.ts` -
 * it is caught one layer down now). So the only way to exercise THIS file's
 * belt-and-suspenders - the provider's own try/catch/finally around the
 * commit call - is to force the commit to throw for some OTHER reason and
 * prove the drag still ends. That is deliberately a stub, not the real
 * throw: this test's subject is the provider's cleanup structure, not the
 * doc/projected divergence (which the sibling test above drives for real).
 *
 * Drives the REAL `RootDndProvider` with a real dnd-kit pointer gesture
 * (mirrors `root-dnd-provider-t9-round4.test.tsx`) - a `sidebar-node` drag
 * released over a `sidebar-reparent-row` target - against a real open-epic
 * store registered in the real session registry, so the collision/preview
 * layer's `canReparentProjected` pre-flight (which reads the live store) is
 * exercised unstubbed.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as Y from "yjs";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import {
  SIDEBAR_NODE_DND_TYPE,
  getSidebarNodeDragId,
  getSidebarReparentRowDropId,
  type EpicCanvasDropTargetData,
  type EpicCanvasSidebarNodeDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { createArtifactInDocForTests } from "@/stores/epics/open-epic/__tests__/projection-helpers-test-shims";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

const commitSeam = vi.hoisted(() => ({
  commitSidebarReparentDrop: vi.fn(() => {
    throw new Error("commit boom - forces the provider's own catch/finally");
  }),
}));

vi.mock(
  "@/components/epic-canvas/dnd/root-dnd-commits",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/epic-canvas/dnd/root-dnd-commits")
      >();
    return {
      ...actual,
      commitSidebarReparentDrop: commitSeam.commitSidebarReparentDrop,
    };
  },
);

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-1",
      title: "Epic test",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

function newSession(): OpenEpicStoreHandle {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = createOpenEpicStore({
    epicId: "epic-1",
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  const seed = Y.encodeStateAsUpdate(new Y.Doc());
  captured.value.onSnapshot(makeMeta(), seed);
  return handle;
}

const queryClient = new QueryClient();

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

function SidebarNodeDragSource(props: {
  readonly data: EpicCanvasSidebarNodeDragData;
}): ReactNode {
  const { listeners, setNodeRef } = useDraggable({
    id: getSidebarNodeDragId(props.data.nodeId),
    data: props.data,
  });
  return (
    <button ref={setNodeRef} data-testid="sidebar-drag-source" {...listeners}>
      drag
    </button>
  );
}

function SidebarReparentRowDropTarget(props: {
  readonly nodeId: string;
}): ReactNode {
  const data: EpicCanvasDropTargetData = {
    kind: "sidebar-reparent-row",
    epicId: "epic-1",
    viewTabId: "tab-1",
    nodeId: props.nodeId,
    panelId: "artifacts",
  };
  const { setNodeRef } = useDroppable({
    id: getSidebarReparentRowDropId(props.nodeId),
    data,
  });
  return <div ref={setNodeRef} data-testid="sidebar-reparent-row-target" />;
}

function Harness(props: {
  readonly source: EpicCanvasSidebarNodeDragData;
  readonly targetNodeId: string;
}): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <RootDndProvider>
        <SidebarNodeDragSource data={props.source} />
        <SidebarReparentRowDropTarget nodeId={props.targetNodeId} />
      </RootDndProvider>
    </QueryClientProvider>
  );
}

function buildRouter(harness: () => ReactNode) {
  const rootRoute = createRootRoute({ component: harness });
  const routeTree = rootRoute.addChildren([]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

describe("RootDndProvider ends the drag even when commitSidebarReparentDrop throws", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    useEpicDndStore.setState(useEpicDndStore.getInitialState(), true);
    __getOpenEpicRegistryForTests().disposeAll();
  });

  beforeEach(() => {
    commitSeam.commitSidebarReparentDrop.mockClear();
  });

  it("resets the drag store's reparent preview and drops the pending reparent ref through the finally, even though the commit throws", async () => {
    const handle = newSession();
    const child = createArtifactInDocForTests(handle.doc, "spec", null);
    const parent = createArtifactInDocForTests(handle.doc, "spec", null);
    __getOpenEpicRegistryForTests().acquireMounted("epic-1", () => handle);

    const source: EpicCanvasSidebarNodeDragData = {
      kind: SIDEBAR_NODE_DND_TYPE,
      epicId: "epic-1",
      viewTabId: "tab-1",
      hostId: "host-1",
      nodeId: child,
    };

    const router = buildRouter(() => (
      <Harness source={source} targetNodeId={parent} />
    ));
    render(<RouterProvider router={router} />);
    const dragSource = await screen.findByTestId("sidebar-drag-source");
    const dropTarget = await screen.findByTestId("sidebar-reparent-row-target");
    vi.spyOn(dropTarget, "getBoundingClientRect").mockReturnValue(
      rect(200, 0, 400, 50),
    );

    act(() => {
      fireEvent.pointerDown(dragSource, {
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
    });
    act(() => {
      fireEvent.pointerMove(dragSource, {
        pointerId: 1,
        clientX: 30,
        clientY: 10,
      });
    });
    act(() => {
      fireEvent.pointerMove(dragSource, {
        pointerId: 1,
        clientX: 300,
        clientY: 10,
      });
    });

    // The reparent pre-flight (real store, real `canReparentProjected`) passed
    // and lit the row highlight - proof the gesture reached a valid reparent
    // target before the drop.
    expect(useEpicDndStore.getState().reparentTargetNodeId).toBe(parent);

    act(() => {
      fireEvent.pointerUp(dragSource, {
        pointerId: 1,
        clientX: 300,
        clientY: 10,
      });
    });

    expect(commitSeam.commitSidebarReparentDrop).toHaveBeenCalledTimes(1);
    // The stale highlight is exactly what a skipped `dragEnded()` would leave
    // behind - a dead sidebar reparent preview until the tree remounts.
    expect(useEpicDndStore.getState().reparentTargetNodeId).toBeNull();
    expect(useEpicDndStore.getState().reparentTargetViewTabId).toBeNull();
    expect(useEpicDndStore.getState().activeSource).toBeNull();
  });
});
