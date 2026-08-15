import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import type { ReactElement } from "react";
import type { DiffViewerPreferences } from "@/lib/diff/diff-viewer-preferences";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VirtuosoMockContext } from "react-virtuoso";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  PrGetLocalDiffResponse,
  PrGetLocalDiffSummaryResponse,
  PrGetLocalFileDiffResponse,
  PrLocalDiffSummaryFile,
} from "@traycer/protocol/host/pr-schemas";
import { DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET } from "@traycer/protocol/host/pr-schemas";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { PrLocalDiffBody } from "@/components/epic-canvas/pr/pr-local-diff-body";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { makePrDiffTile } from "@/lib/pr/pr-diff-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";
import type { PrLocalDiffTarget } from "@/hooks/pr/use-pr-local-diff";

/**
 * The PR diff tile's body: the drift banner, per-file collapse, and the
 * sentence shown when there is no local diff to read.
 *
 * `@pierre/diffs` is stubbed - it renders through a worker-backed highlight
 * pipeline that has no place in a jsdom assertion about which branch was
 * taken. The stub still proves the patch text reached the renderer.
 *
 * Drives the REAL canvas store (a real tab, with the tile actually inserted
 * into it) rather than mocking `useEpicCanvasStore`: the collapse toggle is
 * dispatched by the tile's deterministic `id`, matched against every tile in
 * the tab's canvas, and a hand-rolled mock that ignores the id argument
 * cannot tell a correctly-keyed toggle from one that hits the wrong tile.
 *
 * Virtuoso renders zero rows in jsdom unless `VirtuosoMockContext` supplies a
 * viewport. Split-mode sections resolve the host via `useTabHostClient`; that
 * hook is stubbed narrowly (not a whole-module factory over a class) so
 * `HostRpcError instanceof` checks stay real.
 */

const tabHostClient = vi.hoisted(() => ({
  request: vi.fn(),
  // The readiness surface `useReactiveHostReadiness` reads; "ready" unless a
  // test overrides these.
  onChange: (_listener: () => void) => () => undefined,
  getActiveHostId: vi.fn((): string | null => "host-1"),
  getRequestContextUserId: vi.fn((): string | null => "user-1"),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => tabHostClient,
}));

vi.mock("@/components/epic-canvas/git-diff/diff-content-primitive", () => ({
  DiffContentPrimitive: (props: { readonly patch: string }) => (
    <pre data-testid="diff-content">{props.patch}</pre>
  ),
  DiffContentFrame: null,
}));

const PATCH_A = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";

function tile(): PrDiffTileRef {
  return makePrDiffTile({
    hostId: "host-1",
    githubHost: "github.com",
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
  });
}

function localDiffTarget(): PrLocalDiffTarget {
  return {
    epicId: "epic-1",
    linkGroupKey: "/tmp/worktrees/widgets",
    repoIdentifier: { owner: "acme", repo: "widgets" },
    repoRole: "superproject",
    baseRefName: "main",
    headRefName: "feature/x",
    headRefOid: "a".repeat(40),
  };
}

/** Inserts `node` into a real tab's canvas and returns the tab id. */
function openRealTabWithTile(node: PrDiffTileRef): string {
  const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
  useEpicCanvasStore.getState().openTileInTab(tabId, node);
  return tabId;
}

/** The tile as currently held by the real store, for the given tab. */
function tileOnTab(tabId: string, instanceId: string): PrDiffTileRef {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  const ref = canvas?.tilesByInstanceId[instanceId];
  if (ref === undefined || ref.type !== "pr-diff") {
    throw new Error("expected a PR diff tile on the tab");
  }
  return ref;
}

