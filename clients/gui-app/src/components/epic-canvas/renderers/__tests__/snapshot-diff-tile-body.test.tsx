import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import {
  makeSnapshotCumulativeDiffTile,
  makeSnapshotHashDiffTile,
} from "@/lib/chat/snapshot-diff-tile";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import {
  DEFAULT_DIFF_VIEWER_PREFERENCES,
  type DiffViewerPreferences,
} from "@/lib/diff/diff-viewer-preferences";
import {
  useTileFindStore,
  type DiffTileFindRenderer,
  type DiffTileFindSource,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import type {
  SnapshotDiffTilePayload,
  SnapshotDiffTileRef,
} from "@/stores/epics/canvas/types";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabHostProvider } from "../../tab-host-provider";
import { PDF_FILE_DIFF_COPY } from "@/lib/chat/file-edit-reason-copy";

interface SnapshotTestStore {
  readonly snapshotLoaded: boolean;
  readonly messages: [];
  readonly liveAssistantMessage: null;
  readonly accumulatedFileChanges: ReadonlyArray<ChatAccumulatedFileChange>;
  // Empty, and `transcriptDerived: null` with it: this fixture is the
  // pre-windowed line, where the contents ride the snapshot above.
  readonly accumulatedFileChangeSummaries: [];
  readonly transcriptDerived: null;
}

interface DiffPrimitiveCall {
  readonly patch: string;
  readonly mode: DiffViewerPreferences["mode"];
  readonly wordWrap: boolean;
  readonly backgrounds: boolean;
  readonly lineNumbers: boolean;
  readonly indicatorStyle: DiffViewerPreferences["indicatorStyle"];
}

interface SnapshotDiffQueryCall {
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly enabled: boolean;
}

// Only the fields the tile body reads off the query - the vi.mock factory
// replaces the module wholesale, so the full UseQueryResult surface is not
// required, but the mock's RETURN must be typed for the lint gate.
interface SnapshotDiffQueryResult {
  readonly data:
    | {
        readonly reason: "snapshot" | "binary";
        readonly beforeContent: string | null;
        readonly afterContent: string | null;
      }
    | undefined;
  readonly isLoading: boolean;
}

// The real hook's argument shape - tracked via a wrapping vi.mock
// (importOriginal) rather than replaced, so the cumulative resolution the
// non-PDF tests depend on keeps running for real; only the PDF test cares
// about `enabled`.
interface SnapshotResolveCumulativeDiffsCall {
  readonly payload: SnapshotDiffTilePayload;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostRows: ReadonlyArray<AccumulatedChangeRow>;
  readonly hostRowsComplete: boolean;
  readonly inlineChanges: ReadonlyArray<ChatAccumulatedFileChange>;
  readonly enabled: boolean;
}

// Same tracking shape for the find-adapter registration hook - wrapped, not
// replaced, so every existing search test keeps exercising the real tile-find
// store; only the PDF-branch test inspects what source it registered.
interface RegisterDiffTileFindAdapterCall {
  readonly tileInstanceId: string;
  readonly tileKind: TileKindId;
  readonly source: DiffTileFindSource;
  readonly renderer: DiffTileFindRenderer | null;
}

const state = vi.hoisted(() => ({
  handle: null as {
    readonly store: UseBoundStore<StoreApi<SnapshotTestStore>>;
    // The cumulative path addresses its on-demand contents by `(epicId,
    // chatId, filePath, digest)`, so the handle has to carry the first two.
    readonly epicId: string;
    readonly chatId: string;
  } | null,
  buildPatch: vi.fn(),
  diffPrimitiveCalls: [] as DiffPrimitiveCall[],
  // Tracked (not a static return) so a PDF short-circuit test can assert the
  // query was called with `enabled: false` - i.e. never actually issued -
  // rather than merely asserting on what it rendered.
  snapshotDiffQuery:
    vi.fn<(args: SnapshotDiffQueryCall) => SnapshotDiffQueryResult>(),
  cumulativeResolveCalls:
    vi.fn<(args: SnapshotResolveCumulativeDiffsCall) => void>(),
  registerDiffTileFindAdapterCalls:
    vi.fn<(args: RegisterDiffTileFindAdapterCall) => void>(),
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

// The tile resolves the snapshot store on its TAB's host (D15). The real
// `<TabHostProvider>` below supplies the host ID, but resolving a client from it
// needs the whole host runtime; the query is mocked just below, so the seam is
// what matters here, not a live client.
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/snapshots/use-snapshot-diff-query", () => ({
  useSnapshotDiffQuery: (args: SnapshotDiffQueryCall) =>
    state.snapshotDiffQuery(args),
}));

