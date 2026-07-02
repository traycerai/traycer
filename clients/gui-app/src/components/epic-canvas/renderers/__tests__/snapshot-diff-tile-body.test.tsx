import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
import { makeSnapshotCumulativeDiffTile } from "@/lib/chat/snapshot-diff-tile";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import {
  DEFAULT_DIFF_VIEWER_PREFERENCES,
  type DiffViewerPreferences,
} from "@/lib/diff/diff-viewer-preferences";
import {
  useTileFindStore,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";
import type { SnapshotDiffTileRef } from "@/stores/epics/canvas/types";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { TabHostProvider } from "../../tab-host-provider";

interface SnapshotTestStore {
  readonly snapshotLoaded: boolean;
  readonly messages: [];
  readonly liveAssistantMessage: null;
  readonly accumulatedFileChanges: ReadonlyArray<ChatAccumulatedFileChange>;
}

interface DiffPrimitiveCall {
  readonly patch: string;
  readonly mode: DiffViewerPreferences["mode"];
  readonly wordWrap: boolean;
  readonly backgrounds: boolean;
  readonly lineNumbers: boolean;
  readonly indicatorStyle: DiffViewerPreferences["indicatorStyle"];
}

const state = vi.hoisted(() => ({
  handle: null as {
    readonly store: UseBoundStore<StoreApi<SnapshotTestStore>>;
  } | null,
  buildPatch: vi.fn(),
  diffPrimitiveCalls: [] as DiffPrimitiveCall[],
}));

const SNAPSHOT_PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-const label = 'OldName';",
  "+const label = 'NewName';",
  "",
].join("\n");

vi.mock("@/lib/registries/chat-session-registry", () => ({
  useChatSessionHandle: () => state.handle,
}));

vi.mock("@/hooks/snapshots/use-snapshot-diff-query", () => ({
  useSnapshotDiffQuery: () => ({
    data: undefined,
    isLoading: false,
  }),
}));

vi.mock("@/lib/diff/snapshot-diff-patch", () => ({
  buildSnapshotUnifiedPatchBundle: state.buildPatch,
}));

vi.mock("@/components/diff/diff-content-primitive", () => ({
  DiffContentFrame: (props: { readonly children: ReactNode }) => (
    <div data-testid="snapshot-diff-frame">{props.children}</div>
  ),
  DiffContentPrimitive: (props: DiffPrimitiveCall) => {
    state.diffPrimitiveCalls.push(props);
    return <div data-testid="snapshot-diff-primitive" />;
  },
}));

import { SnapshotDiffTileBody } from "../snapshot-diff-tile-body";

function cumulativeChange(
  filePath: string,
  beforeContent: string,
  afterContent: string,
): ChatAccumulatedFileChange {
  return {
    filePath,
    operation: "edit",
    diffSource: "snapshot",
    beforeContent,
    afterContent,
    reason: "snapshot",
    undoable: true,
  };
}

function renderSnapshotTile(node: SnapshotDiffTileRef): void {
  render(
    <TabHostProvider hostId="host-1">
      <TileFindScope
        node={node}
        viewTabId="view-1"
        tileId={node.id}
        epicId="epic-1"
        isActive
      >
        <SnapshotDiffTileBody node={node} viewTabId="view-1" />
      </TileFindScope>
    </TabHostProvider>,
  );
}