function diffResponse(
  overrides: Partial<Extract<PrGetLocalDiffResponse, { kind: "diff" }>>,
): PrGetLocalDiffResponse {
  return {
    kind: "diff",
    runningDir: "/tmp/worktrees/widgets",
    resolvedBaseRef: "origin/main",
    baseOid: "b".repeat(40),
    mergeBaseOid: "c".repeat(40),
    localHeadOid: "a".repeat(40),
    isStale: false,
    isTruncated: false,
    files: [
      {
        path: "src/a.ts",
        previousPath: null,
        status: "modified",
        insertions: 3,
        deletions: 1,
        isBinary: false,
        patch: PATCH_A,
      },
    ],
    ...overrides,
  };
}

function summaryFile(
  overrides: Partial<PrLocalDiffSummaryFile>,
): PrLocalDiffSummaryFile {
  return {
    path: "src/a.ts",
    previousPath: null,
    status: "modified",
    insertions: 3,
    deletions: 1,
    isBinary: false,
    ...overrides,
  };
}

function summaryResponse(
  overrides: Partial<
    Extract<PrGetLocalDiffSummaryResponse, { kind: "summary" }>
  >,
): PrGetLocalDiffSummaryResponse {
  return {
    kind: "summary",
    runningDir: "/tmp/worktrees/widgets",
    resolvedBaseRef: "origin/main",
    baseOid: "b".repeat(40),
    mergeBaseOid: "c".repeat(40),
    localHeadOid: "a".repeat(40),
    isStale: false,
    files: [summaryFile({})],
    ...overrides,
  };
}

function fileDiffOk(
  overrides: Partial<Extract<PrGetLocalFileDiffResponse, { kind: "diff" }>>,
): PrGetLocalFileDiffResponse {
  return {
    kind: "diff",
    patch: PATCH_A,
    isBinary: false,
    isTruncated: false,
    truncatedAfterBytes: null,
    ...overrides,
  };
}

function bodyTree(args: {
  readonly node: PrDiffTileRef;
  readonly viewTabId: string;
  readonly target: PrLocalDiffTarget | null;
  readonly summary: PrGetLocalDiffSummaryResponse | null;
  readonly monolith: PrGetLocalDiffResponse | null;
  readonly onRangeDrift: (() => void) | undefined;
  readonly preferences: DiffViewerPreferences | undefined;
  readonly queryClient: QueryClient;
}): ReactElement {
  return (
    <QueryClientProvider client={args.queryClient}>
      <TabHostProvider hostId="host-1">
        <VirtuosoMockContext.Provider
          value={{ viewportHeight: 800, itemHeight: 48 }}
        >
          <PrLocalDiffBody
            node={args.node}
            viewTabId={args.viewTabId}
            target={args.target}
            summary={args.summary}
            monolith={args.monolith}
            onRangeDrift={
              args.onRangeDrift === undefined
                ? () => undefined
                : args.onRangeDrift
            }
            prUrl="https://github.com/acme/widgets/pull/7"
            preferences={
              args.preferences === undefined
                ? DEFAULT_DIFF_VIEWER_PREFERENCES
                : args.preferences
            }
          />
        </VirtuosoMockContext.Provider>
      </TabHostProvider>
    </QueryClientProvider>
  );
}

function renderBody(args: {
  readonly node: PrDiffTileRef;
  readonly viewTabId: string;
  readonly target: PrLocalDiffTarget | null;
  readonly summary: PrGetLocalDiffSummaryResponse | null;
  readonly monolith: PrGetLocalDiffResponse | null;
  readonly onRangeDrift: (() => void) | undefined;
  readonly preferences: DiffViewerPreferences | undefined;
}): RenderResult {
  // The GitHub links here go through `useRunnerOpenExternalLink`, which is a
  // TanStack mutation - so the body needs a client even though nothing in
  // the monolith cases fetches. In the app it always has one.
  return render(
    bodyTree({
      ...args,
      queryClient: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
      preferences: undefined,
    }),
  );
}

