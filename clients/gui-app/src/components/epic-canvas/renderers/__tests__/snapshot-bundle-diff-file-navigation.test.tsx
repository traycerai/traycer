import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSnapshotCumulativeBundleDiffTile } from "@/lib/chat/snapshot-diff-tile";
import type { SnapshotBundleSectionEntry } from "@/lib/chat/snapshot-bundle-section-entries";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { SnapshotDiffTileRef } from "@/stores/epics/canvas/types";
import {
  SnapshotBundleDiffTileContent,
  type SnapshotCumulativeBundleDiffTileRef,
} from "@/components/epic-canvas/renderers/snapshot-bundle-diff-tile-content";

interface VirtuosoMockProps {
  readonly data: ReadonlyArray<SnapshotBundleSectionEntry>;
  readonly itemContent: (
    index: number,
    item: SnapshotBundleSectionEntry,
  ) => ReactNode;
  readonly computeItemKey: (
    index: number,
    item: SnapshotBundleSectionEntry,
  ) => string;
}

const testState = vi.hoisted(() => ({
  navigateNested: vi.fn(
    (
      _epicId: string,
      _tabId: string,
      prepare: () => NestedFocusTarget | null,
    ) => prepare(),
  ),
  notifySectionMounted: vi.fn(),
  registerLoadedPatch: vi.fn(),
}));

vi.mock("react-virtuoso", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Virtuoso: React.forwardRef<unknown, VirtuosoMockProps>((props, ref) => {
      React.useImperativeHandle(ref, () => ({
        getState: (
          callback: (snapshot: { readonly scrollTop: number }) => void,
        ) => {
          callback({ scrollTop: 0 });
        },
      }));
      return (
        <div data-testid="virtuoso">
          {props.data.map((item, index) => (
            <div key={props.computeItemKey(index, item)}>
              {props.itemContent(index, item)}
            </div>
          ))}
        </div>
      );
    }),
  };
});

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => testState.navigateNested,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/scroll/use-bundle-diff-scroll-restoration", () => ({
  useBundleDiffScrollRestoration: () => ({
    virtuosoRef: { current: null },
    restoreStateFrom: undefined,
    isScrolling: undefined,
  }),
}));

vi.mock(
  "@/components/diff/bundle-diff-find-registration-hooks",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/diff/bundle-diff-find-registration-hooks")
      >();
    return {
      ...actual,
      useBundleDiffFindNavigation: () => ({
        setRootElement: vi.fn(),
      }),
      useRegisterBundleDiffTileFindAdapter: () => ({
        notifySectionMounted: testState.notifySectionMounted,
        registerCoverageState: vi.fn(),
        registerLoadedPatch: testState.registerLoadedPatch,
      }),
    };
  },
);

vi.mock("@/components/diff/diff-content-primitive", () => ({
  DiffContentFrame: (props: { readonly children: ReactNode }) => (
    <div data-testid="diff-frame">{props.children}</div>
  ),
  DiffContentPrimitive: () => <div data-testid="diff-primitive" />,
}));

const ENTRY: SnapshotBundleSectionEntry = {
  filePath: "src/app.ts",
  beforeContent: "old();\n",
  afterContent: "new();\n",
  operation: "edit",
  reason: "snapshot",
};

describe("<SnapshotBundleDiffTileContent /> file navigation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useSettingsStore.setState({
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
    testState.navigateNested.mockClear();
    testState.notifySectionMounted.mockClear();
    testState.registerLoadedPatch.mockClear();
  });

  afterEach(cleanup);

  it("routes the File button through nested focus as a committed open", () => {
    const viewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-1", "Epic");
    const node = snapshotBundleNode();

    render(
      <TooltipProvider>
        <SnapshotBundleDiffTileContent
          node={node}
          viewTabId={viewTabId}
          entries={[ENTRY]}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "File" }));

    // A revert to raw `openTileInTab` would not invoke this route-aware spy.
    expect(testState.navigateNested).toHaveBeenCalledWith(
      "epic-1",
      viewTabId,
      expect.any(Function),
    );
    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    if (canvas?.root?.kind !== "pane") throw new Error("expected pane");
    const activeTile =
      canvas.tilesByInstanceId[canvas.root.activeTabId ?? ""] ?? null;
    if (activeTile?.type !== "snapshot-diff") {
      throw new Error("expected active snapshot diff tile");
    }
    expect(activeTile.hostId).toBe("host-1");
    expect(activeTile.diff).toEqual({
      kind: "snapshot-cumulative",
      chatId: "chat-1",
      filePath: ENTRY.filePath,
    });
  });
});

function snapshotBundleNode(): SnapshotCumulativeBundleDiffTileRef {
  const node: SnapshotDiffTileRef = makeSnapshotCumulativeBundleDiffTile({
    hostId: "host-1",
    chatId: "chat-1",
    filePaths: [ENTRY.filePath],
  });
  if (node.diff.kind !== "snapshot-cumulative-bundle") {
    throw new Error("expected snapshot bundle node");
  }
  return {
    ...node,
    diff: node.diff,
  };
}
