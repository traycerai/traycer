import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  PrDetailCore,
  PrGetLocalDiffResponse,
  PrGetLocalDiffSummaryResponseV11,
  PrGetLocalFileDiffResponse,
  PrLocalDiffSummaryFileV11,
} from "@traycer/protocol/host/pr-schemas";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { makePrDiffTile } from "@/lib/pr/pr-diff-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  useTileFindStore,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";
import type { PrDetailSubscriptionResult } from "@/hooks/pr/use-pr-detail-subscription";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";
import { PrDiffTile } from "@/components/epic-canvas/renderers/pr-diff-tile";

interface VirtuosoMockProps {
  readonly data: ReadonlyArray<unknown>;
  readonly itemContent: (index: number, item: unknown) => ReactNode;
  readonly computeItemKey: (index: number, item: unknown) => string;
}

const virtuosoState = vi.hoisted(() => ({
  renderRows: true,
  scrollIntoView: vi.fn(),
}));

vi.mock("react-virtuoso", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Virtuoso: React.forwardRef<unknown, VirtuosoMockProps>((props, ref) => {
      React.useImperativeHandle(ref, () => ({
        scrollIntoView: virtuosoState.scrollIntoView,
        getState: (
          callback: (snapshot: { readonly scrollTop: number }) => void,
        ) => {
          callback({ scrollTop: 0 });
        },
      }));
      return (
        <div data-testid="virtuoso">
          {virtuosoState.renderRows
            ? props.data.map((item, index) => (
                <div key={props.computeItemKey(index, item)}>
                  {props.itemContent(index, item)}
                </div>
              ))
            : null}
        </div>
      );
    }),
  };
});

const tabHostClient = vi.hoisted(() => ({
  request: vi.fn(),
  onChange: (_listener: () => void) => () => undefined,
  getActiveHostId: vi.fn((): string | null => "host-1"),
  getRequestContextUserId: vi.fn((): string | null => "user-1"),
}));

const detailSubscription: { current: PrDetailSubscriptionResult } = vi.hoisted(
  () => ({
    current: {
      data: null,
      error: null,
      isPending: false,
      sendRefresh: () => undefined,
      methodSupported: true,
    },
  }),
);

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => tabHostClient,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Host 1",
    unavailability: null,
  }),
}));

vi.mock("@/hooks/pr/use-pr-detail-subscription", () => ({
  usePrDetailSubscription: () => detailSubscription.current,
}));

vi.mock("@/components/epic-canvas/git-diff/diff-content-primitive", () => ({
  DiffContentPrimitive: (props: { readonly patch: string }) => (
    <pre data-testid="diff-content">{props.patch}</pre>
  ),
  DiffContentFrame: null,
}));

function detailCore(): PrDetailCore {
  return {
    observedAt: 1_000,
    githubHost: "github.com",
    base: { owner: "acme", repo: "widgets", prNumber: 7 },
    prUrl: "https://github.com/acme/widgets/pull/7",
    state: "open",
    isDraft: false,
    title: "Add feature X",
    body: "Some description",
    author: { login: "octocat", avatarUrl: null },
    baseRefName: "main",
    headRefName: "feature/x",
    headRefOid: "a".repeat(40),
    additions: 10,
    deletions: 2,
    checksRollup: { success: 1, failure: 0, pending: 0, total: 1 },
    reviewDecision: null,
    reviewRequests: [],
    commentCount: 0,
    updatedAt: 1_000,
    mergedAt: null,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    repoRole: "superproject",
    linkGroupKey: "/tmp/worktrees/widgets",
    owners: [],
  };
}

