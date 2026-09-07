import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSnapshotUnifiedPatch } from "@/lib/diff/snapshot-diff-patch";
import { diffLineCountsFromContents } from "@/lib/file-change-diff-hunks";
import { makeSnapshotCumulativeBundleDiffTile } from "@/lib/chat/snapshot-diff-tile";
import type { SnapshotBundleSectionEntry } from "@/lib/chat/snapshot-bundle-section-entries";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { SnapshotDiffTileRef } from "@/stores/epics/canvas/types";
import type { BundleDiffTileFindRenderer } from "@/components/diff/bundle-diff-find-registration-hooks";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import type {
  BundleDiffFindFileInput,
  DiffTileFindSource,
} from "@/stores/tile-find";
import {
  SnapshotBundleDiffTileContent,
  type SnapshotCumulativeBundleDiffTileRef,
} from "@/components/epic-canvas/renderers/snapshot-bundle-diff-tile-content";

// The real hook's argument shape - tracked via the wrapping mock below so a
// `.pdf` entry's computed `coverageState` can be asserted without replacing
// the hook's return, which the notifySectionMounted/registerLoadedPatch
// assertions below still depend on.
interface RegisterBundleDiffTileFindAdapterCall {
  readonly tileInstanceId: string;
  readonly tileKind: TileKindId;
  readonly files: ReadonlyArray<BundleDiffFindFileInput>;
  readonly contentIdentity: string;
  readonly renderer: BundleDiffTileFindRenderer;
  readonly sourceOverride: DiffTileFindSource | null;
}

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
  // Tracked so the coverage-state test can assert what `files` the content
  // component computed per entry, rather than only what the mocked
  // registration hook returns.
  useRegisterBundleDiffTileFindAdapter:
    vi.fn<(args: RegisterBundleDiffTileFindAdapterCall) => void>(),
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
      useRegisterBundleDiffTileFindAdapter: (
        args: RegisterBundleDiffTileFindAdapterCall,
      ) => {
        testState.useRegisterBundleDiffTileFindAdapter(args);
        return {
          notifySectionMounted: testState.notifySectionMounted,
          registerCoverageState: vi.fn(),
          registerLoadedPatch: testState.registerLoadedPatch,
          unregisterLoadedPatch: vi.fn(),
        };
      },
    };
  },
);

vi.mock("@/components/diff/diff-content-primitive", () => ({
  DiffContentFrame: (props: { readonly children: ReactNode }) => (
    <div data-testid="diff-frame">{props.children}</div>
  ),
  DiffContentPrimitive: () => <div data-testid="diff-primitive" />,
}));

/*
 * Counting PASSTHROUGHS, not stubs: every test in this file still gets the
 * real patch/counts for a text entry. Only the PDF-skip test below reads the
 * call list, to pin that a PDF entry's (possibly ASCII-authored, possibly
 * large) contents never reach either function.
 */
vi.mock("@/lib/diff/snapshot-diff-patch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/diff/snapshot-diff-patch")>();
  return {
    ...actual,
    buildSnapshotUnifiedPatch: vi.fn(actual.buildSnapshotUnifiedPatch),
  };
});

vi.mock("@/lib/file-change-diff-hunks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/file-change-diff-hunks")>();
  return {
    ...actual,
    diffLineCountsFromContents: vi.fn(actual.diffLineCountsFromContents),
  };
});

const ENTRY: SnapshotBundleSectionEntry = {
  filePath: "src/app.ts",
  beforeContent: "old();\n",
  afterContent: "new();\n",
  operation: "edit",
  reason: "snapshot",
};

const PDF_ENTRY: SnapshotBundleSectionEntry = {
  filePath: "docs/report.pdf",
  beforeContent: null,
  afterContent: null,
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
    testState.useRegisterBundleDiffTileFindAdapter.mockClear();
    vi.mocked(buildSnapshotUnifiedPatch).mockClear();
    vi.mocked(diffLineCountsFromContents).mockClear();
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

  // `snapshotBundleFileCoverageState` checks the PDF extension BEFORE the
  // reason check - a PDF's blobs are never captured, so it must read as
  // "binary" (the same terminal coverage the git bundle gives its media
  // rows) rather than as an "unloaded" file that was simply never searched.
  it("computes binary coverage state for a .pdf bundle entry", () => {
    const node = snapshotBundleNode();

    render(
      <TooltipProvider>
        <SnapshotBundleDiffTileContent
          node={node}
          viewTabId="view-1"
          entries={[ENTRY, PDF_ENTRY]}
        />
      </TooltipProvider>,
    );

    const registration =
      testState.useRegisterBundleDiffTileFindAdapter.mock.calls.at(-1)?.[0];
    if (registration === undefined) {
      throw new Error("expected a bundle find-adapter registration");
    }
    const pdfFile = registration.files.find(
      (file) => file.filePath === PDF_ENTRY.filePath,
    );
    if (pdfFile === undefined) {
      throw new Error("expected a files entry for the PDF path");
    }
    expect(pdfFile.coverageState).toBe("binary");
    const textFile = registration.files.find(
      (file) => file.filePath === ENTRY.filePath,
    );
    expect(textFile?.coverageState).toBe("unloaded");
  });

  // A PDF row renders a placeholder, never a text diff - `buildSnapshotUnifiedPatch`
  // and `diffLineCountsFromContents` must not be handed its (possibly
  // ASCII-authored, possibly large) contents. A sibling text entry in the
  // same bundle still gets both calls.
  it("skips buildSnapshotUnifiedPatch and diffLineCountsFromContents for a .pdf bundle entry", () => {
    const node = snapshotBundleNode();

    render(
      <TooltipProvider>
        <SnapshotBundleDiffTileContent
          node={node}
          viewTabId="view-1"
          entries={[ENTRY, PDF_ENTRY]}
        />
      </TooltipProvider>,
    );

    const patchCalls = vi.mocked(buildSnapshotUnifiedPatch).mock.calls;
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]?.[0].filePath).toBe(ENTRY.filePath);

    const countCalls = vi.mocked(diffLineCountsFromContents).mock.calls;
    expect(countCalls).toHaveLength(1);
    expect(countCalls[0]?.[0]).toBe(ENTRY.beforeContent);
    expect(countCalls[0]?.[1]).toBe(ENTRY.afterContent);
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
