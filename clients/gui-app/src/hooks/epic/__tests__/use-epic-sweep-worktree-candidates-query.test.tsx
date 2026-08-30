import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type {
  WorktreeHostEntryV16,
  WorktreeListAllForHostRequestV15,
  WorktreeListAllForHostResponseV16,
  WorktreeListHoldersResponse,
} from "@traycer/protocol/host/worktree-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys";
import { useEpicSweepWorktreeCandidatesForClient } from "@/hooks/epic/use-epic-sweep-worktree-candidates-query";

interface StubOwner {
  readonly epicId: string;
  readonly ownerKind: "chat" | "terminal-agent";
  readonly ownerId: string;
  readonly updatedAt: number;
}

type StubEntry = WorktreeHostEntryV16;

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "host-1",
    requestContextUserId: "user-1",
    isReady: true,
  }),
}));

function owner(epicId: string): StubOwner {
  return { epicId, ownerKind: "chat", ownerId: `chat-${epicId}`, updatedAt: 1 };
}

function entry(over: Partial<StubEntry> & { worktreePath: string }): StubEntry {
  return {
    repoLabel: "acme/app",
    repoIdentifier: null,
    branch: "feat/x",
    uncommittedCount: 0,
    inUse: false,
    gitRemovable: true,
    scripts: null,
    owners: [owner("epic-1")],
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    resolvedAt: 1,
    presence: "present",
    gitUnreadable: false,
    ...over,
  };
}

const BASE_WALK_PARAMS = {
  includeActivity: false,
  activityPaths: null,
  cursor: null,
  limit: null,
  forceRefresh: false,
} as const;

function forcedProbeParams(activityPaths: readonly string[]) {
  return {
    includeActivity: true,
    activityPaths,
    cursor: null,
    limit: null,
    forceRefresh: true,
  };
}

// Reassigned per test/act - the messenger's single registered handler
// delegates here so each case can swap behavior (including across a
// `refresh()` call) without re-constructing the client.
let worktreeHandler: (
  params: WorktreeListAllForHostRequestV15,
) =>
  | Promise<WorktreeListAllForHostResponseV16>
  | WorktreeListAllForHostResponseV16 = () => {
  throw new Error("no worktree handler configured for this test");
};

let listHoldersHandler: (
  worktreePath: string,
) => WorktreeListHoldersResponse = () => ({ holders: [] });

/**
 * Wires the two-request act-time flow: the un-probed base walk returns
 * `baseEntries` (owner discovery only), the forced selection-mode probe
 * returns `probedEntries` (the rows the dialog derives from).
 */
function mockActTimeProbe(
  baseEntries: ReadonlyArray<StubEntry>,
  probedEntries: ReadonlyArray<StubEntry>,
): void {
  worktreeHandler = (params) => ({
    worktrees: params.forceRefresh ? [...probedEntries] : [...baseEntries],
    nextCursor: null,
  });
}

let messenger: MockHostMessenger<HostRpcRegistry>;

function requestParams(index: number): unknown {
  return messenger.calls[index].params;
}