// Wrapped (not replaced): the non-PDF cumulative tests resolve their content
// through this hook's REAL inline path (no digest -> no host round trip), so
// swapping in a static mock would break them. Only `enabled` is tracked here;
// the PDF test asserts the resolver was told not to fetch.
vi.mock(
  "@/hooks/snapshots/use-snapshot-resolve-cumulative-diffs",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/snapshots/use-snapshot-resolve-cumulative-diffs")
      >();
    return {
      ...actual,
      useSnapshotResolveCumulativeDiffs: (
        args: SnapshotResolveCumulativeDiffsCall,
      ) => {
        state.cumulativeResolveCalls(args);
        return actual.useSnapshotResolveCumulativeDiffs(args);
      },
    };
  },
);

// Same wrap-not-replace shape: the "replays the active search" test drives
// the real tile-find store through this hook, so only the registration CALL
// is tracked here, not the hook's effect on the store.
vi.mock(
  "@/components/diff/use-register-diff-tile-find-adapter",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/diff/use-register-diff-tile-find-adapter")
      >();
    return {
      ...actual,
      useRegisterDiffTileFindAdapter: (
        args: RegisterDiffTileFindAdapterCall,
      ) => {
        state.registerDiffTileFindAdapterCalls(args);
        return actual.useRegisterDiffTileFindAdapter(args);
      },
    };
  },
);

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

/**
 * A row for a file the snapshot could not capture - what a binary PDF's
 * accumulated change actually looks like: it is IN the set (the agent did
 * change it), with no before/after to show.
 */
function binaryCumulativeChange(filePath: string): ChatAccumulatedFileChange {
  return {
    filePath,
    operation: "edit",
    diffSource: "none",
    beforeContent: null,
    afterContent: null,
    reason: "binary",
    undoable: true,
  };
}

