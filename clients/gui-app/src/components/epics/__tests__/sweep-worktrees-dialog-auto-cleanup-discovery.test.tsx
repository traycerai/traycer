import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import type { WorktreeAutoCleanupPolicyState } from "@traycer/protocol/host/worktree-auto-cleanup-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";

/**
 * The Sweep dialog's passive discovery line for automatic cleanup.
 *
 * The policy RPC runs for real against a `MockHostMessenger`, so "is the read
 * still in flight" and "did it come back enabled" go through the actual query
 * path. Only the two facts the dialog cannot synthesize are stubbed: the
 * candidate census, and whether this host advertised the capability at all.
 */
const testState = vi.hoisted(() => ({
  rows: [] as ReadonlyArray<unknown>,
  supported: true as boolean | null,
  // The HOOK is counted, not only its result: the point of the structure is
  // that a router-less dialog never reaches `useNavigate` at all.
  useNavigateCalls: 0,
  navigations: [] as Array<unknown>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => {
    testState.useNavigateCalls += 1;
    return (options: unknown): void => {
      testState.navigations.push(options);
    };
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => testState.supported,
  useHostSupportsMethod: () => testState.supported === true,
  useHostMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktree-candidates-query", () => ({
  useEpicSweepWorktreeCandidatesForClient: () => ({
    hostId: "host-1",
    rows: testState.rows,
    isPending: false,
    isError: false,
    checkedAt: Date.now(),
    canRefresh: true,
    refresh: () => Promise.resolve(testState.rows),
    prove: () => Promise.resolve(testState.rows),
  }),
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktrees-mutation", () => ({
  useEpicSweepWorktrees: () => ({ isPending: false, mutate: vi.fn() }),
  useSweepingWorktreePaths: () => new Set<string>(),
}));

vi.mock("@/components/worktree/worktree-pr-metadata", () => ({
  WorktreePrPills: () => null,
}));

vi.mock("@/lib/worktree/teardown-agent-names", () => ({
  useTeardownAgentNames: () => new Map<string, string>(),
}));

vi.mock("@/components/settings/panels/use-worktree-task-titles", () => ({
  useWorktreeTaskTitles: () => new Map<string, string>(),
}));

import { SweepWorktreesDialog } from "@/components/epics/sweep-worktrees-dialog";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useWorktreeCleanupViewStore } from "@/stores/settings/worktree-cleanup-view-store";

const DISCOVERY = "sweep-worktrees-auto-cleanup-discovery";

function worktreeEntry(): WorktreeHostEntryV14 {
  return {
    worktreePath: "/tmp/traycer-discovery",
    branch: "traycer/discovery",
    repoLabel: "traycerai/traycer",
    repoIdentifier: { owner: "traycerai", repo: "traycer" },
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    owners: [],
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: true,
    resolvedAt: Date.now(),
  };
}

function sweepRow(defaultChecked: boolean): unknown {
  return {
    entry: worktreeEntry(),
    tier: defaultChecked ? "at-base-commit" : "review",
    defaultChecked,
    disabled: false,
    note: defaultChecked ? null : "not-landed",
    holders: [],
    holdersStatus: "none",
  };
}

function policyFixture(
  overrides: Partial<WorktreeAutoCleanupPolicyState>,
): WorktreeAutoCleanupPolicyState {
  return {
    enabled: false,
    inactivityDays: 30,
    revision: 0,
    updatedAt: null,
    updatedByUserId: null,
    lastEvaluatedAt: null,
    nextEvaluationAt: null,
    pausedReason: null,
    bounds: { minDays: 1, maxDays: 365 },
    ...overrides,
  };
}