function wrapperFor(queryClient: QueryClient) {
  return (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function renderCandidatesWithQueryClient(
  epicIds: ReadonlyArray<string> | null,
  queryClient: QueryClient,
) {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  return renderHook(
    () => useEpicSweepWorktreeCandidatesForClient(client, epicIds),
    { wrapper: wrapperFor(queryClient) },
  );
}

function renderCandidates(epicIds: ReadonlyArray<string> | null) {
  return renderCandidatesWithQueryClient(epicIds, new QueryClient());
}

describe("useEpicSweepWorktreeCandidatesForClient", () => {
  beforeEach(() => {
    worktreeHandler = () => {
      throw new Error("no worktree handler configured for this test");
    };
    listHoldersHandler = () => ({ holders: [] });
    let requestSeq = 0;
    messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `sweep-${String(++requestSeq)}`,
      handlers: {
        "worktree.listAllForHost": (params) => worktreeHandler(params),
        "worktree.listHolders": (params) =>
          listHoldersHandler(params.worktreePath),
      },
    });
  });

  it("lists EVERY task-owned worktree from the forced probe, pre-checking only greens", async () => {
    mockActTimeProbe(
      [
        entry({ worktreePath: "/wt/landed" }),
        entry({ worktreePath: "/wt/base" }),
        entry({ worktreePath: "/wt/review" }),
        entry({ worktreePath: "/wt/foreign", owners: [owner("epic-2")] }),
      ],
      [
        // Proven landed via validated PR -> merged tier, default-checked.
        entry({
          worktreePath: "/wt/landed",
          prState: "merged",
          mergedHeadShaMatches: true,
        }),
        // Never advanced from its birth commit -> at-base-commit, checked.
        entry({ worktreePath: "/wt/base", atBaseCommit: true }),
        // Unproven -> review tier: LISTED, unchecked, checkable.
        entry({ worktreePath: "/wt/review" }),
      ],
    );
    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.rows).toHaveLength(3);
    });
    expect(result.current.hostId).toBe("host-1");
    const byPath = new Map(
      result.current.rows.map((row) => [row.entry.worktreePath, row]),
    );
    expect(byPath.get("/wt/landed")).toMatchObject({
      tier: "merged",
      defaultChecked: true,
      disabled: false,
      note: null,
    });
    expect(byPath.get("/wt/base")).toMatchObject({
      tier: "at-base-commit",
      defaultChecked: true,
      disabled: false,
      note: null,
    });
    expect(byPath.get("/wt/review")).toMatchObject({
      tier: "review",
      defaultChecked: false,
      disabled: false,
      note: "not-landed",
    });
    // The wire shape of the act-time proof: one cheap owner-discovery walk,
    // then ONE forced probe scoped to exactly the Task-owned paths (the
    // foreign worktree is never probed nor listed).
    expect(requestParams(0)).toEqual(BASE_WALK_PARAMS);
    expect(requestParams(1)).toEqual(
      forcedProbeParams(["/wt/landed", "/wt/base", "/wt/review"]),
    );
    expect(messenger.calls).toHaveLength(2);
  });

  it("catches freshly-dirtied worktrees the cached listing still calls clean", async () => {
    // The stale-clean data-loss window this hook exists to close: the base
    // walk (host cache) still believes the worktree is clean+landed, but the
    // forced re-derive discovers uncommitted changes -> listed unchecked.
    mockActTimeProbe(
      [
        entry({
          worktreePath: "/wt/was-clean",
          prState: "merged",
          mergedHeadShaMatches: true,
        }),
      ],
      [
        entry({
          worktreePath: "/wt/was-clean",
          prState: "merged",
          mergedHeadShaMatches: true,
          uncommittedCount: 2,
        }),
      ],
    );
    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.rows).toHaveLength(1);
    });
    expect(result.current.rows[0]).toMatchObject({
      tier: "review",
      defaultChecked: false,
      disabled: false,
      note: "not-landed",
    });
  });

  it("re-runs the bounded proof on refresh and exposes the fresh host timestamp", async () => {
    const base = entry({ worktreePath: "/wt/recheck" });
    const before = entry({
      worktreePath: "/wt/recheck",
      resolvedAt: 100,
    });
    const after = entry({
      worktreePath: "/wt/recheck",
      prState: "merged",
      mergedHeadShaMatches: true,
      resolvedAt: 200,
    });
    let forcedProbeCount = 0;
    worktreeHandler = (params) => {
      if (!params.forceRefresh) {
        return { worktrees: [base], nextCursor: null };
      }
      forcedProbeCount += 1;
      return {
        worktrees: [forcedProbeCount === 1 ? before : after],
        nextCursor: null,
      };
    };

    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.rows[0]?.tier).toBe("review");
    });
    expect(result.current.checkedAt).toBe(100);
    expect(result.current.canRefresh).toBe(true);

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.rows[0]?.tier).toBe("merged");
    });
    expect(result.current.checkedAt).toBe(200);
    expect(messenger.calls).toHaveLength(4);
    expect(requestParams(3)).toEqual(forcedProbeParams(["/wt/recheck"]));
  });

  it("keeps the last snapshot visible while a fresh proof is in flight", async () => {
    const before = entry({ worktreePath: "/wt/recheck", resolvedAt: 100 });
    const after = entry({
      worktreePath: "/wt/recheck",
      atBaseCommit: true,
      resolvedAt: 200,
    });
    let pauseForcedProbe = false;
    let releaseForcedProbe: (() => void) | null = null;
    worktreeHandler = async (params) => {
      if (!params.forceRefresh) {
        return { worktrees: [before], nextCursor: null };
      }
      if (pauseForcedProbe) {
        await new Promise<void>((resolve) => {
          releaseForcedProbe = resolve;
        });
      }
      return {
        worktrees: [pauseForcedProbe ? after : before],
        nextCursor: null,
      };
    };

    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.checkedAt).toBe(100);
    });

    pauseForcedProbe = true;
    let refreshPromise: Promise<unknown> | null = null;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });
    expect(result.current.rows[0]?.entry.worktreePath).toBe("/wt/recheck");
    expect(result.current.checkedAt).toBe(100);

    await act(async () => {
      releaseForcedProbe?.();
      await refreshPromise;
    });
    await waitFor(() => {
      expect(result.current.checkedAt).toBe(200);
    });
  });

  it("paints from warm task provenance on first open while proving in the background", async () => {
    const warm = entry({
      worktreePath: "/wt/warm",
      atBaseCommit: true,
      resolvedAt: 123,
    });
    const queryClient = new QueryClient();
    queryClient.setQueryData<WorktreeListAllForHostResponseV16>(
      hostQueryKeys.method<HostRpcRegistry, "worktree.listAllForHost">(
        "host-1",
        "worktree.listAllForHost",
        {
          includeActivity: true,
          activityPaths: [warm.worktreePath],
          cursor: null,
          limit: null,
          forceRefresh: false,
        },
      ),
      { worktrees: [warm], nextCursor: null },
    );
    worktreeHandler = () => new Promise(() => {});

    const { result, unmount } = renderCandidatesWithQueryClient(
      ["epic-1"],
      queryClient,
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
      expect(result.current.rows[0]?.entry.worktreePath).toBe("/wt/warm");
    });
    expect(result.current.checkedAt).toBe(123);
    unmount();
  });

  it("marks shared rows checkable-unchecked, in-use checkable-unchecked, and unresolved rows disabled", async () => {
    const probed = [
      entry({
        worktreePath: "/wt/shared",
        owners: [owner("epic-1"), owner("epic-2")],
        prState: "merged",
        mergedHeadShaMatches: true,
      }),
      entry({
        worktreePath: "/wt/busy",
        inUse: true,
        prState: "merged",
        mergedHeadShaMatches: true,
      }),
      entry({
        worktreePath: "/wt/probing",
        resolvedAt: null,
        atBaseCommit: true,
      }),
    ];
    mockActTimeProbe(probed, probed);
    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.rows).toHaveLength(3);
    });
    const byPath = new Map(
      result.current.rows.map((row) => [row.entry.worktreePath, row]),
    );
    expect(byPath.get("/wt/shared")).toMatchObject({
      defaultChecked: false,
      disabled: false,
      note: "shared",
    });
    expect(byPath.get("/wt/busy")).toMatchObject({
      defaultChecked: false,
      disabled: false,
      note: "in-use",
    });
    expect(byPath.get("/wt/probing")).toMatchObject({
      defaultChecked: false,
      disabled: true,
      note: "checking",
    });
  });

  // The bulk-sweep rule the multi-select exists for: "shared" is judged
  // against the SELECTION, not one Task. Selecting every owner of a shared
  // worktree satisfies the constraint, because sweeping the selection removes
  // every binding that referenced it.
  it("stops treating a worktree as shared once ALL its owner tasks are selected", async () => {
    const probed = [
      entry({
        worktreePath: "/wt/shared",
        owners: [owner("epic-1"), owner("epic-2")],
        prState: "merged",
        mergedHeadShaMatches: true,
      }),
    ];
    mockActTimeProbe(probed, probed);
    const { result } = renderCandidates(["epic-1", "epic-2"]);
    await waitFor(() => {
      expect(result.current.rows).toHaveLength(1);
    });
    expect(result.current.rows[0]).toMatchObject({
      tier: "merged",
      defaultChecked: true,
      disabled: false,
      note: null,
    });
  });

  it("keeps a partially-selected shared worktree unchecked and marked shared", async () => {
    const probed = [
      entry({
        worktreePath: "/wt/shared",
        owners: [owner("epic-1"), owner("epic-2"), owner("epic-3")],
        prState: "merged",
        mergedHeadShaMatches: true,
      }),
    ];
    mockActTimeProbe(probed, probed);
    // epic-3 is NOT selected, so one binding would survive the sweep.
    const { result } = renderCandidates(["epic-1", "epic-2"]);
    await waitFor(() => {
      expect(result.current.rows).toHaveLength(1);
    });
    expect(result.current.rows[0]).toMatchObject({
      defaultChecked: false,
      disabled: false,
      note: "shared",
    });
  });

  // The amalgamation: a worktree owned by two selected tasks is ONE row, and
  // the probe covers every selected task's paths.
  it("lists the union of the selection's worktrees, de-duplicated", async () => {
    const shared = entry({
      worktreePath: "/wt/shared",
      owners: [owner("epic-1"), owner("epic-2")],
      atBaseCommit: true,
    });
    const onlyOne = entry({ worktreePath: "/wt/one", atBaseCommit: true });
    const onlyTwo = entry({
      worktreePath: "/wt/two",
      owners: [owner("epic-2")],
      atBaseCommit: true,
    });
    mockActTimeProbe([shared, onlyOne, onlyTwo], [shared, onlyOne, onlyTwo]);
    const { result } = renderCandidates(["epic-1", "epic-2"]);
    await waitFor(() => {
      expect(result.current.rows).toHaveLength(3);
    });
    expect(result.current.rows.map((r) => r.entry.worktreePath)).toEqual([
      "/wt/shared",
      "/wt/one",
      "/wt/two",
    ]);
    expect(requestParams(1)).toEqual(
      forcedProbeParams(["/wt/shared", "/wt/one", "/wt/two"]),
    );
  });

  it("skips the forced probe entirely when the Task owns no worktrees", async () => {
    mockActTimeProbe(
      [entry({ worktreePath: "/wt/foreign", owners: [owner("epic-2")] })],
      [],
    );
    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
    expect(result.current.rows).toEqual([]);
    // Only the base walk ran - no forced probe for an empty path set.
    expect(messenger.calls).toHaveLength(1);
    expect(requestParams(0)).toEqual(BASE_WALK_PARAMS);
  });

  it("yields zero rows on a failed probe (failure -> no candidates)", async () => {
    worktreeHandler = () => {
      throw new Error("probe failed");
    };
    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.hostId).toBeNull();
    expect(result.current.rows).toEqual([]);
  });

  it("stays disabled while the dialog is closed (null epicId)", () => {
    mockActTimeProbe(
      [entry({ worktreePath: "/wt/a", atBaseCommit: true })],
      [],
    );
    const { result } = renderCandidates(null);
    expect(result.current.hostId).toBeNull();
    expect(result.current.rows).toEqual([]);
    expect(result.current.isPending).toBe(false);
    expect(messenger.calls).toHaveLength(0);
  });

  it("loads listHolders for in-use rows and keeps a digest for consent", async () => {
    const holder: WorktreeBusyHolder = {
      ownerRef: {
        epicId: "epic-1",
        ownerKind: "chat",
        ownerId: "chat-1",
      },
      holdKind: "chat-turn",
      activity: "working",
      label: "Fixing persistent busyness is working",
      holderId: "epic-1:chat:chat-1",
    };
    listHoldersHandler = () => ({
      holders: [holder],
      holdersRevision:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const probed = [
      entry({
        worktreePath: "/wt/busy",
        inUse: true,
        prState: "merged",
        mergedHeadShaMatches: true,
      }),
    ];
    mockActTimeProbe(probed, probed);
    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.rows[0]?.holdersStatus).toBe("ready");
    });
    expect(result.current.rows[0]).toMatchObject({
      note: "in-use",
      disabled: false,
      holdersStatus: "ready",
      holdersRevision:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      holders: [holder],
    });
  });

  it("treats a missing holdersRevision as the unknown fallback", async () => {
    const holder: WorktreeBusyHolder = {
      ownerRef: {
        epicId: "epic-1",
        ownerKind: "chat",
        ownerId: "chat-1",
      },
      holdKind: "chat-turn",
      activity: "working",
      label: "Fixing persistent busyness is working",
      holderId: "epic-1:chat:chat-1",
    };
    listHoldersHandler = () => ({ holders: [holder] });
    const probed = [
      entry({
        worktreePath: "/wt/busy",
        inUse: true,
        prState: "merged",
        mergedHeadShaMatches: true,
      }),
    ];
    mockActTimeProbe(probed, probed);
    const { result } = renderCandidates(["epic-1"]);
    await waitFor(() => {
      expect(result.current.rows[0]?.holdersStatus).toBe("unknown");
    });
    expect(result.current.rows[0]).toMatchObject({
      disabled: false,
      holders: [],
      holdersRevision: undefined,
    });
  });
});