function renderSnapshotTile(node: SnapshotDiffTileRef): void {
  // The tile is a Query consumer on every path now: hash-backed tiles fetch by
  // content hash and cumulative ones fetch by accumulated-change digest (D7).
  // Production always mounts it under the app's provider; this supplies one.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
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
      </TabHostProvider>
    </QueryClientProvider>,
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
    state.snapshotDiffQuery.mockReset();
    state.snapshotDiffQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
    });
    state.cumulativeResolveCalls.mockReset();
    state.registerDiffTileFindAdapterCalls.mockReset();
    state.handle = {
      epicId: "epic-1",
      chatId: "chat-1",
      store: create<SnapshotTestStore>(() => ({
        snapshotLoaded: true,
        messages: [],
        liveAssistantMessage: null,
        accumulatedFileChanges: [
          cumulativeChange("src/a.ts", "const a = 1;\n", "const a = 2;\n"),
        ],
        accumulatedFileChangeSummaries: [],
        transcriptDerived: null,
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
      accumulatedFileChangeSummaries: [],
      transcriptDerived: null,
    }));
    state.handle = { epicId: "epic-1", chatId: "chat-1", store: handleStore };
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

  // A hash-backed tile aimed at a PDF short-circuits by PATH (the filePath
  // carried on the payload / resolved hash endpoints), not by the query's
  // resolved content - a binary PDF's blobs were never captured, so asking
  // the host would only waste a round trip for a reason the client already
  // knows from the extension alone.
  it("renders the PDF copy and never issues the snapshot content query for a PDF filePath", () => {
    const node = makeSnapshotHashDiffTile({
      hostId: "host-1",
      chatId: "chat-1",
      filePath: "docs/report.pdf",
      beforeHash: "before-hash",
      afterHash: "after-hash",
      title: null,
    });

    renderSnapshotTile(node);

    expect(screen.getByText(PDF_FILE_DIFF_COPY)).toBeTruthy();
    expect(
      screen.queryByTestId(`snapshot-diff-unavailable-${node.id}`),
    ).toBeNull();
    expect(state.snapshotDiffQuery).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  // Same PDF short-circuit as above, but the query mock answers as though it
  // HAD run and come back `reason: "binary"` (the exact response a PDF's
  // never-captured blobs would actually produce). The PDF copy must still be
  // what renders - proving the branch is decided before `resolved` (and thus
  // the query's data) is ever consulted, not merely coincide with it here.
  it("renders the PDF copy over the resolved-content branch even when the query would answer binary", () => {
    state.snapshotDiffQuery.mockReturnValue({
      data: { reason: "binary", beforeContent: null, afterContent: null },
      isLoading: false,
    });
    const node = makeSnapshotHashDiffTile({
      hostId: "host-1",
      chatId: "chat-1",
      filePath: "docs/report.pdf",
      beforeHash: "before-hash",
      afterHash: "after-hash",
      title: null,
    });

    renderSnapshotTile(node);

    expect(screen.getByText(PDF_FILE_DIFF_COPY)).toBeTruthy();
    expect(
      screen.queryByTestId(`snapshot-diff-unavailable-${node.id}`),
    ).toBeNull();
  });

  // A CUMULATIVE tile aimed at a PDF is the same PATH-decided gate as the
  // hash-backed kind above - `singleFilePath` reads `node.diff.filePath`
  // directly when there is no hash-backed endpoint. The cumulative resolver
  // must be told `enabled: false` for the same reason the hash query is:
  // a binary PDF's blobs were never captured, so letting it run would only
  // waste a fetch for a reason the client already knows from the extension.
  it("renders the PDF copy and short-circuits the cumulative resolver for a PDF filePath", () => {
    state.handle?.store.setState({
      accumulatedFileChanges: [binaryCumulativeChange("docs/report.pdf")],
    });
    const node = makeSnapshotCumulativeDiffTile({
      hostId: "host-1",
      chatId: "chat-1",
      filePath: "docs/report.pdf",
    });

    renderSnapshotTile(node);

    expect(screen.getByText(PDF_FILE_DIFF_COPY)).toBeTruthy();
    expect(
      screen.queryByTestId(`snapshot-diff-unavailable-${node.id}`),
    ).toBeNull();
    expect(state.cumulativeResolveCalls).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  // Extension decides the RENDERING; it must not decide EXISTENCE. A
  // cumulative tile reads the live accumulated set, so a path reverted out
  // of it after the tile was opened is gone - and every other file type says
  // so. Short-circuiting on `.pdf` alone exempted PDFs from that and left a
  // dead row claiming its diff was merely not shown (and indexed its stale
  // path into Find). Falling through costs no fetch: a path with no row has
  // nothing fetchable.
  it("falls through to source-unavailable for a cumulative PDF reverted out of a complete set", () => {
    state.handle?.store.setState({
      accumulatedFileChanges: [
        cumulativeChange("src/a.ts", "const a = 1;\n", "const a = 2;\n"),
      ],
    });
    const node = makeSnapshotCumulativeDiffTile({
      hostId: "host-1",
      chatId: "chat-1",
      filePath: "docs/report.pdf",
    });

    renderSnapshotTile(node);

    expect(
      screen.getByTestId(`snapshot-diff-unavailable-${node.id}`),
    ).toBeTruthy();
    expect(screen.queryByText(PDF_FILE_DIFF_COPY)).toBeNull();
  });

  // The PDF branch is terminal like every other branch, but it must still
  // publish something to global Find rather than simply not existing to it:
  // a metadata-only source carrying the file's identity and an honest
  // "not searchable" coverage note.
  it("registers a metadata-only find source with the PDF coverage message for the PDF branch", () => {
    const node = makeSnapshotHashDiffTile({
      hostId: "host-1",
      chatId: "chat-1",
      filePath: "docs/report.pdf",
      beforeHash: "before-hash",
      afterHash: "after-hash",
      title: null,
    });

    renderSnapshotTile(node);

    const registration = state.registerDiffTileFindAdapterCalls.mock.calls
      .map(([call]) => call)
      .find((call) => call.source.kind === "metadata-partial");
    if (registration === undefined) {
      throw new Error("expected a metadata-partial find registration");
    }
    expect(registration.source.coverageMessage).toBe(
      "PDF content is not searchable; only file metadata was searched.",
    );
    if (registration.source.index === null) {
      throw new Error("expected a find index on the PDF source");
    }
    expect(registration.source.index.units).toHaveLength(1);
    expect(registration.source.index.units[0]?.filePath).toBe(
      "docs/report.pdf",
    );
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