function renderMonolith(args: {
  readonly node: PrDiffTileRef;
  readonly viewTabId: string;
  readonly monolith: PrGetLocalDiffResponse | null;
  readonly target: PrLocalDiffTarget | null;
}): void {
  renderBody({
    node: args.node,
    viewTabId: args.viewTabId,
    target: args.target,
    summary: null,
    monolith: args.monolith,
    onRangeDrift: undefined,
    preferences: undefined,
  });
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  tabHostClient.request.mockReset();
});

afterEach(() => {
  cleanup();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("PrLocalDiffBody (monolith fallback)", () => {
  it("renders the patch for each file in the range", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderMonolith({
      node,
      viewTabId: tabId,
      monolith: diffResponse({}),
      target: localDiffTarget(),
    });

    expect(screen.getByTestId("diff-content").textContent).toContain("+new");
    expect(screen.getByTestId("pr-diff-file")).toBeTruthy();
  });

  it("warns when the local tip differs from the PR's head, and still shows the diff", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderMonolith({
      node,
      viewTabId: tabId,
      monolith: diffResponse({ isStale: true, localHeadOid: "d".repeat(40) }),
      target: localDiffTarget(),
    });

    expect(screen.getByTestId("pr-diff-stale").textContent).toContain(
      "ddddddd",
    );
    // A checkout one commit behind is right about almost everything; refusing
    // to render would be the worse answer.
    expect(screen.getByTestId("diff-content")).toBeTruthy();
  });

  it("does not warn when the tips agree", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderMonolith({
      node,
      viewTabId: tabId,
      monolith: diffResponse({}),
      target: localDiffTarget(),
    });

    expect(screen.queryByTestId("pr-diff-stale")).toBeNull();
  });

  it("renders no patch for a collapsed file", () => {
    // Not hidden with CSS: a 200-file PR would otherwise parse and mount every
    // patch the moment the tile opens.
    const node: PrDiffTileRef = {
      ...tile(),
      view: { collapsedFilePaths: ["src/a.ts"] },
    };
    const tabId = openRealTabWithTile(node);
    renderMonolith({
      node,
      viewTabId: tabId,
      monolith: diffResponse({}),
      target: localDiffTarget(),
    });

    expect(screen.queryByTestId("diff-content")).toBeNull();
    expect(screen.getByTestId("pr-diff-file")).toBeTruthy();
  });

  it("toggles collapse on the tile actually held by the store, keyed by path", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderMonolith({
      node,
      viewTabId: tabId,
      monolith: diffResponse({}),
      target: localDiffTarget(),
    });

    // The collapse control is a real `<button aria-expanded>`, so drive it by
    // role and accessible name: that pins the semantics a keyboard/screen
    // reader user depends on, which a test-id click would let regress.
    const toggle = screen.getByRole("button", { name: /src\/a\.ts/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);

    expect(tileOnTab(tabId, node.instanceId).view.collapsedFilePaths).toEqual([
      "src/a.ts",
    ]);
  });

  it("labels a rename with both endpoints", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderMonolith({
      node,
      viewTabId: tabId,
      monolith: diffResponse({
        files: [
          {
            path: "new/path.ts",
            previousPath: "old/path.ts",
            status: "renamed",
            insertions: 1,
            deletions: 1,
            isBinary: false,
            patch:
              "diff --git a/old/path.ts b/new/path.ts\n@@ -1 +1 @@\n-a\n+b",
          },
        ],
      }),
      target: localDiffTarget(),
    });

    expect(screen.getByTestId("pr-diff-file").textContent).toContain(
      "old/path.ts → new/path.ts",
    );
  });

  it("distinguishes a binary file from one the budget never reached", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderMonolith({
      node,
      viewTabId: tabId,
      monolith: diffResponse({
        isTruncated: true,
        files: [
          {
            path: "logo.png",
            previousPath: null,
            status: "modified",
            insertions: null,
            deletions: null,
            isBinary: true,
            patch: null,
          },
          {
            path: "src/big.ts",
            previousPath: null,
            status: "modified",
            insertions: 9_000,
            deletions: 0,
            isBinary: false,
            patch: null,
          },
        ],
      }),
      target: localDiffTarget(),
    });

    expect(screen.getByText(/Binary file/u)).toBeTruthy();
    expect(screen.getByText(/exceeded this view/u)).toBeTruthy();
    expect(screen.getByTestId("pr-diff-truncated").textContent).toContain(
      "cut off after 0 of 2 files",
    );
  });

  it("names the reason when the host declines", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderMonolith({
      node,
      viewTabId: tabId,
      monolith: { kind: "unavailable", reason: "ref-unavailable" },
      target: localDiffTarget(),
    });

    expect(screen.getByTestId("pr-diff-unavailable").textContent).toMatch(
      /Fetching the base branch/u,
    );
  });

  it("distinguishes a missing checkout from a mismatched repo", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderMonolith({
      node,
      viewTabId: tabId,
      monolith: { kind: "unavailable", reason: "repo-mismatch" },
      target: localDiffTarget(),
    });

    expect(screen.getByTestId("pr-diff-unavailable").textContent).toMatch(
      /uninitialized submodule/u,
    );
  });

  it("falls back to the no-checkout line when the host is too old for the method", () => {
    // A host that predates even the MONOLITH `pr.getLocalDiff` answers
    // E_HOST_UNSUPPORTED to the summary probe and the fallback call alike -
    // an error with no reason to name. (A host that merely predates the
    // split pair never lands here: its monolith fallback succeeds and
    // renders.) The tile then lands on this body with both frames null; the
    // sentence is the same "no checkout" line as a genuine miss.
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderMonolith({
      node,
      viewTabId: tabId,
      monolith: null,
      target: localDiffTarget(),
    });

    expect(screen.getByTestId("pr-diff-unavailable").textContent).toMatch(
      /no worktree for this pull request/u,
    );
  });

  it("reports an empty range distinctly from an unavailable one", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderMonolith({
      node,
      viewTabId: tabId,
      monolith: diffResponse({ files: [] }),
      target: localDiffTarget(),
    });

    expect(screen.getByTestId("pr-diff-empty")).toBeTruthy();
    expect(screen.queryByTestId("pr-diff-unavailable")).toBeNull();
  });
});

