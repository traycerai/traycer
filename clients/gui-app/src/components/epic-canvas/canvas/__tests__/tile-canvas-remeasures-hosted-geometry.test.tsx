import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SplitPaneComponentProps } from "@/components/epic-canvas/canvas/split-container";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import {
  group,
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { makeGitFileDiffTile } from "@/lib/git/git-diff-tile";
import {
  registerTileSurfaceGeometryHost,
  registerTileSurfaceGeometrySlot,
  remeasureTileSurfaceGeometry,
  resetTileSurfaceGeometryCoordinatorForTesting,
  type TileSurfaceRect,
} from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";

/**
 * The global `MockResizeObserver` installed by `test-browser-apis.ts` is a
 * total no-op - it never invokes its callback. Installing a controllable
 * replacement at MODULE LOAD TIME (before any test body runs, so it is in
 * place before the coordinator's lazily-constructed singleton observer is
 * ever created) lets this suite prove a ResizeObserver callback never fires
 * for a position-only pane move - the real-world condition this test pins.
 * Mirrors `top-level-tab-host.test.tsx`'s "Reverse views" block and
 * `tile-surface-geometry-coordinator.test.ts`.
 */
class ControllableResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ControllableResizeObserver,
});

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

vi.mock("@/components/epic-canvas/canvas/tab-group-view", () => ({
  TabGroupView: (props: { readonly pane: SplitPaneComponentProps["pane"] }) => (
    <div
      data-testid="tab-group-view"
      data-pane-id={props.pane.id}
      data-tab-count={props.pane.tabInstanceIds.length}
    />
  ),
}));

// `TileCanvas` is imported only after every `vi.mock` above is registered,
// matching `tile-canvas-empty-epic.test.tsx`'s ordering requirement.
import { TileCanvas } from "@/components/epic-canvas/canvas/tile-canvas";

const EPIC_ID = "epic-remeasure";
const TAB_ID = "tab-remeasure";
const PANE_CHAT = "p-chat";
const PANE_DIFF = "p-diff";
const CHAT_INSTANCE_ID = "chat-1";
const DIFF_INSTANCE_ID = "diff-1";

function fakeRect(rect: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): DOMRect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  };
}

function stubRect(
  element: Element,
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
): void {
  element.getBoundingClientRect = () => fakeRect(rect);
}

/**
 * Seeds a canvas for `TAB_ID` whose root is a horizontal group of two
 * panes: `p-chat` holds a chat tile (`chat-1`), `p-diff` holds a git-diff
 * tile (`diff-1`) - the DOM shape a chat pane sitting beside a git-diff
 * pane starts from, before the edge drop this test performs.
 */
function seedSplitCanvas(): void {
  const diffTile = {
    ...makeGitFileDiffTile({
      hostId: TEST_HOST_ID,
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
      repositoryContext: null,
    }),
    instanceId: DIFF_INSTANCE_ID,
  };

  useEpicCanvasStore.setState((state) => ({
    ...state,
    canvasByTabId: {
      ...state.canvasByTabId,
      [TAB_ID]: {
        root: group("root-split", "horizontal", [
          pane(PANE_CHAT, [CHAT_INSTANCE_ID]),
          pane(PANE_DIFF, [DIFF_INSTANCE_ID]),
        ]),
        activePaneId: PANE_CHAT,
        tilesByInstanceId: {
          [CHAT_INSTANCE_ID]: {
            id: CHAT_INSTANCE_ID,
            instanceId: CHAT_INSTANCE_ID,
            type: "chat" as const,
            name: "Chat 1",
            hostId: TEST_HOST_ID,
          },
          [DIFF_INSTANCE_ID]: diffTile,
        },
        sizesByGroupId: {},
      },
    },
  }));
}

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
    .seedEpic(EPIC_ID, { tabId: TAB_ID, name: "Remeasure Epic" }, []);
}

/**
 * `TileCanvas` re-measures hosted geometry (`remeasureTileSurfaceGeometry`)
 * in a `useLayoutEffect` keyed on `[root, sizesByGroupId]`
 * (`tile-canvas.tsx`, `TileCanvasLive`), because a structural placement
 * change - dropping a git-diff tab on the LEFT EDGE of the only other pane
 * in a 50/50 split - inserts a new pane on that side and closes the emptied
 * source, so the chat pane keeps its exact width and only its `left` offset
 * changes. A `ResizeObserver` reports SIZE changes only, so nothing about
 * that move reaches the coordinator on its own. This test never mounts
 * `StableTileSurfaceHost`: it registers the geometry host/slot directly
 * (the same seam `StableTileSurfaceHost` uses in production) and asserts
 * the registered listener is re-invoked with the POST-split rect purely
 * from `TileCanvas`'s own tree-structure remeasure, with the
 * `ControllableResizeObserver` above never triggered.
 */