function populatedSubscription(): PrDetailSubscriptionResult {
  return {
    data: {
      sourceStatus: "ok",
      notice: null,
      liveness: "live",
      core: detailCore(),
      checks: { observedAt: 1_000, contexts: [], isTruncated: false },
      activity: { observedAt: 1_000, items: [], isTruncated: false },
      reviewThreads: { observedAt: 1_000, threads: [], isTruncated: false },
      files: {
        observedAt: 1_000,
        files: [],
        totalCount: null,
        isTruncated: false,
      },
      commits: {
        observedAt: 1_000,
        commits: [],
        totalCount: null,
        isTruncated: false,
      },
    },
    error: null,
    isPending: false,
    sendRefresh: () => undefined,
    methodSupported: true,
  };
}

function summaryFile(
  overrides: Partial<PrLocalDiffSummaryFileV11> & { readonly path: string },
): PrLocalDiffSummaryFileV11 {
  return {
    previousPath: null,
    status: "modified",
    insertions: 3,
    deletions: 1,
    isBinary: false,
    pathBytes: null,
    previousPathBytes: null,
    ...overrides,
  };
}

function summaryOkWithFiles(
  files: readonly PrLocalDiffSummaryFileV11[],
): PrGetLocalDiffSummaryResponseV11 {
  return {
    kind: "summary",
    runningDir: "/tmp/worktrees/widgets",
    resolvedBaseRef: "origin/main",
    baseOid: "b".repeat(40),
    mergeBaseOid: "c".repeat(40),
    localHeadOid: "a".repeat(40),
    isStale: false,
    files: [...files],
  };
}

function patchWithNeedle(path: string, needle: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-const label = 'Old';",
    `+const label = '${needle}';`,
    "",
  ].join("\n");
}

function fileDiffOk(patch: string): PrGetLocalFileDiffResponse {
  return {
    kind: "diff",
    patch,
    isBinary: false,
    isTruncated: false,
    truncatedAfterBytes: null,
  };
}

function unsupportedError(): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "host does not support this method",
    requestId: "req-unsupported",
    method: "pr.getLocalDiffSummary",
    fatalDetails: null,
  });
}

function requestPath(params: unknown): string {
  if (typeof params !== "object" || params === null) return "";
  if (!("path" in params)) return "";
  const path = params.path;
  return typeof path === "string" ? path : "";
}

function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function tileOnTab(tabId: string, instanceId: string): PrDiffTileRef {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  const ref = canvas?.tilesByInstanceId[instanceId];
  if (ref === undefined || ref.type !== "pr-diff") {
    throw new Error("expected a PR diff tile on the tab");
  }
  return ref;
}

function tileTree(args: {
  readonly queryClient: QueryClient;
  readonly node: PrDiffTileRef;
  readonly tabId: string;
}): ReactNode {
  return (
    <QueryClientProvider client={args.queryClient}>
      <TabHostProvider hostId="host-1">
        <TooltipProvider>
          <TileFindScope
            node={args.node}
            viewTabId={args.tabId}
            tileId={args.node.id}
            epicId="epic-1"
            isActive
          >
            <PrDiffTile
              node={args.node}
              epicId="epic-1"
              viewTabId={args.tabId}
              isActive
            />
          </TileFindScope>
        </TooltipProvider>
      </TabHostProvider>
    </QueryClientProvider>
  );
}

// Awaits the mocked Virtuoso mounting before returning: the summary fetch
// resolves asynchronously, and `PrLocalDiffFilesView` (and with it, the real
// bundle-find adapter registration) does not exist in the tree until that
// resolves. Touching the tile-find store beforehand only ever reaches the
// scope's default "unavailable" adapter — see `TileFindScope`'s registration
// effect — and a `waitFor` retry loop built on that never converges: each
// retry mutates the DOM, which re-wakes the loop before the pending summary
// promise's microtask ever gets a turn, so it spins until the surrounding
// test's own timeout kills it rather than `waitFor`'s much shorter one.
async function renderTile(args: {
  readonly queryClient: QueryClient;
  readonly collapsedFileKeys: readonly string[] | null;
}): Promise<{
  readonly view: RenderResult;
  readonly node: PrDiffTileRef;
  readonly tabId: string;
}> {
  const base = makePrDiffTile({
    hostId: "host-1",
    githubHost: "github.com",
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
  });
  const node: PrDiffTileRef =
    args.collapsedFileKeys === null
      ? base
      : {
          ...base,
          view: { collapsedFileKeys: [...args.collapsedFileKeys] },
        };
  const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
  useEpicCanvasStore.getState().openTileInTab(tabId, node);
  const view = render(tileTree({ queryClient: args.queryClient, node, tabId }));
  await screen.findByTestId("virtuoso");
  return { view, node, tabId };
}

