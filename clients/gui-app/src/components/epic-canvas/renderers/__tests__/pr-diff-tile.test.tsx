import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import type { ReactElement } from "react";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VirtuosoMockContext } from "react-virtuoso";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  PrDetailCore,
  PrGetLocalDiffResponse,
  PrGetLocalDiffSummaryResponse,
  PrGetLocalFileDiffResponse,
  PrLocalDiffSummaryFile,
} from "@traycer/protocol/host/pr-schemas";
import { DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET } from "@traycer/protocol/host/pr-schemas";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { makePrDiffTile } from "@/lib/pr/pr-diff-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import type { PrDetailSubscriptionResult } from "@/hooks/pr/use-pr-detail-subscription";
import { PrDiffTile } from "@/components/epic-canvas/renderers/pr-diff-tile";

/**
 * Tile-level call-and-degrade, mid-session downgrade, and drift recovery.
 *
 * The body suite drives `PrLocalDiffBody` props directly and cannot prove the
 * tile never issues a monolith RPC on summary success, or that a same-key
 * `E_HOST_UNSUPPORTED` refetch actually flips a populated tile to monolith
 * mode. This harness uses a real QueryClient and a narrow `request` mock.
 */

const tabHostClient = vi.hoisted(() => ({
  request: vi.fn(),
  // The readiness surface `useReactiveHostReadiness` reads; "ready" unless a
  // test overrides these.
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

const FILE_PATCH =
  "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+from-file";
const MONOLITH_PATCH =
  "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+from-monolith";

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
      checks: {
        observedAt: 1_000,
        contexts: [],
        isTruncated: false,
      },
      activity: { observedAt: 1_000, items: [], isTruncated: false },
      reviewThreads: {
        observedAt: 1_000,
        threads: [],
        isTruncated: false,
      },
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

/** The populated subscription with its core's `headRefOid` replaced. */
function subscriptionWithHead(headRefOid: string): PrDetailSubscriptionResult {
  const base = populatedSubscription();
  if (base.data === null) throw new Error("populatedSubscription has data");
  return {
    ...base,
    data: { ...base.data, core: { ...base.data.core, headRefOid } },
  };
}

function summaryOkWithFiles(
  files: readonly PrLocalDiffSummaryFile[],
): PrGetLocalDiffSummaryResponse {
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

function summaryOk(): PrGetLocalDiffSummaryResponse {
  return summaryOkWithFiles([
    {
      path: "src/a.ts",
      previousPath: null,
      status: "modified",
      insertions: 3,
      deletions: 1,
      isBinary: false,
    },
  ]);
}

function monolithOk(): PrGetLocalDiffResponse {
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
        patch: MONOLITH_PATCH,
      },
    ],
  };
}

function fileOk(): PrGetLocalFileDiffResponse {
  return {
    kind: "diff",
    patch: FILE_PATCH,
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

function methodCalls(method: string): unknown[][] {
  return tabHostClient.request.mock.calls.filter(
    (call: unknown[]) => call[0] === method,
  );
}

function fileCallsFor(path: string): unknown[][] {
  return methodCalls("pr.getLocalFileDiff").filter((call) => {
    const params = call[1];
    return (
      typeof params === "object" &&
      params !== null &&
      "path" in params &&
      params.path === path
    );
  });
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
}): ReactElement {
  return (
    <QueryClientProvider client={args.queryClient}>
      <TabHostProvider hostId="host-1">
        <TooltipProvider>
          <VirtuosoMockContext.Provider
            value={{ viewportHeight: 800, itemHeight: 48 }}
          >
            <PrDiffTile
              node={args.node}
              epicId="epic-1"
              viewTabId={args.tabId}
              isActive
            />
          </VirtuosoMockContext.Provider>
        </TooltipProvider>
      </TabHostProvider>
    </QueryClientProvider>
  );
}

function renderTile(queryClient: QueryClient): {
  readonly view: RenderResult;
  readonly node: PrDiffTileRef;
  readonly tabId: string;
} {
  const node = makePrDiffTile({
    hostId: "host-1",
    githubHost: "github.com",
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
  });
  const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
  useEpicCanvasStore.getState().openTileInTab(tabId, node);
  return {
    view: render(tileTree({ queryClient, node, tabId })),
    node,
    tabId,
  };
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useSettingsStore.setState({
    diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
  });
  tabHostClient.request.mockReset();
  tabHostClient.getActiveHostId.mockReturnValue("host-1");
  tabHostClient.getRequestContextUserId.mockReturnValue("user-1");
  detailSubscription.current = populatedSubscription();
});

afterEach(() => {
  cleanup();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("PrDiffTile call-and-degrade", () => {
  it("renders split from a successful summary and never issues pr.getLocalDiff", async () => {
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary")
        return Promise.resolve(summaryOk());
      if (method === "pr.getLocalFileDiff") return Promise.resolve(fileOk());
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    renderTile(makeQueryClient());

    expect(await screen.findByTestId("diff-content")).toBeTruthy();
    expect(screen.getByTestId("diff-content").textContent).toContain(
      "+from-file",
    );
    expect(methodCalls("pr.getLocalDiff")).toHaveLength(0);
    expect(methodCalls("pr.getLocalDiffSummary")).toHaveLength(1);
    expect(methodCalls("pr.getLocalFileDiff").length).toBeGreaterThan(0);
  });

  it("issues nothing while the tab client's readiness is unresolved", async () => {
    // A non-null client whose active host has not resolved yet (startup,
    // sign-in change, reconnect). Probing now would cache a transport error
    // under `staleTime: Infinity` with `retry: false` - a wedged tile.
    tabHostClient.getActiveHostId.mockReturnValue(null);
    tabHostClient.request.mockResolvedValue(summaryOk());
    renderTile(makeQueryClient());

    await act(async () => {
      await Promise.resolve();
    });
    expect(tabHostClient.request).not.toHaveBeenCalled();
  });

  it("falls back to exactly one monolith call when the summary is E_HOST_UNSUPPORTED", async () => {
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary") {
        return Promise.reject(unsupportedError());
      }
      if (method === "pr.getLocalDiff") return Promise.resolve(monolithOk());
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    renderTile(makeQueryClient());

    expect(await screen.findByTestId("diff-content")).toBeTruthy();
    expect(screen.getByTestId("diff-content").textContent).toContain(
      "+from-monolith",
    );
    expect(methodCalls("pr.getLocalDiff")).toHaveLength(1);
    expect(methodCalls("pr.getLocalFileDiff")).toHaveLength(0);
  });

  it("suppresses retained summary data after a same-key E_HOST_UNSUPPORTED refetch", async () => {
    let summaryUnsupported = false;
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary") {
        if (summaryUnsupported) return Promise.reject(unsupportedError());
        return Promise.resolve(summaryOk());
      }
      if (method === "pr.getLocalDiff") return Promise.resolve(monolithOk());
      if (method === "pr.getLocalFileDiff") return Promise.resolve(fileOk());
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const queryClient = makeQueryClient();
    renderTile(queryClient);

    expect(await screen.findByTestId("diff-content")).toBeTruthy();
    expect(screen.getByTestId("diff-content").textContent).toContain(
      "+from-file",
    );
    const fileCallsAfterSplit = methodCalls("pr.getLocalFileDiff").length;
    expect(fileCallsAfterSplit).toBeGreaterThan(0);
    expect(methodCalls("pr.getLocalDiff")).toHaveLength(0);

    summaryUnsupported = true;
    await queryClient.invalidateQueries({
      queryKey: prQueryKeys.localDiffSummary({
        hostId: "host-1",
        epicId: "epic-1",
        linkGroupKey: "/tmp/worktrees/widgets",
        owner: "acme",
        repo: "widgets",
        repoRole: "superproject",
        baseRefName: "main",
        headRefName: "feature/x",
        headRefOid: "a".repeat(40),
        ignoreWhitespace: false,
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId("diff-content").textContent).toContain(
        "+from-monolith",
      );
    });
    expect(methodCalls("pr.getLocalDiff")).toHaveLength(1);
    expect(methodCalls("pr.getLocalFileDiff")).toHaveLength(
      fileCallsAfterSplit,
    );
  });

  it("falls back to monolith when the DOWNGRADE is first observed by a per-file call", async () => {
    // The summary succeeded while the host still had the split methods; the
    // downgrade (or reconnect to an older build) lands before any row is
    // fetched. The cached summary never re-asks on its own at
    // `staleTime: Infinity`, so the per-file E_HOST_UNSUPPORTED must route
    // through the sections' drift report: the recovery's summary refetch
    // fails unsupported, which is what flips the tile to monolith.
    let hostDowngraded = false;
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary") {
        if (hostDowngraded) return Promise.reject(unsupportedError());
        return Promise.resolve(summaryOk());
      }
      if (method === "pr.getLocalFileDiff") {
        hostDowngraded = true;
        return Promise.reject(unsupportedError());
      }
      if (method === "pr.getLocalDiff") return Promise.resolve(monolithOk());
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    renderTile(makeQueryClient());

    await waitFor(() => {
      expect(screen.getByTestId("diff-content").textContent).toContain(
        "+from-monolith",
      );
    });
    expect(methodCalls("pr.getLocalDiff")).toHaveLength(1);
    // Every mounted row observed the downgrade, but the tile's once-per-range
    // token must collapse that burst into ONE recovery refetch: the initial
    // summary ask plus exactly one re-ask.
    expect(methodCalls("pr.getLocalDiffSummary")).toHaveLength(2);
  });
});

describe("PrDiffTile range-drift recovery", () => {
  it("releases the once-per-range token when the summary refetch errors", async () => {
    let summaryCalls = 0;
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary") {
        summaryCalls += 1;
        if (summaryCalls === 1) return Promise.resolve(summaryOk());
        return Promise.reject(
          new HostRpcError({
            code: "RPC_ERROR",
            message: "summary refetch failed",
            requestId: "req-drift",
            method: "pr.getLocalDiffSummary",
            fatalDetails: null,
          }),
        );
      }
      if (method === "pr.getLocalFileDiff") {
        return Promise.resolve({
          kind: "unavailable",
          reason: "ref-unavailable",
        });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const queryClient = makeQueryClient();
    const mounted = renderTile(queryClient);

    expect(
      await screen.findByText(/no longer available from the local checkout/u),
    ).toBeTruthy();
    await waitFor(() => {
      expect(summaryCalls).toBe(2);
    });
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    const afterFirstRecovery = summaryCalls;

    // Quiescence: a still-mounted section must not re-report on render churn
    // after the failed recovery released the token. The old remount-raced
    // version could not pin this; the hot-loop defect passed it.
    mounted.view.rerender(
      tileTree({
        queryClient,
        node: tileOnTab(mounted.tabId, mounted.node.instanceId),
        tabId: mounted.tabId,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    mounted.view.rerender(
      tileTree({
        queryClient,
        node: tileOnTab(mounted.tabId, mounted.node.instanceId),
        tabId: mounted.tabId,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(summaryCalls).toBe(afterFirstRecovery);

    // Genuine new event: collapse then expand remounts the section (fresh
    // reportedDriftRef) after we feed the store-updated tile back in.
    fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }));
    mounted.view.rerender(
      tileTree({
        queryClient,
        node: tileOnTab(mounted.tabId, mounted.node.instanceId),
        tabId: mounted.tabId,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }));
    mounted.view.rerender(
      tileTree({
        queryClient,
        node: tileOnTab(mounted.tabId, mounted.node.instanceId),
        tabId: mounted.tabId,
      }),
    );

    await waitFor(() => {
      expect(summaryCalls).toBe(afterFirstRecovery + 1);
    });
    expect(summaryCalls).toBe(afterFirstRecovery + 1);
  });

  it("permits a NEW recovery when a spent range returns after an intervening range", async () => {
    // Range A drifts and spends its token; the PR advances to range D (which
    // is healthy); a force-push returns the PR to A, whose summary and
    // unavailable per-file answers are all still cached. The return is a new
    // EPISODE of A - without the render-time token reset on range change,
    // A's second death would be suppressed until a manual refresh.
    const headA = "a".repeat(40);
    const headD = "d".repeat(40);
    let summaryCalls = 0;
    tabHostClient.request.mockImplementation(
      (
        method: string,
        request: {
          readonly expectedHeadOid?: string | null;
          readonly headOid?: string;
        },
      ) => {
        if (method === "pr.getLocalDiffSummary") {
          summaryCalls += 1;
          if (request.expectedHeadOid === headD) {
            return Promise.resolve({
              ...summaryOk(),
              mergeBaseOid: "e".repeat(40),
              localHeadOid: headD,
            });
          }
          return Promise.resolve(summaryOk());
        }
        if (method === "pr.getLocalFileDiff") {
          if (request.headOid === headD) return Promise.resolve(fileOk());
          return Promise.resolve({
            kind: "unavailable",
            reason: "ref-unavailable",
          });
        }
        return Promise.reject(new Error(`unexpected method ${method}`));
      },
    );
    const queryClient = makeQueryClient();
    const mounted = renderTile(queryClient);

    // Episode 1 of A: drift reported, one recovery, quiesce.
    expect(
      await screen.findByText(/no longer available from the local checkout/u),
    ).toBeTruthy();
    await waitFor(() => {
      expect(summaryCalls).toBe(2);
    });
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });

    // The PR advances to D - healthy, no drift, token untouched.
    detailSubscription.current = subscriptionWithHead(headD);
    mounted.view.rerender(
      tileTree({
        queryClient,
        node: tileOnTab(mounted.tabId, mounted.node.instanceId),
        tabId: mounted.tabId,
      }),
    );
    await waitFor(() => {
      expect(summaryCalls).toBe(3);
    });
    expect(await screen.findByTestId("diff-content")).toBeTruthy();
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });

    // Force-push back to A: cached summary, cached unavailable answers,
    // remounted sections - a new episode that must get its ONE recovery.
    detailSubscription.current = subscriptionWithHead(headA);
    mounted.view.rerender(
      tileTree({
        queryClient,
        node: tileOnTab(mounted.tabId, mounted.node.instanceId),
        tabId: mounted.tabId,
      }),
    );
    await waitFor(() => {
      expect(summaryCalls).toBe(4);
    });
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(summaryCalls).toBe(4);
  });

  it("invalidates the per-file scope when a drift refetch resolves the same OIDs", async () => {
    tabHostClient.request.mockImplementation((method: string) => {
      if (method === "pr.getLocalDiffSummary")
        return Promise.resolve(summaryOk());
      if (method === "pr.getLocalFileDiff") {
        return Promise.resolve({
          kind: "unavailable",
          reason: "ref-unavailable",
        });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    renderTile(queryClient);

    expect(
      await screen.findByText(/no longer available from the local checkout/u),
    ).toBeTruthy();

    const expectedScope = prQueryKeys.localFileDiffScope({
      hostId: "host-1",
      epicId: "epic-1",
      linkGroupKey: "/tmp/worktrees/widgets",
      owner: "acme",
      repo: "widgets",
      repoRole: "superproject",
    });
    await waitFor(() => {
      expect(
        invalidateSpy.mock.calls.some((call) => {
          const key = call[0]?.queryKey;
          return (
            Array.isArray(key) &&
            key.length === expectedScope.length &&
            expectedScope.every((part, index) => key[index] === part)
          );
        }),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(methodCalls("pr.getLocalFileDiff").length).toBeGreaterThan(1);
    });
    expect(methodCalls("pr.getLocalFileDiff")[0]?.[1]).toEqual(
      expect.objectContaining({
        path: "src/a.ts",
        byteBudget: DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
      }),
    );
  });

  it("invalidates only unavailable per-file entries, not successful diffs", async () => {
    tabHostClient.request.mockImplementation(
      (method: string, params: { readonly path?: string }) => {
        if (method === "pr.getLocalDiffSummary") {
          return Promise.resolve(
            summaryOkWithFiles([
              {
                path: "src/a.ts",
                previousPath: null,
                status: "modified",
                insertions: 3,
                deletions: 1,
                isBinary: false,
              },
              {
                path: "src/b.ts",
                previousPath: null,
                status: "modified",
                insertions: 2,
                deletions: 0,
                isBinary: false,
              },
            ]),
          );
        }
        if (method === "pr.getLocalFileDiff" && params.path === "src/a.ts") {
          return Promise.resolve(fileOk());
        }
        if (method === "pr.getLocalFileDiff" && params.path === "src/b.ts") {
          return Promise.resolve({
            kind: "unavailable",
            reason: "ref-unavailable",
          });
        }
        return Promise.reject(new Error(`unexpected method ${method}`));
      },
    );
    renderTile(makeQueryClient());

    expect(await screen.findByTestId("diff-content")).toBeTruthy();
    expect(
      await screen.findByText(/no longer available from the local checkout/u),
    ).toBeTruthy();

    await waitFor(() => {
      expect(fileCallsFor("src/b.ts").length).toBeGreaterThan(1);
    });
    expect(fileCallsFor("src/a.ts")).toHaveLength(1);
  });
});