describe("PrLocalDiffBody (split)", () => {
  it("renders the file list from a successful summary", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    tabHostClient.request.mockResolvedValue(fileDiffOk({}));
    renderBody({
      node,
      viewTabId: tabId,
      target: localDiffTarget(),
      summary: summaryResponse({
        files: [
          summaryFile({ path: "src/a.ts" }),
          summaryFile({ path: "src/b.ts", insertions: 2, deletions: 0 }),
        ],
      }),
      monolith: null,
      onRangeDrift: undefined,
      preferences: undefined,
    });

    const files = screen.getAllByTestId("pr-diff-file");
    expect(files).toHaveLength(2);
    expect(files[0]?.textContent).toContain("src/a.ts");
    expect(files[1]?.textContent).toContain("src/b.ts");
  });

  it("fetches a mounted expanded section and renders the patch", async () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    const target = localDiffTarget();
    tabHostClient.request.mockResolvedValue(fileDiffOk({}));
    renderBody({
      node,
      viewTabId: tabId,
      target,
      summary: summaryResponse({}),
      monolith: null,
      onRangeDrift: undefined,
      preferences: undefined,
    });

    expect(await screen.findByTestId("diff-content")).toBeTruthy();
    expect(screen.getByTestId("diff-content").textContent).toContain("+new");
    expect(tabHostClient.request).toHaveBeenCalledWith(
      "pr.getLocalFileDiff",
      expect.objectContaining({
        epicId: target.epicId,
        linkGroupKey: target.linkGroupKey,
        mergeBaseOid: "c".repeat(40),
        headOid: "a".repeat(40),
        path: "src/a.ts",
        previousPath: null,
        byteBudget: DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
      }),
    );
  });

  it("renders GitErrorBlock when the per-file fetch fails", async () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    tabHostClient.request.mockRejectedValue(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "per-file fetch failed",
        requestId: "req-1",
        method: "pr.getLocalFileDiff",
        fatalDetails: null,
      }),
    );
    renderBody({
      node,
      viewTabId: tabId,
      target: localDiffTarget(),
      summary: summaryResponse({}),
      monolith: null,
      onRangeDrift: undefined,
      preferences: undefined,
    });

    expect(await screen.findByText("Diff Loading Error")).toBeTruthy();
    expect(screen.getByText("per-file fetch failed")).toBeTruthy();
    expect(screen.queryByTestId("diff-content")).toBeNull();
  });

  it("renders the section note and calls onRangeDrift for a per-file unavailable", async () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    const onRangeDrift = vi.fn();
    tabHostClient.request.mockResolvedValue({
      kind: "unavailable",
      reason: "ref-unavailable",
    });
    renderBody({
      node,
      viewTabId: tabId,
      target: localDiffTarget(),
      summary: summaryResponse({}),
      monolith: null,
      onRangeDrift,
      preferences: undefined,
    });

    expect(
      await screen.findByText(/no longer available from the local checkout/u),
    ).toBeTruthy();
    await waitFor(() => {
      expect(onRangeDrift).toHaveBeenCalledTimes(1);
    });
  });

  it("reports E_HOST_UNSUPPORTED per-file errors through onRangeDrift once per episode", async () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    const onRangeDrift = vi.fn();
    tabHostClient.request.mockRejectedValue(
      new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "host does not support this method",
        requestId: "req-unsupported",
        method: "pr.getLocalFileDiff",
        fatalDetails: null,
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      bodyTree({
        node,
        viewTabId: tabId,
        target: localDiffTarget(),
        summary: summaryResponse({}),
        monolith: null,
        onRangeDrift,
        queryClient,
        preferences: undefined,
      }),
    );

    // The section renders its ordinary error block while the TILE recovery
    // (a summary refetch that will itself fail unsupported and flip the tile
    // to monolith) is in flight - and reports exactly once.
    expect(await screen.findByText("Diff Loading Error")).toBeTruthy();
    await waitFor(() => {
      expect(onRangeDrift).toHaveBeenCalledTimes(1);
    });

    // A new callback identity re-runs the report effect - the exact path a
    // tile re-render takes after a failed recovery releases its token. The
    // once-per-episode ref must keep the same cached error from re-reporting
    // through it.
    const onRangeDriftNext = vi.fn();
    view.rerender(
      bodyTree({
        node,
        viewTabId: tabId,
        target: localDiffTarget(),
        summary: summaryResponse({}),
        monolith: null,
        onRangeDrift: onRangeDriftNext,
        queryClient,
        preferences: undefined,
      }),
    );
    expect(await screen.findByText("Diff Loading Error")).toBeTruthy();
    expect(onRangeDriftNext).not.toHaveBeenCalled();
    expect(onRangeDrift).toHaveBeenCalledTimes(1);
  });

  it("renders TruncatedBanner and Load Full re-issues with byteBudget null", async () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    const truncatedPatch =
      "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+trunc";
    const fullPatch =
      "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+full";
    tabHostClient.request
      .mockResolvedValueOnce(
        fileDiffOk({
          patch: truncatedPatch,
          isTruncated: true,
          truncatedAfterBytes: DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
        }),
      )
      .mockResolvedValueOnce(
        fileDiffOk({
          patch: fullPatch,
          isTruncated: false,
          truncatedAfterBytes: null,
        }),
      );
    renderBody({
      node,
      viewTabId: tabId,
      target: localDiffTarget(),
      summary: summaryResponse({}),
      monolith: null,
      onRangeDrift: undefined,
      preferences: undefined,
    });

    expect(await screen.findByText(/Diff truncated after/u)).toBeTruthy();
    expect(screen.getByTestId("diff-content").textContent).toContain("+trunc");

    fireEvent.click(screen.getByRole("button", { name: "Load Full" }));

    await waitFor(() => {
      expect(screen.getByTestId("diff-content").textContent).toContain("+full");
    });
    expect(tabHostClient.request).toHaveBeenLastCalledWith(
      "pr.getLocalFileDiff",
      expect.objectContaining({ byteBudget: null }),
    );
  });

  it("renders the Load diff placeholder for a large file and does not fetch until clicked", async () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    tabHostClient.request.mockResolvedValue(fileDiffOk({}));
    renderBody({
      node,
      viewTabId: tabId,
      target: localDiffTarget(),
      summary: summaryResponse({
        files: [summaryFile({ insertions: 900, deletions: 200 })],
      }),
      monolith: null,
      onRangeDrift: undefined,
      preferences: undefined,
    });

    expect(screen.getByText("Large diff")).toBeTruthy();
    expect(screen.queryByTestId("diff-content")).toBeNull();
    expect(tabHostClient.request).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));

    expect(await screen.findByTestId("diff-content")).toBeTruthy();
    expect(tabHostClient.request).toHaveBeenCalledTimes(1);
  });

  it("treats null line counts as large and does not fetch until Load diff", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    tabHostClient.request.mockResolvedValue(fileDiffOk({}));
    renderBody({
      node,
      viewTabId: tabId,
      target: localDiffTarget(),
      summary: summaryResponse({
        files: [summaryFile({ insertions: null, deletions: null })],
      }),
      monolith: null,
      onRangeDrift: undefined,
      preferences: undefined,
    });

    expect(screen.getByText("Large diff")).toBeTruthy();
    expect(tabHostClient.request).not.toHaveBeenCalled();
  });

  it("renders the binary note without fetching", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    tabHostClient.request.mockResolvedValue(fileDiffOk({}));
    renderBody({
      node,
      viewTabId: tabId,
      target: localDiffTarget(),
      summary: summaryResponse({
        files: [
          summaryFile({
            path: "logo.png",
            isBinary: true,
            insertions: null,
            deletions: null,
          }),
        ],
      }),
      monolith: null,
      onRangeDrift: undefined,
      preferences: undefined,
    });

    expect(screen.getByText(/Binary file/u)).toBeTruthy();
    expect(tabHostClient.request).not.toHaveBeenCalled();
    expect(screen.queryByTestId("diff-content")).toBeNull();
  });

  it("does not fetch a collapsed split-mode file, and collapse still writes the store", () => {
    const node: PrDiffTileRef = {
      ...tile(),
      view: { collapsedFilePaths: ["src/a.ts"] },
    };
    const tabId = openRealTabWithTile(node);
    tabHostClient.request.mockResolvedValue(fileDiffOk({}));
    renderBody({
      node,
      viewTabId: tabId,
      target: localDiffTarget(),
      summary: summaryResponse({}),
      monolith: null,
      onRangeDrift: undefined,
      preferences: undefined,
    });

    expect(screen.getByTestId("pr-diff-file")).toBeTruthy();
    expect(screen.queryByTestId("diff-content")).toBeNull();
    expect(tabHostClient.request).not.toHaveBeenCalled();

    const toggle = screen.getByRole("button", { name: /src\/a\.ts/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(tileOnTab(tabId, node.instanceId).view.collapsedFilePaths).toEqual(
      [],
    );
  });

  it("resets Load Full to the capped budget when the comparison OIDs change", async () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const firstSummary = summaryResponse({});
    const secondSummary = summaryResponse({
      mergeBaseOid: "d".repeat(40),
      localHeadOid: "e".repeat(40),
    });
    tabHostClient.request.mockImplementation(() =>
      Promise.resolve(
        fileDiffOk({
          isTruncated: true,
          truncatedAfterBytes: DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
        }),
      ),
    );
    const view = render(
      bodyTree({
        node,
        viewTabId: tabId,
        target: localDiffTarget(),
        summary: firstSummary,
        monolith: null,
        onRangeDrift: undefined,
        preferences: undefined,
        queryClient,
      }),
    );

    expect(await screen.findByText(/Diff truncated after/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load Full" }));
    await waitFor(() => {
      expect(tabHostClient.request).toHaveBeenLastCalledWith(
        "pr.getLocalFileDiff",
        expect.objectContaining({ byteBudget: null }),
      );
    });

    view.rerender(
      bodyTree({
        node,
        viewTabId: tabId,
        target: localDiffTarget(),
        summary: secondSummary,
        monolith: null,
        onRangeDrift: undefined,
        preferences: undefined,
        queryClient,
      }),
    );

    await waitFor(() => {
      expect(tabHostClient.request).toHaveBeenLastCalledWith(
        "pr.getLocalFileDiff",
        expect.objectContaining({
          mergeBaseOid: "d".repeat(40),
          headOid: "e".repeat(40),
          byteBudget: DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
        }),
      );
    });
  });

  it("resets a large-file Load diff approval when the comparison OIDs change", async () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const large = summaryFile({ insertions: 900, deletions: 200 });
    tabHostClient.request.mockResolvedValue(fileDiffOk({}));
    const view = render(
      bodyTree({
        node,
        viewTabId: tabId,
        target: localDiffTarget(),
        summary: summaryResponse({ files: [large] }),
        monolith: null,
        onRangeDrift: undefined,
        preferences: undefined,
        queryClient,
      }),
    );

    expect(screen.getByText("Large diff")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
    expect(await screen.findByTestId("diff-content")).toBeTruthy();
    expect(tabHostClient.request).toHaveBeenCalledTimes(1);

    view.rerender(
      bodyTree({
        node,
        viewTabId: tabId,
        target: localDiffTarget(),
        summary: summaryResponse({
          files: [large],
          mergeBaseOid: "d".repeat(40),
          localHeadOid: "e".repeat(40),
        }),
        monolith: null,
        onRangeDrift: undefined,
        preferences: undefined,
        queryClient,
      }),
    );

    expect(screen.getByText("Large diff")).toBeTruthy();
    expect(screen.queryByTestId("diff-content")).toBeNull();
    expect(tabHostClient.request).toHaveBeenCalledTimes(1);
  });

  it("resets Load Full when only ignoreWhitespace flips", async () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const summary = summaryResponse({});
    tabHostClient.request.mockImplementation(() =>
      Promise.resolve(
        fileDiffOk({
          isTruncated: true,
          truncatedAfterBytes: DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
        }),
      ),
    );
    const view = render(
      bodyTree({
        node,
        viewTabId: tabId,
        target: localDiffTarget(),
        summary,
        monolith: null,
        onRangeDrift: undefined,
        preferences: undefined,
        queryClient,
      }),
    );

    expect(await screen.findByText(/Diff truncated after/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load Full" }));
    await waitFor(() => {
      expect(tabHostClient.request).toHaveBeenLastCalledWith(
        "pr.getLocalFileDiff",
        expect.objectContaining({ byteBudget: null }),
      );
    });

    view.rerender(
      bodyTree({
        node,
        viewTabId: tabId,
        target: localDiffTarget(),
        summary,
        monolith: null,
        onRangeDrift: undefined,
        preferences: {
          ...DEFAULT_DIFF_VIEWER_PREFERENCES,
          ignoreWhitespace: true,
        },
        queryClient,
      }),
    );

    await waitFor(() => {
      expect(tabHostClient.request).toHaveBeenLastCalledWith(
        "pr.getLocalFileDiff",
        expect.objectContaining({
          ignoreWhitespace: true,
          byteBudget: DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
        }),
      );
    });
  });
});