// A single, non-retrying search. Deliberately NOT a `waitFor(() => { search();
// expect(...) })` retry loop: every `search()` call publishes a new snapshot
// to the tile-find store's subscribers, which re-renders `TileFindBar` and
// mutates the DOM. Wrapping that in `waitFor` lets its own MutationObserver
// re-invoke the callback before the real async work this test is waiting on
// (a summary or per-file fetch settling) ever gets a turn on the microtask
// queue - the retries never stop timing out, they just spin as fast as the
// JS engine allows, hard enough that even the surrounding test's own timeout
// can starve. Callers instead await a concrete DOM signal that the async
// work is done (`screen.findBy*`, which never touches the store) and then
// call `search` exactly once.
function search(instanceId: string, query: string): void {
  act(() => {
    const store = useTileFindStore.getState();
    store.openForTile(instanceId);
    store.setQuery(instanceId, query);
    store.search(instanceId);
  });
}

function tileSnapshot(instanceId: string): TileFindStateSnapshot {
  const snapshot =
    useTileFindStore.getState().uiByTileInstanceId[instanceId]?.lastSnapshot;
  if (snapshot === undefined) {
    throw new Error("Missing PR bundle find snapshot");
  }
  return snapshot;
}

describe("<PrDiffTile /> bundle find", () => {
  let originalElementScrollTo: PropertyDescriptor | undefined;

  beforeEach(() => {
    virtuosoState.renderRows = true;
    virtuosoState.scrollIntoView.mockClear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useSettingsStore.setState({
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    });
    tabHostClient.request.mockReset();
    tabHostClient.getActiveHostId.mockReturnValue("host-1");
    tabHostClient.getRequestContextUserId.mockReturnValue("user-1");
    detailSubscription.current = populatedSubscription();
    // jsdom has no `Element.prototype.scrollTo` - a revealed FILE-level (metadata)
    // match with no paintable line element falls back to it (see
    // `revealDiffFindMatches`), which is exactly what a collapsed file's
    // metadata-only match hits.
    originalElementScrollTo = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTo",
    );
    Element.prototype.scrollTo = (): void => undefined;
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTileFindStore.getState().resetForTests();
    if (originalElementScrollTo === undefined) {
      Reflect.deleteProperty(Element.prototype, "scrollTo");
    } else {
      Object.defineProperty(
        Element.prototype,
        "scrollTo",
        originalElementScrollTo,
      );
    }
  });

  it("indexes every file's metadata up front, even with rows unrendered", async () => {
    const files = [
      summaryFile({ path: "src/alpha.ts" }),
      summaryFile({ path: "src/beta.ts" }),
    ];
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary")
        return Promise.resolve(summaryOkWithFiles(files));
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    virtuosoState.renderRows = false;
    const { node } = await renderTile({
      queryClient: makeQueryClient(),
      collapsedFileKeys: null,
    });

    search(node.instanceId, "beta");
    expect(tileSnapshot(node.instanceId).total).toBeGreaterThanOrEqual(1);
    expect(
      tabHostClient.request.mock.calls.some(
        (call) => call[0] === "pr.getLocalFileDiff",
      ),
    ).toBe(false);
  });

  it("keeps a loaded split patch searchable after its virtualized row unmounts", async () => {
    const NEEDLE = "MountedNeedle";
    const files = [summaryFile({ path: "src/mounted.ts" })];
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary")
        return Promise.resolve(summaryOkWithFiles(files));
      if (method === "pr.getLocalFileDiff")
        return Promise.resolve(
          fileDiffOk(patchWithNeedle("src/mounted.ts", NEEDLE)),
        );
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const queryClient = makeQueryClient();
    const rendered = await renderTile({
      queryClient,
      collapsedFileKeys: null,
    });
    const { node, tabId } = rendered;
    await screen.findByTestId("diff-content");

    search(node.instanceId, NEEDLE);
    expect(tileSnapshot(node.instanceId)).toMatchObject({
      status: "ready",
      total: 1,
    });

    virtuosoState.renderRows = false;
    rendered.view.rerender(tileTree({ queryClient, node, tabId }));

    search(node.instanceId, NEEDLE);
    expect(tileSnapshot(node.instanceId)).toMatchObject({
      status: "ready",
      total: 1,
    });
  });

  it("names unsearched files in the coverage message: unloaded, collapsed, large, binary", async () => {
    const files = [
      summaryFile({ path: "src/unloaded.ts" }),
      summaryFile({ path: "src/binary.bin", isBinary: true }),
      summaryFile({ path: "src/large.ts", insertions: 2000, deletions: 0 }),
      summaryFile({ path: "src/collapsed.ts" }),
    ];
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary")
        return Promise.resolve(summaryOkWithFiles(files));
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    virtuosoState.renderRows = false;
    const { node } = await renderTile({
      queryClient: makeQueryClient(),
      collapsedFileKeys: ["p:src/collapsed.ts"],
    });

    search(node.instanceId, "src");
    const message = tileSnapshot(node.instanceId).coverageMessage ?? "";
    expect(message).toMatch(/unloaded/u);
    expect(message).toMatch(/collapsed/u);
    expect(message).toMatch(/large/u);
    expect(message).toMatch(/binary/u);
  });

  it("reveals a match in a collapsed file: scrolls to its row and expands it", async () => {
    const files = [
      summaryFile({ path: "src/normal.ts" }),
      summaryFile({ path: "src/collapse-target.ts" }),
    ];
    tabHostClient.request.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "pr.getLocalDiffSummary")
          return Promise.resolve(summaryOkWithFiles(files));
        if (method === "pr.getLocalFileDiff")
          return Promise.resolve(
            fileDiffOk(patchWithNeedle(requestPath(params), "Needle")),
          );
        return Promise.reject(new Error(`unexpected method ${method}`));
      },
    );
    const { node, tabId } = await renderTile({
      queryClient: makeQueryClient(),
      collapsedFileKeys: ["p:src/collapse-target.ts"],
    });
    await screen.findByTestId("diff-content");

    search(node.instanceId, "collapse-target");
    expect(tileSnapshot(node.instanceId).total).toBeGreaterThanOrEqual(1);

    expect(virtuosoState.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1 }),
    );
    expect(
      tileOnTab(tabId, node.instanceId).view.collapsedFileKeys,
    ).not.toContain("p:src/collapse-target.ts");
  });

  it("counts a byte-keyed collapsed file in coverage, and reveals it by removing exactly its tagged key", async () => {
    const BYTE_TOKEN = "YmFkLf8udHh0";
    const files = [
      summaryFile({ path: "src/normal.ts" }),
      summaryFile({ path: "src/byte-target.ts", pathBytes: BYTE_TOKEN }),
    ];
    tabHostClient.request.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "pr.getLocalDiffSummary")
          return Promise.resolve(summaryOkWithFiles(files));
        if (method === "pr.getLocalFileDiff")
          return Promise.resolve(
            fileDiffOk(patchWithNeedle(requestPath(params), "Needle")),
          );
        return Promise.reject(new Error(`unexpected method ${method}`));
      },
    );
    const { node, tabId } = await renderTile({
      queryClient: makeQueryClient(),
      // Collapsed via its TAGGED `b:` key, not the lossy `p:<path>` form -
      // the byte file has no bare-path entry at all.
      collapsedFileKeys: [`b:${BYTE_TOKEN}`],
    });
    await screen.findByTestId("diff-content");

    // A query that matches both files' metadata (both live under `src/`)
    // still counts the byte-keyed file as "collapsed" - the reveal below,
    // which targets it specifically, is what expands it.
    search(node.instanceId, "src");
    expect(tileSnapshot(node.instanceId).coverageMessage ?? "").toMatch(
      /1 collapsed file/u,
    );

    // A match on its own path reveals it: scrolls to its row and expands it
    // by removing EXACTLY the tagged `b:` key.
    search(node.instanceId, "byte-target");
    expect(tileSnapshot(node.instanceId).total).toBeGreaterThanOrEqual(1);
    expect(virtuosoState.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1 }),
    );
    expect(tileOnTab(tabId, node.instanceId).view.collapsedFileKeys).toEqual(
      [],
    );
  });

  it("registers 'failed' coverage when the split per-file fetch rejects", async () => {
    const files = [summaryFile({ path: "src/failing.ts" })];
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary")
        return Promise.resolve(summaryOkWithFiles(files));
      if (method === "pr.getLocalFileDiff")
        return Promise.reject(new Error("boom"));
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const { node } = await renderTile({
      queryClient: makeQueryClient(),
      collapsedFileKeys: null,
    });
    await screen.findByText("Diff Loading Error");

    search(node.instanceId, "failing");
    expect(tileSnapshot(node.instanceId).coverageMessage).toMatch(/failed/u);
  });

  it("monolith fallback: a mounted patch is searchable and a null patch counts as truncated", async () => {
    const MONOLITH_NEEDLE = "MonolithNeedle";
    const monolithResponse: PrGetLocalDiffResponse = {
      kind: "diff",
      runningDir: "/tmp/worktrees/widgets",
      resolvedBaseRef: "origin/main",
      baseOid: "b".repeat(40),
      mergeBaseOid: "c".repeat(40),
      localHeadOid: "a".repeat(40),
      isStale: false,
      isTruncated: true,
      files: [
        {
          path: "src/mono-a.ts",
          previousPath: null,
          status: "modified",
          insertions: 3,
          deletions: 1,
          isBinary: false,
          patch: patchWithNeedle("src/mono-a.ts", MONOLITH_NEEDLE),
        },
        {
          path: "src/mono-b.ts",
          previousPath: null,
          status: "modified",
          insertions: 3,
          deletions: 1,
          isBinary: false,
          patch: null,
        },
      ],
    };
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary")
        return Promise.reject(unsupportedError());
      if (method === "pr.getLocalDiff")
        return Promise.resolve(monolithResponse);
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const { node } = await renderTile({
      queryClient: makeQueryClient(),
      collapsedFileKeys: null,
    });
    await screen.findByTestId("diff-content");

    search(node.instanceId, MONOLITH_NEEDLE);
    expect(tileSnapshot(node.instanceId).total).toBe(1);
    expect(tileSnapshot(node.instanceId).coverageMessage).toMatch(/truncated/u);
  });

  it("keeps a large file's loaded patch renderable after collapse and re-expand", async () => {
    const HUGE_TOKEN = "HugeToken";
    const files = [
      summaryFile({ path: "src/huge.ts", insertions: 2000, deletions: 0 }),
    ];
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary")
        return Promise.resolve(summaryOkWithFiles(files));
      if (method === "pr.getLocalFileDiff")
        return Promise.resolve(
          fileDiffOk(patchWithNeedle("src/huge.ts", HUGE_TOKEN)),
        );
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const queryClient = makeQueryClient();
    const rendered = await renderTile({
      queryClient,
      collapsedFileKeys: null,
    });
    const { node, tabId } = rendered;

    const loadButton = await screen.findByRole("button", {
      name: "Load diff",
    });
    fireEvent.click(loadButton);
    await screen.findByTestId("diff-content");

    search(node.instanceId, HUGE_TOKEN);
    expect(tileSnapshot(node.instanceId)).toMatchObject({
      status: "ready",
      total: 1,
    });
    // Close the find session before collapsing: the adapter's `reveal` keeps
    // the active match's file expanded (see `useBundleDiffFindNavigation`'s
    // `reveal` - `if (collapsedFileIds.has(fileId)) expandFile(fileId)`), and
    // that reveal replays whenever the renderer identity changes, which a
    // `collapsedFileKeys` toggle causes. Leaving the session open would have
    // the tile silently re-expand the file out from under the toggle below.
    act(() => {
      useTileFindStore.getState().close(node.instanceId);
    });

    // Collapse: the load approval is held at the files-view level (keyed by
    // comparison + path), not on the row, so it must survive the row
    // unmounting - collapse then expand exercises exactly that. `PrDiffTile`
    // reads `node.view` from its prop, not reactively from the store, so
    // each toggle is followed by a rerender with the store's current node
    // (mirroring `pr-diff-tile.test.tsx`'s `tileOnTab` + rerender pattern).
    act(() => {
      useEpicCanvasStore
        .getState()
        .togglePrDiffFileCollapsedInTab(tabId, node.id, "p:src/huge.ts");
    });
    const collapsedNode = tileOnTab(tabId, node.instanceId);
    expect(collapsedNode.view.collapsedFileKeys).toContain("p:src/huge.ts");
    rendered.view.rerender(
      tileTree({ queryClient, node: collapsedNode, tabId }),
    );

    act(() => {
      useEpicCanvasStore
        .getState()
        .togglePrDiffFileCollapsedInTab(tabId, node.id, "p:src/huge.ts");
    });
    const expandedNode = tileOnTab(tabId, node.instanceId);
    expect(expandedNode.view.collapsedFileKeys).not.toContain("p:src/huge.ts");
    rendered.view.rerender(
      tileTree({ queryClient, node: expandedNode, tabId }),
    );

    await screen.findByTestId("diff-content");
    expect(screen.queryByRole("button", { name: "Load diff" })).toBeNull();

    search(node.instanceId, HUGE_TOKEN);
    expect(tileSnapshot(node.instanceId)).toMatchObject({
      status: "ready",
      total: 1,
    });
  });

  it("drops a retained truncated patch from find when 'Load Full' fails", async () => {
    // A retained loaded patch outranks any coverage state in the coverage
    // counts, and the session keeps it past the section's unmount on purpose.
    // So when the "Load Full" re-ask (a NEW query key: byteBudget null) fails,
    // the section must unregister the truncated bytes it no longer renders -
    // otherwise find keeps matching text that is not in the DOM and reports
    // the file as truncated instead of failed.
    const TRUNCATED_TOKEN = "TruncatedToken";
    const files = [summaryFile({ path: "src/cut.ts" })];
    tabHostClient.request.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "pr.getLocalDiffSummary")
          return Promise.resolve(summaryOkWithFiles(files));
        if (method === "pr.getLocalFileDiff") {
          if (requestByteBudget(params) === null)
            return Promise.reject(new Error("full fetch boom"));
          return Promise.resolve({
            ...fileDiffOk(patchWithNeedle("src/cut.ts", TRUNCATED_TOKEN)),
            isTruncated: true,
            truncatedAfterBytes: 64,
          });
        }
        return Promise.reject(new Error(`unexpected method ${method}`));
      },
    );
    const { node } = await renderTile({
      queryClient: makeQueryClient(),
      collapsedFileKeys: null,
    });
    await screen.findByTestId("diff-content");

    // A truncated patch is searchable but flagged: the coverage message names
    // it, so the snapshot is "partial" rather than "ready".
    search(node.instanceId, TRUNCATED_TOKEN);
    expect(tileSnapshot(node.instanceId).total).toBe(1);
    expect(tileSnapshot(node.instanceId).coverageMessage).toMatch(/truncated/u);
    act(() => {
      useTileFindStore.getState().close(node.instanceId);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Load Full" }));
    await screen.findByText("Diff Loading Error");

    search(node.instanceId, TRUNCATED_TOKEN);
    expect(tileSnapshot(node.instanceId).total).toBe(0);
    const message = tileSnapshot(node.instanceId).coverageMessage ?? "";
    expect(message).toMatch(/failed/u);
    expect(message).not.toMatch(/truncated/u);
  });

  it("drops a retained truncated patch from find while 'Load Full' is still pending", async () => {
    // Past "Load Full" the section will never render the truncated bytes
    // again (the approval only moves forward), so they are dead for find
    // from the moment the new query key is pending - not only once it fails.
    // The tail token appears ONLY in the full patch, so the counts tell the
    // three phases apart: 1 (truncated shown) → 0 (skeleton) → 2 (full).
    const TRUNCATED_TOKEN = "SharedToken";
    const TAIL_TOKEN = "TailOnlyToken";
    const files = [summaryFile({ path: "src/slow.ts" })];
    const fullFetch = deferred<PrGetLocalFileDiffResponse>();
    tabHostClient.request.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "pr.getLocalDiffSummary")
          return Promise.resolve(summaryOkWithFiles(files));
        if (method === "pr.getLocalFileDiff") {
          if (requestByteBudget(params) === null) return fullFetch.promise;
          return Promise.resolve({
            ...fileDiffOk(patchWithNeedle("src/slow.ts", TRUNCATED_TOKEN)),
            isTruncated: true,
            truncatedAfterBytes: 64,
          });
        }
        return Promise.reject(new Error(`unexpected method ${method}`));
      },
    );
    const { node } = await renderTile({
      queryClient: makeQueryClient(),
      collapsedFileKeys: null,
    });
    await screen.findByTestId("diff-content");

    search(node.instanceId, TRUNCATED_TOKEN);
    expect(tileSnapshot(node.instanceId).total).toBe(1);
    act(() => {
      useTileFindStore.getState().close(node.instanceId);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Load Full" }));
    await screen.findByTestId("diff-content-loading-skeleton");

    search(node.instanceId, TRUNCATED_TOKEN);
    expect(tileSnapshot(node.instanceId).total).toBe(0);
    expect(tileSnapshot(node.instanceId).coverageMessage ?? "").not.toMatch(
      /truncated/u,
    );
    act(() => {
      useTileFindStore.getState().close(node.instanceId);
    });

    const fullPatch = [
      `diff --git a/src/slow.ts b/src/slow.ts`,
      `--- a/src/slow.ts`,
      `+++ b/src/slow.ts`,
      "@@ -1,2 +1,2 @@",
      "-const label = 'Old';",
      `+const label = '${TRUNCATED_TOKEN}';`,
      "-const tail = 'OldTail';",
      `+const tail = '${TAIL_TOKEN} ${TRUNCATED_TOKEN}';`,
      "",
    ].join("\n");
    await act(async () => {
      fullFetch.resolve(fileDiffOk(fullPatch));
      await fullFetch.promise;
    });
    await screen.findByTestId("diff-content");

    search(node.instanceId, TRUNCATED_TOKEN);
    expect(tileSnapshot(node.instanceId).total).toBe(2);
    expect(tileSnapshot(node.instanceId).coverageMessage).toBeNull();
  });
});

// A promise the test settles by hand, so a request can be held in its
// pending state while the tile is inspected.
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

function requestByteBudget(params: unknown): number | null | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  if (!("byteBudget" in params)) return undefined;
  const budget = params.byteBudget;
  if (budget === null) return null;
  return typeof budget === "number" ? budget : undefined;
}