describe("TileCanvas re-measures hosted geometry on a position-only placement change (edge drop)", () => {
  let rects: TileSurfaceRect[] = [];

  beforeEach(() => {
    resetTileSurfaceGeometryCoordinatorForTesting();
    resetCanvasStore();
    useInitialChatHandoffStore.getState().resetForTests();
    rects = [];
  });

  afterEach(() => {
    cleanup();
    resetTileSurfaceGeometryCoordinatorForTesting();
    resetCanvasStore();
    useInitialChatHandoffStore.getState().resetForTests();
  });

  it("re-applies the chat slot's rect when an edge drop moves its pane without resizing it, with no ResizeObserver callback", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 1000, height: 600 });
    registerTileSurfaceGeometryHost(host);

    const anchor = document.createElement("div");
    // The chat pane fills the left half before the drop.
    stubRect(anchor, { left: 0, top: 0, width: 500, height: 600 });
    registerTileSurfaceGeometrySlot(CHAT_INSTANCE_ID, anchor, (rect) =>
      rects.push(rect),
    );
    // Registration delivers an initial rect synchronously - clear it so the
    // assertions below are scoped to what the edge drop itself produces.
    rects.length = 0;

    seedSplitCanvas();

    render(<TileCanvas epicId={EPIC_ID} tabId={TAB_ID} />);

    // `TileCanvasLive`'s remeasure layout effect also fires unconditionally
    // on mount (its deps are the INITIAL `root`/`sizesByGroupId`), which
    // re-delivers the still-current (pre-drop) rect to the listener above.
    // Clear that mount delivery so the negative control and the post-drop
    // assertion below are scoped to the edge drop alone.
    rects.length = 0;

    // The chat pane's DOM position after the drop: the new pane lands on
    // its left, so the chat pane itself shifts right by its own width while
    // keeping that exact width - a position-only move a ResizeObserver
    // cannot see.
    stubRect(anchor, { left: 500, top: 0, width: 500, height: 600 });

    // Negative control: nothing has re-measured yet. The RO stub above is
    // controllable and untriggered, and re-stubbing `getBoundingClientRect`
    // is a plain data mutation - it does not itself invoke any listener.
    // This proves the RO path alone cannot see the upcoming move.
    expect(rects).toEqual([]);

    act(() => {
      // Drop the git-diff tab from `p-diff` onto the LEFT edge of `p-chat`:
      // the public store action `splitPaneWithTab` is exactly what
      // `commitArtifactTabDrop` (`root-dnd-commits.ts`) calls for a real
      // edge drop. `p-diff` holds a single tab, so it is emptied and closed
      // by the same commit - the chat pane keeps its width and only its
      // `left` offset changes.
      useEpicCanvasStore.getState().splitPaneWithTab(TAB_ID, {
        sourcePaneId: PANE_DIFF,
        tabId: DIFF_INSTANCE_ID,
        targetPaneId: PANE_CHAT,
        position: "left",
      });
    });

    const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    if (canvas === undefined || canvas.root === null) {
      throw new Error("expected a live canvas root after the edge drop");
    }
    const root = canvas.root;
    if (root.kind !== "group" || root.children.length !== 2) {
      throw new Error("expected a two-child group after the edge drop");
    }
    const [firstChild, secondChild] = root.children;
    expect(secondChild.kind).toBe("pane");
    expect(secondChild.kind === "pane" ? secondChild.id : null).toBe(PANE_CHAT);
    // The original right pane (`p-diff`) is gone - the new pane took its
    // place on the left and the emptied source collapsed.
    expect(firstChild.kind === "pane" ? firstChild.id : null).not.toBe(
      PANE_DIFF,
    );

    // The tree change alone (no RO callback ever fired) delivered exactly
    // one rect update, at the post-drop position.
    expect(rects).toEqual([{ left: 500, top: 0, width: 500, height: 600 }]);

    // Direct sanity check on the coordinator itself: an explicit remeasure
    // right now (same rect, still unmoved) applies again with no error,
    // confirming the registration survived the drop's re-render.
    rects.length = 0;
    remeasureTileSurfaceGeometry();
    expect(rects).toEqual([{ left: 500, top: 0, width: 500, height: 600 }]);
  });
});