function clientWithPolicy(
  get: () =>
    | WorktreeAutoCleanupPolicyState
    | Promise<WorktreeAutoCleanupPolicyState>,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${Math.random().toString(36).slice(2)}`,
      handlers: { "worktree.getAutoCleanupPolicy": () => get() },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

function renderDialog(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly onOpenChange: (open: boolean) => void;
}): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return render(
    <SweepWorktreesDialog
      epicIds={["epic-1"]}
      hostClient={input.client}
      hostChoice={null}
      fleetPending={false}
      taskTitle="Discovery sweep"
      onOpenChange={input.onOpenChange}
    />,
    { wrapper: Wrapper },
  );
}

/** The census is on screen, so anything conditional on it has had its turn. */
async function censusRendered(): Promise<void> {
  await screen.findByText("traycer/discovery");
}

describe("SweepWorktreesDialog automatic-cleanup discovery", () => {
  beforeEach(async () => {
    testState.rows = [sweepRow(true)];
    testState.supported = true;
    testState.useNavigateCalls = 0;
    testState.navigations = [];
    __resetTabNavigationControllerForTesting();
    __resetTabSyncCoordinatorForTesting();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
    useTabsStore.getState().closeSystemTab("settings");
    useSettingsHostScopeStore.setState({ scopedHostId: null });
    useWorktreeCleanupViewStore.setState({
      view: "settings",
      focusedRunId: null,
      autoCleanupFocusHostId: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("offers automatic cleanup beside a proven-safe row while the policy is off", async () => {
    renderDialog({
      client: clientWithPolicy(() => policyFixture({})),
      onOpenChange: () => undefined,
    });

    const line = await screen.findByTestId(DISCOVERY);
    // The sentence describes the POLICY. It must not claim the row on screen
    // is due for automatic removal - Sweep's census never proved inactivity.
    expect(line.textContent).toBe(
      "Proven-safe worktrees can be removed automatically. Set up automatic cleanup",
    );
    const link = screen.getByRole("button", {
      name: "Set up automatic cleanup",
    });
    // A real button, not an anchor: this is an in-app destination, and an href
    // would route through link egress rather than tab navigation.
    expect(link.tagName).toBe("BUTTON");
    expect(link.getAttribute("href")).toBeNull();
  });

  it("retires the line once automatic cleanup is enabled on that host", async () => {
    renderDialog({
      client: clientWithPolicy(() => policyFixture({ enabled: true })),
      onOpenChange: () => undefined,
    });

    await censusRendered();
    // Policy state IS the frequency cap - there is no dismissal to persist.
    await waitFor(() => {
      expect(screen.queryByTestId(DISCOVERY)).toBeNull();
    });
    expect(screen.queryByTestId(DISCOVERY)).toBeNull();
    expect(testState.useNavigateCalls).toBe(0);
  });

  it("says nothing on a host that never advertised the capability", async () => {
    testState.supported = false;
    let reads = 0;
    renderDialog({
      client: clientWithPolicy(() => {
        reads += 1;
        return policyFixture({});
      }),
      onOpenChange: () => undefined,
    });

    await censusRendered();
    expect(screen.queryByTestId(DISCOVERY)).toBeNull();
    // The capability question is asked BEFORE the read is mounted, so a host
    // that negotiated the method away is never asked for a policy.
    expect(reads).toBe(0);
  });

  it("stays silent while the policy read is still in flight", async () => {
    renderDialog({
      client: clientWithPolicy(
        () => new Promise<WorktreeAutoCleanupPolicyState>(() => undefined),
      ),
      onOpenChange: () => undefined,
    });

    await censusRendered();
    // Nothing about the sweep waits on this read, and the read never claims an
    // answer it does not have: an unsettled policy renders nothing.
    expect(screen.queryByTestId(DISCOVERY)).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Remove 1 worktree",
      }).disabled,
    ).toBe(false);
  });

  it("says nothing when the census proved no worktree safe to delete", async () => {
    testState.rows = [sweepRow(false)];
    renderDialog({
      client: clientWithPolicy(() => policyFixture({})),
      onOpenChange: () => undefined,
    });

    await censusRendered();
    // Without a visibly safe example the offer has nothing to stand beside.
    expect(screen.queryByTestId(DISCOVERY)).toBeNull();
  });

  it("closes the dialog and opens Settings ▸ Worktrees on the latched host", async () => {
    const onOpenChange = vi.fn();
    renderDialog({
      client: clientWithPolicy(() => policyFixture({})),
      onOpenChange,
    });

    await screen.findByTestId(DISCOVERY);
    fireEvent.click(
      screen.getByRole("button", { name: "Set up automatic cleanup" }),
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(testState.navigations).toContainEqual(
      expect.objectContaining({ to: "/settings/worktrees" }),
    );
    // The policy is per HOST, so the destination is only well defined once
    // Settings is administering the machine this sweep was pointed at.
    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe("host-1");
    // The inventory, never the cleanup history - and the card asks to be
    // brought into view once the panel mounts it, NAMING the host it is about
    // so another host's card cannot pick the request up later.
    expect(useWorktreeCleanupViewStore.getState()).toMatchObject({
      view: "settings",
      focusedRunId: null,
      autoCleanupFocusHostId: "host-1",
    });
  });

  it("never touches the router unless the line itself renders", async () => {
    // A Sweep dialog rendered without a `RouterProvider` is the normal case in
    // these suites. `useNavigate` only warns outside one, so the guarantee has
    // to be structural: the hook lives in the line, and the line only exists
    // once the capability is proven and the policy came back off.
    testState.supported = false;

    renderDialog({
      client: clientWithPolicy(() => policyFixture({})),
      onOpenChange: () => undefined,
    });

    await censusRendered();
    expect(screen.queryByTestId(DISCOVERY)).toBeNull();
    expect(testState.useNavigateCalls).toBe(0);
  });
});