describe("<SnapshotDiffTileBody />", () => {
  beforeEach(() => {
    state.diffPrimitiveCalls = [];
    state.buildPatch.mockReset();
    state.buildPatch.mockImplementation(
      (args: { readonly ignoreWhitespace: boolean }) =>
        args.ignoreWhitespace ? "patch:ignore" : "patch:include",
    );
    state.handle = {
      store: create<SnapshotTestStore>(() => ({
        snapshotLoaded: true,
        messages: [],
        liveAssistantMessage: null,
        accumulatedFileChanges: [
          cumulativeChange("src/a.ts", "const a = 1;\n", "const a = 2;\n"),
        ],
      })),
    };
    useSettingsStore.setState({
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
  });

  afterEach(() => {
    cleanup();
    useTileFindStore.getState().resetForTests();
    vi.restoreAllMocks();
  });

  it("rerenders mounted snapshot diffs from global preferences", async () => {
    const node = makeSnapshotCumulativeDiffTile({
      hostId: "host-1",
      chatId: "chat-1",
      filePath: "src/a.ts",
    });
    renderSnapshotTile(node);

    expect(state.diffPrimitiveCalls.at(-1)).toMatchObject({
      patch: "patch:include",
      mode: "split",
      wordWrap: false,
      backgrounds: true,
      lineNumbers: true,
      indicatorStyle: "bars",
    });
    expect(state.buildPatch).toHaveBeenLastCalledWith({
      entries: [
        {
          filePath: "src/a.ts",
          beforeContent: "const a = 1;\n",
          afterContent: "const a = 2;\n",
        },
      ],
      ignoreWhitespace: false,
    });

    act(() => {
      useSettingsStore.getState().setDiffViewerPreferences({
        mode: "unified",
        wordWrap: true,
        ignoreWhitespace: true,
        backgrounds: false,
        lineNumbers: false,
        indicatorStyle: "none",
      });
    });

    await waitFor(() => {
      expect(state.diffPrimitiveCalls.at(-1)).toMatchObject({
        patch: "patch:ignore",
        mode: "unified",
        wordWrap: true,
        backgrounds: false,
        lineNumbers: false,
        indicatorStyle: "none",
      });
    });
    expect(state.buildPatch).toHaveBeenLastCalledWith({
      entries: [
        {
          filePath: "src/a.ts",
          beforeContent: "const a = 1;\n",
          afterContent: "const a = 2;\n",
        },
      ],
      ignoreWhitespace: true,
    });
  });

  it("replays the active search when a loading single-file snapshot diff becomes loaded", async () => {
    const node = makeSnapshotCumulativeDiffTile({
      hostId: "host-1",
      chatId: "chat-1",
      filePath: "src/a.ts",
    });
    const handleStore = create<SnapshotTestStore>(() => ({
      snapshotLoaded: false,
      messages: [],
      liveAssistantMessage: null,
      accumulatedFileChanges: [],
    }));
    state.handle = { store: handleStore };
    state.buildPatch.mockReturnValue(SNAPSHOT_PATCH);

    renderSnapshotTile(node);

    await waitFor(() => {
      expect(tileSnapshot(node).coverageMessage).toBe(
        "Snapshot diff content is still loading.",
      );
    });
    act(() => {
      const store = useTileFindStore.getState();
      store.openForTile(node.instanceId);
      store.setMatchCase(node.instanceId, true);
      store.setQuery(node.instanceId, "NewName");
      store.search(node.instanceId);
    });
    expect(tileSnapshot(node)).toMatchObject({
      requestId: 1,
      status: "unavailable",
      query: "NewName",
      matchCase: true,
      total: 0,
      coverageMessage: "Snapshot diff content is still loading.",
    });

    act(() => {
      handleStore.setState({
        snapshotLoaded: true,
        accumulatedFileChanges: [
          cumulativeChange(
            "src/a.ts",
            "const label = 'OldName';\n",
            "const label = 'NewName';\n",
          ),
        ],
      });
    });

    await waitFor(() => {
      expect(tileSnapshot(node)).toMatchObject({
        requestId: 1,
        status: "ready",
        query: "NewName",
        matchCase: true,
        current: 1,
        total: 1,
        coverageMessage: null,
      });
    });
  });
});

function tileSnapshot(node: SnapshotDiffTileRef): TileFindStateSnapshot {
  const snapshot =
    useTileFindStore.getState().uiByTileInstanceId[node.instanceId]
      ?.lastSnapshot;
  if (snapshot === undefined) {
    throw new Error(`Missing tile find snapshot for ${node.instanceId}`);
  }
  return snapshot;
}
