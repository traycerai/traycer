import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { WorktreeDeleteStreamCallbacks } from "@traycer-clients/shared/host-transport/worktree-delete-stream-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import type {
  WorktreeEntryScripts,
  WorktreeSubmoduleMergeFactV12,
} from "@traycer/protocol/host/worktree-schemas";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { WorktreesList } from "@/components/settings/panels/worktrees-settings-panel";
import { useWorktreeListing } from "@/components/settings/panels/worktrees-listing-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { __resetWorktreeDeleteRunForTests } from "@/components/settings/panels/use-worktree-delete-run";
import { hostQueryKeys } from "@/lib/query-keys";
import { WORKTREE_BINDING_INVALIDATIONS } from "@/hooks/worktree/invalidations";
import {
  installWorktreeVirtualizerOffsetHeight,
  WORKTREE_TEST_VIRTUAL_ITEM_HEIGHT,
} from "./worktrees-virtualizer-test-utils";

// The delete is a stream: mock the wrapper so a test can drive server frames
// (started / phase / output / complete / failed) and assert the modal + cache
// behaviour without a real socket.
const streamMock = vi.hoisted(() => ({
  callbacks: null as WorktreeDeleteStreamCallbacks | null,
  callbacksByPath: new Map<string, WorktreeDeleteStreamCallbacks>(),
  paths: [] as string[],
  scriptsByPath: new Map<string, WorktreeEntryScripts | null>(),
  throwForPaths: new Set<string>(),
  closeCount: 0,
}));

// Capture the confirm-time "dropped rows" toast so its class-summarized copy can
// be asserted.
const toastMock = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("sonner", () => ({
  toast: {
    message: (message: string) => {
      toastMock.messages.push(message);
    },
    success: (message: string) => {
      toastMock.messages.push(message);
    },
    error: (message: string) => {
      toastMock.messages.push(message);
    },
  },
}));

const routerMock = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => routerMock.navigate,
}));

const tabNavigationMock = vi.hoisted(() => ({
  navigateToTabIntent: vi.fn(),
  openOrFocusEpicIntent: vi.fn(
    (input: { readonly epicId: string; readonly focus: unknown }) => ({
      kind: "epic",
      epicId: input.epicId,
      tabId: `tab-${input.epicId}`,
      focus: input.focus,
    }),
  ),
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: tabNavigationMock.navigateToTabIntent,
  openOrFocusEpicIntent: tabNavigationMock.openOrFocusEpicIntent,
}));

// Render the Radix dropdown menus inline + always-open so tests can assert /
// click the Select and Sort menu items without fighting pointer-open semantics
// in jsdom (mirrors the established mock in folder-controls.test).
vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = (props: { readonly children: ReactNode }): ReactNode =>
    props.children;
  const item = (props: {
    readonly children: ReactNode;
    readonly onSelect?: () => void;
    readonly disabled?: boolean;
    readonly "aria-label"?: string;
    readonly className?: string;
    readonly title?: string;
    readonly variant?: string;
    readonly "data-testid"?: string;
  }): ReactNode => (
    <button
      type="button"
      aria-label={props["aria-label"]}
      className={props.className}
      data-variant={props.variant}
      data-testid={props["data-testid"]}
      disabled={props.disabled ?? false}
      onClick={props.onSelect}
      title={props.title}
    >
      {props.children}
    </button>
  );
  const checkboxItem = (props: {
    readonly children: ReactNode;
    readonly onSelect?: () => void;
    readonly checked?: boolean;
    readonly "data-testid"?: string;
  }): ReactNode => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={props.checked ? "true" : "false"}
      data-testid={props["data-testid"]}
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  );
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: (props: {
      readonly children: ReactNode;
      readonly className?: string;
      readonly "data-testid"?: string;
    }) => (
      <div className={props.className} data-testid={props["data-testid"]}>
        {props.children}
      </div>
    ),
    DropdownMenuItem: item,
    DropdownMenuCheckboxItem: checkboxItem,
    DropdownMenuSeparator: () => <div role="separator" />,
    DropdownMenuLabel: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
  };
});

vi.mock(
  "@traycer-clients/shared/host-transport/worktree-delete-stream-client",
  () => ({
    WorktreeDeleteStreamClient: class {
      constructor(options: {
        readonly worktreePath: string;
        readonly scripts: WorktreeEntryScripts | null;
        readonly callbacks: WorktreeDeleteStreamCallbacks;
      }) {
        streamMock.paths.push(options.worktreePath);
        if (streamMock.throwForPaths.has(options.worktreePath)) {
          throw new Error(`cannot subscribe ${options.worktreePath}`);
        }
        streamMock.scriptsByPath.set(options.worktreePath, options.scripts);
        streamMock.callbacks = options.callbacks;
        streamMock.callbacksByPath.set(options.worktreePath, options.callbacks);
      }
      close(): void {
        streamMock.closeCount += 1;
      }
    },
  }),
);

// A real `WsStreamClient` whose factory throws if dialled - the mocked stream
// wrapper above never calls `.subscribe`, so it is only a non-null token that
// lets `useWorktreeDeleteRun` proceed past its `streamClient === null` gate.
function stubStreamClient(): WsStreamClient<HostStreamRpcRegistry> {
  return new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    endpoint: () => null,
    bearer: () => null,
    auth: null,
    webSocketFactory: {
      create: () => {
        throw new Error("stream WS factory must not be dialled in tests");
      },
    },
    dialTimeoutMs: 1,
    openAckTimeoutMs: 1,
    pingIntervalMs: 1,
    pongTimeoutMs: 1,
    initialBackoffMs: 1,
    maxBackoffMs: 1,
  });
}

function stubOpenStreamTransport() {
  return {
    wsStreamClient: stubStreamClient(),
    close: vi.fn(),
  };
}

type WorktreeSubmoduleMergeFactInput = Omit<
  WorktreeSubmoduleMergeFactV12,
  "unmergedCommitCount" | "unmergedCommitSubjects"
> &
  Partial<
    Pick<
      WorktreeSubmoduleMergeFactV12,
      "unmergedCommitCount" | "unmergedCommitSubjects"
    >
  >;

function entry(
  over: Partial<Omit<WorktreeHostEntryV14, "submodules">> & {
    worktreePath: string;
    branch: string;
    submodules?: readonly WorktreeSubmoduleMergeFactInput[];
  },
): WorktreeHostEntryV14 {
  const { submodules, ...rest } = over;
  return {
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    // v1.2 staleness + merge-provenance signals default to the "no signal /
    // older host" shape so each test opts into only the fields it exercises.
    owners: [],
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules:
      submodules?.map((submodule) => ({
        ...submodule,
        unmergedCommitCount: submodule.unmergedCommitCount ?? null,
        unmergedCommitSubjects: submodule.unmergedCommitSubjects ?? null,
      })) ?? [],
    atBaseCommit: false,
    resolvedAt: 1,
    ...rest,
  };
}

const WORKTREES: WorktreeHostEntryV14[] = [
  entry({
    worktreePath: "/wt/clean",
    branch: "feat-clean",
    scripts: {
      setup: {
        default: "bun install",
        macos: null,
        windows: null,
        linux: null,
      },
      teardown: {
        default: "bun run cleanup",
        macos: null,
        windows: null,
        linux: null,
      },
      updatedAt: 1,
    },
  }),
  entry({
    worktreePath: "/wt/dirty",
    branch: "feat-dirty",
    uncommittedCount: 3,
  }),
  entry({ worktreePath: "/wt/busy", branch: "feat-busy", inUse: true }),
];

let virtualViewportHeight = 100_000;
let restoreOffsetHeight: (() => void) | null = null;

beforeEach(() => {
  virtualViewportHeight = 100_000;
  restoreOffsetHeight = installWorktreeVirtualizerOffsetHeight(
    () => virtualViewportHeight,
  );
});

afterEach(() => {
  if (restoreOffsetHeight !== null) {
    restoreOffsetHeight();
  }
  restoreOffsetHeight = null;
});

// Treat every passed worktree as already-enriched (its base entry IS its enriched
// entry) - the default the behavioural tests want, so tiers classify immediately.
// Tests that exercise the pending/lazy path pass their own partial overlay.
function fullyEnriched(
  worktrees: readonly WorktreeHostEntryV14[],
): ReadonlyMap<string, WorktreeHostEntryV14> {
  return new Map(worktrees.map((entry) => [entry.worktreePath, entry]));
}

function renderList(args: {
  readonly hostId: string;
  readonly queryClient: QueryClient;
  readonly worktrees: readonly WorktreeHostEntryV14[];
  readonly enrichedByPath:
    ReadonlyMap<string, WorktreeHostEntryV14> | undefined;
  readonly erroredPaths: ReadonlySet<string> | undefined;
  readonly seededPaths: ReadonlySet<string> | undefined;
  readonly onVisiblePathsChange:
    ((paths: readonly string[]) => void) | undefined;
  readonly taskTitlesByEpicId: ReadonlyMap<string, string> | undefined;
}) {
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={args.queryClient}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  return render(
    <Wrapper>
      <WorktreesList
        openStreamTransport={() => stubOpenStreamTransport()}
        hostId={args.hostId}
        worktrees={args.worktrees}
        enrichedByPath={args.enrichedByPath ?? fullyEnriched(args.worktrees)}
        erroredPaths={args.erroredPaths ?? new Set()}
        seededPaths={args.seededPaths ?? new Set()}
        onVisiblePathsChange={args.onVisiblePathsChange ?? vi.fn()}
        taskTitlesByEpicId={args.taskTitlesByEpicId ?? new Map()}
        toolbarProps={testToolbarProps()}
      />
    </Wrapper>,
  );
}

// Renders the toolbar with explicit props (the `renderList` helper always
// passes the null-timestamp default) so tests can exercise the freshness label.
function renderListWithToolbar(toolbarProps: ToolbarTestProps): void {
  const queryClient = new QueryClient();
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  render(
    <Wrapper>
      <WorktreesList
        openStreamTransport={() => stubOpenStreamTransport()}
        hostId="host-a"
        worktrees={WORKTREES}
        enrichedByPath={fullyEnriched(WORKTREES)}
        erroredPaths={new Set()}
        seededPaths={new Set()}
        onVisiblePathsChange={vi.fn()}
        taskTitlesByEpicId={new Map()}
        toolbarProps={toolbarProps}
      />
    </Wrapper>,
  );
}

function renderDefault(): void {
  renderList({
    hostId: "host-a",
    queryClient: new QueryClient(),
    worktrees: WORKTREES,
    enrichedByPath: undefined,
    erroredPaths: undefined,
    seededPaths: undefined,
    onVisiblePathsChange: undefined,
    taskTitlesByEpicId: undefined,
  });
}

function confirmDelete(branch: string): void {
  fireEvent.click(
    screen.getByRole("button", { name: `Delete worktree ${branch}` }),
  );
  fireEvent.click(screen.getByTestId("confirm-action"));
}

// No selection mode: checkboxes are always present. Hand-pick rows directly.
function selectRows(branches: readonly string[]): void {
  for (const branch of branches) {
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Select worktree ${branch}` }),
    );
  }
}

function callbacksFor(path: string): WorktreeDeleteStreamCallbacks {
  const callbacks = streamMock.callbacksByPath.get(path);
  if (callbacks === undefined) {
    throw new Error(`expected callbacks for ${path}`);
  }
  return callbacks;
}

type ToolbarTestProps = {
  hosts: readonly HostDirectoryEntry[];
  value: string | null;
  onChange: (hostId: string) => void;
  onRefresh: () => Promise<unknown>;
  refreshing: boolean;
  canRefresh: boolean;
  lastUpdatedAt: number | null;
};

function testToolbarProps(): ToolbarTestProps {
  return {
    hosts: [],
    value: null,
    onChange: vi.fn(),
    onRefresh: vi.fn(),
    refreshing: false,
    canRefresh: true,
    lastUpdatedAt: null,
  };
}

function toolbarButtonLabels(): string[] {
  const actions = screen.getByTestId("worktrees-toolbar-actions");
  return within(actions)
    .getAllByRole("button")
    .map((button) => {
      return button.getAttribute("aria-label") ?? button.textContent.trim();
    });
}

describe("useWorktreeListing", () => {
  afterEach(() => {
    cleanup();
  });

  it("accumulates finite base-list pages", async () => {
    const first = entry({ worktreePath: "/wt/a", branch: "feat-a" });
    const second = entry({ worktreePath: "/wt/b", branch: "feat-b" });
    const requests: Array<{
      readonly cursor: string | null;
      readonly limit: number | null;
      readonly activityPaths: readonly string[] | null;
      readonly includeActivity: boolean;
    }> = [];
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {
          "worktree.listAllForHost": (params) => {
            requests.push(params);
            if (params.cursor === null) {
              return {
                worktrees: [first],
                nextCursor: first.worktreePath,
              };
            }
            return {
              worktrees: [second],
              nextCursor: null,
            };
          },
        },
      }),
    });
    client.bind(mockLocalHostEntry);
    client.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const queryClient = new QueryClient();
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useWorktreeListing(client, true), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.worktrees.map((item) => item.worktreePath)).toEqual(
        ["/wt/a", "/wt/b"],
      );
    });
    // Every page of the automatic listing sends `forceRefresh: false`: a poll
    // must serve the host's TTL-cached view, never force a disk recompute.
    // Only the toolbar's Refresh sends `true`.
    expect(requests).toEqual([
      {
        includeActivity: false,
        activityPaths: null,
        cursor: null,
        limit: 32,
        forceRefresh: false,
      },
      {
        includeActivity: false,
        activityPaths: null,
        cursor: first.worktreePath,
        limit: 32,
        forceRefresh: false,
      },
    ]);
  });

  // The 5-minute host-side TTL rests on "staleness between polls is acceptable
  // BECAUSE manual refresh is the freshness path", so the refresh MUST send
  // `forceRefresh: true` - and the fresh data must land in the SAME cache entry
  // the view already reads, not a forked `forceRefresh: true` key.
  it("sends forceRefresh: true for a manual refresh and lands it in the same cache entry", async () => {
    const stale = entry({ worktreePath: "/wt/a", branch: "stale" });
    const fresh = entry({ worktreePath: "/wt/a", branch: "fresh" });
    const requests: Array<{ readonly forceRefresh: boolean }> = [];
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {
          "worktree.listAllForHost": (params) => {
            requests.push({ forceRefresh: params.forceRefresh });
            // The host serves its TTL-cached (stale) view unless forced.
            return {
              worktrees: [params.forceRefresh ? fresh : stale],
              nextCursor: null,
            };
          },
        },
      }),
    });
    client.bind(mockLocalHostEntry);
    client.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const queryClient = new QueryClient();
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useWorktreeListing(client, true), {
      wrapper,
    });
    await waitFor(() => {
      expect(result.current.worktrees.map((item) => item.branch)).toEqual([
        "stale",
      ]);
    });
    expect(requests).toEqual([{ forceRefresh: false }]);

    // Exactly what the toolbar's Refresh button runs (worktrees-settings-panel):
    // one awaited resolve-now request, with no global force window.
    await act(async () => {
      await result.current.refresh();
    });

    expect(requests).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
    // Same hook instance - so the forced response landed in the entry this
    // view reads, rather than a second, forked cache entry.
    await waitFor(() => {
      expect(result.current.worktrees.map((item) => item.branch)).toEqual([
        "fresh",
      ]);
    });
  });

  it("flags a truncated list as partial instead of hiding the failed page", async () => {
    const first = entry({ worktreePath: "/wt/a", branch: "feat-a" });
    let firstPageCalls = 0;
    let secondPageCalls = 0;
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {
          "worktree.listAllForHost": (params) => {
            if (params.cursor === null) {
              firstPageCalls += 1;
              return {
                worktrees: [first],
                nextCursor: first.worktreePath,
              };
            }
            secondPageCalls += 1;
            throw new Error("host unreachable");
          },
        },
      }),
    });
    client.bind(mockLocalHostEntry);
    client.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useWorktreeListing(client, true), {
      wrapper,
    });

    await waitFor(() => {
      expect(secondPageCalls).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(result.current.isPartial).toBe(true);
    });
    // The earlier page's data survives - a truncated list is still useful,
    // and must never be reported as `isError`/`isEmpty` (both would hide it).
    expect(result.current.worktrees.map((item) => item.worktreePath)).toEqual([
      "/wt/a",
    ]);
    expect(result.current.isError).toBe(false);
    expect(result.current.isEmpty).toBe(false);
    expect(result.current.errorMessage).not.toBeNull();

    const firstPageCallsBeforeRetry = firstPageCalls;
    const secondPageCallsBeforeRetry = secondPageCalls;
    await act(async () => {
      await result.current.retryPartial();
    });
    // Retrying resumes only the failed page - the already-landed first page
    // must not be re-requested.
    expect(firstPageCalls).toBe(firstPageCallsBeforeRetry);
    expect(secondPageCalls).toBe(secondPageCallsBeforeRetry + 1);
  });
});

describe("WorktreesList delete flow", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    __resetWorktreeDeleteRunForTests();
    streamMock.callbacks = null;
    streamMock.callbacksByPath.clear();
    streamMock.paths = [];
    streamMock.scriptsByPath.clear();
    streamMock.throwForPaths.clear();
    streamMock.closeCount = 0;
    toastMock.messages = [];
  });

  it("disables delete for an in-use worktree", () => {
    renderDefault();
    const busyButton = screen.getByRole("button", {
      name: /in use by an active chat or agent/i,
    });
    expect(busyButton.hasAttribute("disabled")).toBe(true);
  });

  it("renders unresolved rows as checking and excludes them from destructive selection", () => {
    const unresolved = entry({
      worktreePath: "/wt/unresolved",
      branch: "feat-unresolved",
      // These schema-safe defaults would otherwise classify as clean enough
      // to select. resolvedAt is the authoritative fail-closed gate.
      resolvedAt: null,
      inUse: false,
      uncommittedCount: 0,
      gitRemovable: true,
    });
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [unresolved],
      enrichedByPath: fullyEnriched([unresolved]),
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    screen.getByTestId("worktree-tier-pill-pending-spinner");
    screen.getByText("Waiting for host verification…");
    expect(
      screen
        .getByRole("checkbox", { name: "Select worktree feat-unresolved" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: /status is still being checked/i })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps an unresolved base row authoritative over a cached resolved enrichment", () => {
    const unresolvedBase = entry({
      worktreePath: "/wt/regressed",
      branch: "feat-regressed",
      resolvedAt: null,
      inUse: false,
      uncommittedCount: 0,
      gitRemovable: true,
    });
    const staleResolvedEnrichment = entry({
      worktreePath: "/wt/regressed",
      branch: "feat-regressed",
      resolvedAt: 100,
      inUse: false,
      uncommittedCount: 0,
      gitRemovable: true,
    });
    const deleteRunsBefore = streamMock.paths.length;
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [unresolvedBase],
      enrichedByPath: fullyEnriched([staleResolvedEnrichment]),
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    screen.getByTestId("worktree-tier-pill-pending-spinner");
    const checkbox = screen.getByRole("checkbox", {
      name: "Select worktree feat-regressed",
    });
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    const deleteButton = screen.getByRole("button", {
      name: /status is still being checked/i,
    });
    expect(deleteButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(deleteButton);
    expect(streamMock.paths).toHaveLength(deleteRunsBefore);
  });

  it("gates delete on live data: a snapshot-seeded row keeps its restored tier but is not deletable", () => {
    const seededRow = entry({
      worktreePath: "/wt/seeded",
      branch: "feat-seeded",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    const queryClient = new QueryClient();
    const rendered = renderList({
      hostId: "host-a",
      queryClient,
      worktrees: [seededRow],
      enrichedByPath: undefined, // overlay present, exactly as the restore seeds it
      erroredPaths: undefined,
      seededPaths: new Set(["/wt/seeded"]),
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    // Display keeps the restored tier - warm-open value is not sacrificed:
    // the row shows its "Landed" pill, never the pending spinner. (The tier
    // filter menu also says "Landed", hence getAllByText.)
    expect(screen.getAllByText("Landed").length).toBeGreaterThan(0);
    expect(
      screen.queryByTestId("worktree-tier-pill-pending-spinner"),
    ).toBeNull();
    // But the delete affordance reads the DELETE-scoped state: seeded =
    // still-checking, so the row action is disabled with the checking copy.
    const gatedButton = screen.getByRole("button", {
      name: /status is still being checked/i,
    });
    expect(gatedButton.hasAttribute("disabled")).toBe(true);

    // Once the live probe replaces the seed (the path leaves `seededPaths`),
    // the same row becomes deletable through the normal confirmation. Drive
    // that as a prop update on the LIVE tree rather than a remount: the row's
    // memo comparator is what has to notice the change, and a fresh mount
    // would sidestep it entirely.
    rendered.rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WorktreesList
            openStreamTransport={() => stubOpenStreamTransport()}
            hostId="host-a"
            worktrees={[seededRow]}
            enrichedByPath={fullyEnriched([seededRow])}
            erroredPaths={new Set()}
            seededPaths={new Set()}
            onVisiblePathsChange={vi.fn()}
            taskTitlesByEpicId={new Map()}
            toolbarProps={testToolbarProps()}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete worktree feat-seeded" }),
    );
    screen.getByText("Delete worktree?");
  });

  it("drops snapshot-seeded rows from a bulk delete request", () => {
    const seeded = entry({
      worktreePath: "/wt/seeded",
      branch: "feat-seeded",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    const live = entry({
      worktreePath: "/wt/live",
      branch: "feat-live",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [seeded, live],
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: new Set(["/wt/seeded"]),
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    fireEvent.click(screen.getByTestId("worktrees-select-all"));

    // A seeded row counts as still-checking for the selection action bar:
    // bulk delete is blocked with the checking notice (same rule as a row
    // whose probe genuinely hasn't landed), so no confirmation can open that
    // would trust the seeded entry.
    screen.getByText("1 selected worktree is still checking status");
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    expect(screen.queryByText("Delete 2 worktrees?")).toBeNull();
    expect(screen.queryByText("Delete worktree?")).toBeNull();
  });

  it("keeps a stable toolbar; the selection action bar is separate and only shown when selecting", () => {
    renderDefault();

    // Toolbar action group stays put regardless of selection: expand-all and
    // Refresh (last so it never shifts). Filter/Sort live in the row below.
    expect(toolbarButtonLabels()).toEqual([
      "Collapse all",
      "Refresh worktrees",
    ]);
    // No selection yet -> no contextual action bar.
    expect(screen.queryByTestId("worktrees-selection-action-bar")).toBeNull();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select worktree feat-clean" }),
    );

    // The toolbar action group is unchanged; the delete lives in the action bar.
    expect(toolbarButtonLabels()).toEqual([
      "Collapse all",
      "Refresh worktrees",
    ]);
    const actionBar = screen.getByTestId("worktrees-selection-action-bar");
    expect(actionBar.className).toContain("border-border");
    expect(actionBar.className).toContain("ring-foreground");
    expect(actionBar.className).toContain("bg-popover");
    within(actionBar).getByText("1 selected");
    within(actionBar).getByText("Delete 1 worktree");
    expect(
      within(actionBar).getByTestId("worktrees-list-delete-selected").className,
    ).toContain("whitespace-nowrap");
  });

  it("shows the freshness label for a real timestamp and suppresses it while refreshing", () => {
    // A non-null lastUpdatedAt renders the "Updated …" label; the null-timestamp
    // fixtures elsewhere only cover its absence.
    renderListWithToolbar({
      ...testToolbarProps(),
      lastUpdatedAt: Date.now() - 60_000,
      refreshing: false,
    });
    const label = screen.getByTestId("worktrees-updated-ago");
    expect(label.textContent).toMatch(/^Updated /);

    cleanup();

    // While a manual refresh is in flight the timestamp is suppressed (the
    // spinning Refresh button stands in for it).
    renderListWithToolbar({
      ...testToolbarProps(),
      lastUpdatedAt: Date.now() - 60_000,
      refreshing: true,
    });
    expect(screen.queryByTestId("worktrees-updated-ago")).toBeNull();
  });

  it("selecting the first row does not insert a new top bar that shifts the list", () => {
    renderDefault();
    const scrollRegion = screen.getByTestId("worktrees-virtual-scroll");
    const wrapper = scrollRegion.parentElement;
    // The scroll region is the first thing in its wrapper before any
    // selection - nothing sits above it in flow.
    expect(scrollRegion.previousElementSibling).toBeNull();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select worktree feat-clean" }),
    );

    // Selecting the first row must not insert a new bar ABOVE the list: the
    // scroll region keeps its position, and the contextual action bar that
    // appears is an out-of-flow overlay inside the SAME wrapper, not a
    // preceding sibling that would push the list down.
    expect(scrollRegion.previousElementSibling).toBeNull();
    const actionBar = screen.getByTestId("worktrees-selection-action-bar");
    expect(actionBar.parentElement).toBe(wrapper);
    expect(actionBar.className).toContain("absolute");
  });

  it("clears the selection and hides the action bar and count", () => {
    renderDefault();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select worktree feat-clean" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select worktree feat-dirty" }),
    );
    expect(screen.getByText("2 selected")).not.toBeNull();

    fireEvent.click(screen.getByTestId("worktrees-clear-selection-inline"));

    expect(screen.queryByTestId("worktrees-selection-action-bar")).toBeNull();
    expect(screen.queryByText("2 selected")).toBeNull();
    expect(
      screen
        .getByRole("checkbox", { name: "Select worktree feat-clean" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("gives the scroll viewport a minimum bottom clearance while selecting, and removes it once cleared", () => {
    renderDefault();
    const scrollRegion = screen.getByTestId("worktrees-virtual-scroll");
    expect(scrollRegion.style.paddingBottom).toBe("");

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select worktree feat-clean" }),
    );

    // jsdom reports a zero-height action bar (no real layout), so the
    // clearance mechanism falls back to its seeded minimum rather than
    // collapsing to zero - the same floor the old fixed `pb-16` provided.
    expect(scrollRegion.style.paddingBottom).toBe("64px");

    fireEvent.click(screen.getByTestId("worktrees-clear-selection-inline"));

    expect(scrollRegion.style.paddingBottom).toBe("");
  });

  it("grows the scroll clearance to match a taller (wrapped) action bar instead of the fixed minimum", () => {
    renderDefault();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select worktree feat-clean" }),
    );
    const actionBar = screen.getByTestId("worktrees-selection-action-bar");
    // Simulate the bar wrapping to two lines (narrow width, or the
    // `Checking` notice pushing it taller) by measuring taller than the
    // seeded minimum clearance.
    Object.defineProperty(actionBar, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 300,
        height: 96,
        top: 0,
        right: 300,
        bottom: 96,
        left: 0,
        toJSON: () => ({}),
      }),
    });

    // Force a re-render of the same mounted action bar (no unmount, so the
    // mocked node and its override survive) so the height observer's
    // snapshot is re-read against the taller measurement.
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select worktree feat-dirty" }),
    );

    const scrollRegion = screen.getByTestId("worktrees-virtual-scroll");
    // 96px measured height + the bar's own gap/offset clearance (32px),
    // clearly exceeding the 64px seeded minimum - proving the clearance
    // tracks the bar's real rendered height rather than a hard-coded value.
    expect(scrollRegion.style.paddingBottom).toBe("128px");
  });

  it("excludes an in-use row and a backgrounded-deleting row from selection and select-all", () => {
    renderDefault();
    confirmDelete("feat-dirty");
    act(() => {
      streamMock.callbacks?.onStarted(true);
      streamMock.callbacks?.onPhase("teardown");
    });
    // Backgrounds the running delete so the row stays locked as "deleting".
    fireEvent.click(screen.getByTestId("worktree-delete-close-button"));

    const busyCheckbox = screen.getByRole("checkbox", {
      name: "Select worktree feat-busy",
    });
    expect(busyCheckbox.getAttribute("aria-disabled")).toBe("true");
    // The dirty row's own checkbox is now locked while its delete runs.
    expect(
      screen
        .getByRole("checkbox", { name: "Select worktree feat-dirty" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    // Select-all only picks up the one remaining selectable row (feat-clean).
    fireEvent.click(screen.getByTestId("worktrees-select-all"));
    expect(screen.getByText("1 selected")).not.toBeNull();
    expect(busyCheckbox.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(streamMock.paths).toEqual(["/wt/dirty", "/wt/clean"]);
  });

  it("select-all-visible only picks rows matching an active search", () => {
    renderDefault();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search worktrees" }),
      { target: { value: "dirty" } },
    );
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-clean" }),
    ).toBeNull();

    fireEvent.click(screen.getByTestId("worktrees-select-all"));
    expect(screen.getByText("1 selected")).not.toBeNull();

    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(streamMock.paths).toEqual(["/wt/dirty"]);
  });

  it("collapses and expands a repo section", () => {
    const multiRepoWorktrees = [
      ...WORKTREES,
      entry({
        repoLabel: "acme/api",
        repoIdentifier: { owner: "acme", repo: "api" },
        worktreePath: "/wt/api-clean",
        branch: "feat-api-clean",
      }),
    ];
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: multiRepoWorktrees,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    screen.getByRole("button", { name: "Delete worktree feat-clean" });
    screen.getByRole("button", { name: "Delete worktree feat-api-clean" });

    const headerWrappers = screen
      .getAllByTestId("worktree-repo-header")
      .map((header) => header.closest("[data-index]"));
    expect(
      headerWrappers.filter((wrapper) => wrapper?.className.includes("sticky")),
    ).toHaveLength(1);
    expect(
      headerWrappers.filter((wrapper) =>
        wrapper?.className.includes("absolute"),
      ).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Collapse acme/app" }));

    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-clean" }),
    ).toBeNull();
    screen.getByRole("button", { name: "Delete worktree feat-api-clean" });

    fireEvent.click(screen.getByRole("button", { name: "Expand acme/app" }));

    screen.getByRole("button", { name: "Delete worktree feat-clean" });
  });

  it("collapses and expands all repos and selects only visible worktrees", () => {
    const multiRepoWorktrees = [
      ...WORKTREES,
      entry({
        repoLabel: "acme/api",
        repoIdentifier: { owner: "acme", repo: "api" },
        worktreePath: "/wt/api-clean",
        branch: "feat-api-clean",
      }),
    ];
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: multiRepoWorktrees,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));

    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-clean" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Delete worktree feat-api-clean",
      }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));

    screen.getByRole("button", { name: "Delete worktree feat-clean" });
    screen.getByRole("button", { name: "Delete worktree feat-api-clean" });

    fireEvent.click(screen.getByRole("button", { name: "Collapse acme/app" }));
    // Only the visible acme/api row can be hand-selected; the collapsed acme/app
    // rows are not reachable.
    expect(
      screen.queryByRole("checkbox", { name: "Select worktree feat-clean" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select worktree feat-api-clean" }),
    );

    expect(screen.getByText("1 selected")).not.toBeNull();
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(streamMock.paths).toEqual(["/wt/api-clean"]);
  });

  it("keeps row actions in one compact overflow with destructive delete", () => {
    renderDefault();

    const row = screen
      .getByText("feat-clean")
      .closest('[data-testid="worktree-row"]');
    if (row === null) throw new Error("expected feat-clean row");

    const trigger = within(row as HTMLElement).getByRole("button", {
      name: "Worktree actions for feat-clean",
    });
    expect(trigger.className).not.toContain("opacity-0");
    expect(trigger.className).not.toContain("group-hover/worktree-row");

    const menu = within(row as HTMLElement).getByTestId(
      "worktree-row-actions-menu",
    );
    expect(menu.className).toContain("w-max");
    expect(menu.className).toContain("14rem");
    expect(
      within(menu).getByRole("button", { name: "Manage script" }),
    ).not.toBeNull();
    expect(within(menu).getByTestId("worktree-row-copy-path")).not.toBeNull();
    const deleteButton = within(menu).getByRole("button", {
      name: "Delete worktree feat-clean",
    });
    expect(deleteButton.getAttribute("data-variant")).toBe("destructive");
  });

  it("copies the worktree path through the overflow menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      renderDefault();

      const row = screen
        .getByText("feat-clean")
        .closest('[data-testid="worktree-row"]');
      if (row === null) throw new Error("expected feat-clean row");
      const menu = within(row as HTMLElement).getByTestId(
        "worktree-row-actions-menu",
      );
      const copyButton = within(menu).getByTestId("worktree-row-copy-path");

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith("/wt/clean");
      expect(toastMock.messages).toContain("Copied worktree path");
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("shows an error toast when the clipboard copy fails", () => {
    // jsdom has no navigator.clipboard by default, so the copy attempt
    // synchronously fails - this is the everyday jsdom/test-env path.
    renderDefault();

    const row = screen
      .getByText("feat-clean")
      .closest('[data-testid="worktree-row"]');
    if (row === null) throw new Error("expected feat-clean row");
    const menu = within(row as HTMLElement).getByTestId(
      "worktree-row-actions-menu",
    );
    const copyButton = within(menu).getByTestId("worktree-row-copy-path");

    fireEvent.click(copyButton);

    expect(toastMock.messages).toContain("Couldn't copy path to clipboard.");
    expect(toastMock.messages).not.toContain("Copied worktree path");
  });

  it("saves reviewed scripts before a later delete starts", async () => {
    vi.useFakeTimers();
    renderDefault();

    const row = screen
      .getByText("feat-clean")
      .closest('[data-testid="worktree-row"]');
    if (row === null) throw new Error("expected feat-clean row");
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", {
        name: "Manage script",
      }),
    );

    const dialog = screen.getByTestId("worktree-script-review-dialog");
    within(dialog).getByText("Manage setup and teardown scripts");
    within(dialog).getByText("Worktree path");
    within(dialog).getByText("/wt/clean");
    expect(
      within(dialog).getAllByRole("button", { name: "Close" }),
    ).toHaveLength(2);
    expect(
      within(dialog).queryByRole("button", { name: /delete/i }),
    ).toBeNull();
    screen.getByDisplayValue("bun install");
    const saveButton = within(dialog).getByRole("button", { name: "Save" });
    expect(saveButton.getAttribute("disabled")).not.toBeNull();

    const teardown = screen.getByLabelText("Teardown script (Default)");
    fireEvent.change(teardown, {
      target: { value: "bun run cleanup:reviewed" },
    });
    expect(saveButton.getAttribute("disabled")).toBeNull();
    fireEvent.click(saveButton);

    expect(saveButton.getAttribute("disabled")).not.toBeNull();
    expect(
      screen.getByTestId("worktree-script-review-dialog-save-spinner"),
    ).not.toBeNull();
    expect(streamMock.paths).toEqual([]);

    // The save now resolves on a microtask (not a fixed timer), then shows "Saved".
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      within(dialog)
        .getByRole("button", { name: "Saved" })
        .getAttribute("disabled"),
    ).not.toBeNull();

    // The close timer (kept) then auto-closes the dialog.
    act(() => {
      vi.advanceTimersByTime(650);
    });
    expect(screen.queryByTestId("worktree-script-review-dialog")).toBeNull();

    confirmDelete("feat-clean");

    expect(streamMock.paths).toEqual(["/wt/clean"]);
    expect(streamMock.scriptsByPath.get("/wt/clean")).toEqual({
      setup: {
        default: "bun install",
        macos: null,
        windows: null,
        linux: null,
      },
      teardown: {
        default: "bun run cleanup:reviewed",
        macos: null,
        windows: null,
        linux: null,
      },
    });
  });

  it("selects visible deletable worktrees and starts bulk deletes in the background", () => {
    renderDefault();

    // No selection yet -> no action bar. The in-use row's checkbox is disabled.
    expect(screen.queryByTestId("worktrees-selection-action-bar")).toBeNull();
    expect(
      screen
        .getByRole("checkbox", { name: "Select worktree feat-busy" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select worktree feat-clean" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select worktree feat-dirty" }),
    );

    expect(screen.getByText("2 selected")).not.toBeNull();
    expect(
      screen
        .getByRole("checkbox", { name: "Select worktree feat-clean" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: "Select worktree feat-dirty" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));

    // Aggregate-by-class confirmation names the dirty loss and the neutral
    // unverified caveat instead of a single stacked warning.
    screen.getByText("Delete 2 worktrees?");
    screen.getByTestId("worktree-bulk-delete-dirty-loss");
    screen.getByText("1 not selected: 1 in use");
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(streamMock.paths).toEqual(["/wt/clean", "/wt/dirty"]);
    screen.getByText("Deleting worktrees");
    screen.getByText("0/2 deleted");
    expect(screen.queryByTestId("worktree-delete-progress-modal")).toBeNull();
    expect(screen.getAllByTestId("worktree-row-deleting-spinner")).toHaveLength(
      2,
    );
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-clean" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-dirty" }),
    ).toBeNull();
  });

  it("queues bulk deletes across repo groups while every selected row shows progress", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const multiRepoWorktrees = [
      ...WORKTREES,
      entry({
        repoLabel: "acme/api",
        repoIdentifier: { owner: "acme", repo: "api" },
        worktreePath: "/wt/api-clean",
        branch: "feat-api-clean",
      }),
    ];
    renderList({
      hostId: "host-a",
      queryClient,
      worktrees: multiRepoWorktrees,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    selectRows(["feat-clean", "feat-dirty", "feat-api-clean"]);
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(streamMock.paths).toEqual(["/wt/clean", "/wt/dirty"]);
    screen.getByText("0/3 deleted");
    expect(screen.getAllByTestId("worktree-row-deleting-spinner")).toHaveLength(
      3,
    );
    expect(screen.queryByText("Queued…")).toBeNull();
    expect(screen.getAllByText("Deleting…")).toHaveLength(3);
    expect(
      screen.queryByRole("button", {
        name: "Delete worktree feat-api-clean",
      }),
    ).toBeNull();

    act(() => {
      callbacksFor("/wt/clean").onComplete(true);
    });

    screen.getByText("1/3 deleted");
    expect(streamMock.paths).toEqual([
      "/wt/clean",
      "/wt/dirty",
      "/wt/api-clean",
    ]);
    expect(screen.getAllByTestId("worktree-row-deleting-spinner")).toHaveLength(
      3,
    );
    expect(invalidateSpy).not.toHaveBeenCalled();

    act(() => {
      callbacksFor("/wt/dirty").onComplete(true);
    });
    screen.getByText("2/3 deleted");
    expect(screen.getAllByTestId("worktree-row-deleting-spinner")).toHaveLength(
      3,
    );
    expect(invalidateSpy).not.toHaveBeenCalled();

    act(() => {
      callbacksFor("/wt/api-clean").onComplete(true);
    });
    screen.getByText("3/3 deleted");
    expect(invalidateSpy).toHaveBeenCalledTimes(
      WORKTREE_BINDING_INVALIDATIONS.length + 2,
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-a", "worktree.listAllForHost"),
      refetchType: "active",
    });
  });

  it("continues queued bulk deletes when a queued stream fails to start", () => {
    const multiRepoWorktrees = [
      ...WORKTREES,
      entry({
        repoLabel: "acme/api",
        repoIdentifier: { owner: "acme", repo: "api" },
        worktreePath: "/wt/api-clean",
        branch: "feat-api-clean",
      }),
      entry({
        repoLabel: "acme/web",
        repoIdentifier: { owner: "acme", repo: "web" },
        worktreePath: "/wt/web-clean",
        branch: "feat-web-clean",
      }),
    ];
    streamMock.throwForPaths.add("/wt/api-clean");
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: multiRepoWorktrees,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    selectRows([
      "feat-clean",
      "feat-dirty",
      "feat-api-clean",
      "feat-web-clean",
    ]);
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(streamMock.paths).toEqual(["/wt/clean", "/wt/dirty"]);

    act(() => {
      callbacksFor("/wt/clean").onComplete(true);
    });

    expect(streamMock.paths).toEqual([
      "/wt/clean",
      "/wt/dirty",
      "/wt/api-clean",
      "/wt/web-clean",
    ]);
    expect(callbacksFor("/wt/web-clean")).toBeDefined();
    // A batch item failing to start is surfaced non-modally in the progress
    // strip (1 deleted, 1 failed, 2 still running) - it must not pop a modal
    // over the siblings that are still deleting.
    expect(screen.queryByTestId("worktree-delete-progress-modal")).toBeNull();
    screen.getByText("1/4 deleted, 1 failed");
  });

  it("shows a plain confirm for a clean worktree", () => {
    renderDefault();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete worktree feat-clean" }),
    );
    // getByText throws if absent, so finding it asserts presence.
    screen.getByText("Delete worktree?");
    expect(screen.getByTestId("confirm-action").textContent).toContain(
      "Delete worktree",
    );
  });

  it("requires an extra discard confirm naming the change count when dirty", () => {
    renderDefault();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete worktree feat-dirty" }),
    );
    screen.getByText("Discard 3 uncommitted changes?");
    expect(screen.getByTestId("confirm-action").textContent).toContain(
      "Delete and discard",
    );
    screen.getByText(/3 uncommitted changes that will be permanently lost/i);
  });

  it("opens the progress modal and drives the delete stream on confirm", () => {
    renderDefault();
    confirmDelete("feat-clean");
    // The confirm started the stream for the chosen worktree.
    expect(streamMock.paths).toEqual(["/wt/clean"]);
    screen.getByTestId("worktree-delete-progress-modal");

    act(() => {
      streamMock.callbacks?.onStarted(true);
      streamMock.callbacks?.onPhase("teardown");
      streamMock.callbacks?.onOutput("stdout", "tearing down\n");
      streamMock.callbacks?.onPhase("remove");
      streamMock.callbacks?.onComplete(true);
    });
    // Success copy on a clean removal.
    screen.getByText("Worktree deleted");
    expect(streamMock.closeCount).toBe(1);
  });

  it("shows only the scoped modal (not the row) while a delete runs in the foreground", () => {
    renderDefault();
    confirmDelete("feat-clean");
    act(() => {
      streamMock.callbacks?.onStarted(true);
      streamMock.callbacks?.onPhase("teardown");
    });
    // Foreground: the scoped modal alone carries progress. The row must NOT
    // also show the deleting treatment - that duplication is what we removed.
    screen.getByTestId("worktree-delete-progress-modal");
    expect(screen.queryByTestId("worktree-row-deleting-spinner")).toBeNull();
    screen.getByRole("button", { name: "Delete worktree feat-clean" });
  });

  it("shows an error in the modal when the host reports deleted: false", () => {
    renderDefault();
    confirmDelete("feat-clean");
    act(() => {
      streamMock.callbacks?.onStarted(false);
      streamMock.callbacks?.onComplete(false);
    });
    expect(screen.getByTestId("worktree-delete-error").textContent).toContain(
      "Couldn't remove the worktree",
    );
  });

  it("shows the failure reason in the modal on a failed frame", () => {
    renderDefault();
    confirmDelete("feat-clean");
    act(() => {
      streamMock.callbacks?.onFailed(
        "Worktree /wt/clean is in use by an active chat session",
      );
    });
    expect(screen.getByTestId("worktree-delete-error").textContent).toContain(
      "in use by an active chat session",
    );
    expect(streamMock.closeCount).toBe(1);
  });

  it("invalidates the host captured at delete start, even after a host swap mid-flight", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderList({
      hostId: "host-a",
      queryClient,
      worktrees: WORKTREES,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    confirmDelete("feat-clean");

    // The selector swaps to host-b while the host-a delete is still in
    // flight; the list re-renders with the new host id.
    rendered.rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WorktreesList
            openStreamTransport={() => stubOpenStreamTransport()}
            hostId="host-b"
            worktrees={WORKTREES}
            enrichedByPath={fullyEnriched(WORKTREES)}
            erroredPaths={new Set()}
            seededPaths={new Set()}
            onVisiblePathsChange={vi.fn()}
            taskTitlesByEpicId={new Map()}
            toolbarProps={testToolbarProps()}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    act(() => {
      streamMock.callbacks?.onComplete(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-a", "worktree.listAllForHost"),
      refetchType: "active",
    });
    for (const method of WORKTREE_BINDING_INVALIDATIONS) {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: hostQueryKeys.methodScope("host-a", method),
        refetchType: "all",
      });
    }
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-b", "worktree.listAllForHost"),
      refetchType: "active",
    });
  });

  it("backgrounds a running delete: hides the panel and marks the row as deleting", () => {
    renderDefault();
    confirmDelete("feat-clean");
    act(() => {
      streamMock.callbacks?.onStarted(true);
      streamMock.callbacks?.onPhase("teardown");
    });

    // While running, the action backgrounds the delete.
    fireEvent.click(screen.getByTestId("worktree-delete-close-button"));

    // The panel is gone but the delete keeps running (the stream stays open).
    expect(screen.queryByTestId("worktree-delete-progress-modal")).toBeNull();
    expect(streamMock.closeCount).toBe(0);
    // The worktree's row carries the in-progress treatment and is no longer
    // selectable for deletion.
    expect(screen.getByTestId("worktree-row-deleting-spinner")).not.toBeNull();
    screen.getByText("Deleting…");
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-clean" }),
    ).toBeNull();
  });

  it("remembers a backgrounded delete after the list unmounts and remounts", () => {
    const rendered = renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: WORKTREES,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });
    confirmDelete("feat-clean");
    act(() => {
      streamMock.callbacks?.onStarted(true);
      streamMock.callbacks?.onPhase("teardown");
    });
    fireEvent.click(screen.getByTestId("worktree-delete-close-button"));

    rendered.unmount();
    expect(streamMock.closeCount).toBe(0);

    renderDefault();

    expect(screen.getByTestId("worktree-row-deleting-spinner")).not.toBeNull();
    screen.getByText("Deleting…");
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-clean" }),
    ).toBeNull();
  });

  it("backgrounds a foreground delete when the list unmounts", () => {
    const rendered = renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: WORKTREES,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });
    confirmDelete("feat-clean");
    act(() => {
      callbacksFor("/wt/clean").onStarted(true);
      callbacksFor("/wt/clean").onPhase("teardown");
    });

    rendered.unmount();
    expect(streamMock.closeCount).toBe(0);

    renderDefault();

    expect(screen.queryByTestId("worktree-delete-progress-modal")).toBeNull();
    screen.getByText("0/1 deleted");
    expect(screen.getByTestId("worktree-row-deleting-spinner")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-clean" }),
    ).toBeNull();
  });

  it("keeps every backgrounded delete row locked when another delete starts", () => {
    renderDefault();
    confirmDelete("feat-clean");
    act(() => {
      callbacksFor("/wt/clean").onStarted(true);
      callbacksFor("/wt/clean").onPhase("teardown");
    });
    fireEvent.click(screen.getByTestId("worktree-delete-close-button"));

    confirmDelete("feat-dirty");

    expect(streamMock.paths).toEqual(["/wt/clean", "/wt/dirty"]);
    expect(screen.getByTestId("worktree-row-deleting-spinner")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-clean" }),
    ).toBeNull();
    screen.getByTestId("worktree-delete-progress-modal");

    act(() => {
      callbacksFor("/wt/dirty").onStarted(false);
    });
    fireEvent.click(screen.getByTestId("worktree-delete-close-button"));

    expect(screen.queryByTestId("worktree-delete-progress-modal")).toBeNull();
    expect(screen.getAllByTestId("worktree-row-deleting-spinner")).toHaveLength(
      2,
    );
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-dirty" }),
    ).toBeNull();

    act(() => {
      callbacksFor("/wt/clean").onComplete(true);
    });

    expect(screen.getAllByTestId("worktree-row-deleting-spinner")).toHaveLength(
      2,
    );
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-clean" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-dirty" }),
    ).toBeNull();
  });

  it("keeps a completed background delete locked until the refreshed list drops it", () => {
    const queryClient = new QueryClient();
    const rendered = renderList({
      hostId: "host-a",
      queryClient,
      worktrees: WORKTREES,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });
    confirmDelete("feat-clean");
    act(() => {
      streamMock.callbacks?.onStarted(false);
    });
    fireEvent.click(screen.getByTestId("worktree-delete-close-button"));

    act(() => {
      streamMock.callbacks?.onComplete(true);
    });

    // The stale row is still in the list, so keep it locked as deleting instead
    // of briefly restoring the normal delete affordance.
    expect(screen.queryByTestId("worktree-delete-progress-modal")).toBeNull();
    expect(screen.getByTestId("worktree-row-deleting-spinner")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-clean" }),
    ).toBeNull();
    expect(streamMock.closeCount).toBe(1);

    rendered.rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WorktreesList
            openStreamTransport={() => stubOpenStreamTransport()}
            hostId="host-a"
            worktrees={WORKTREES.filter(
              (worktree) => worktree.worktreePath !== "/wt/clean",
            )}
            enrichedByPath={fullyEnriched(
              WORKTREES.filter(
                (worktree) => worktree.worktreePath !== "/wt/clean",
              ),
            )}
            erroredPaths={new Set()}
            seededPaths={new Set()}
            onVisiblePathsChange={vi.fn()}
            taskTitlesByEpicId={new Map()}
            toolbarProps={testToolbarProps()}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    expect(screen.queryByText("feat-clean")).toBeNull();
    expect(screen.queryByTestId("worktree-row-deleting-spinner")).toBeNull();
  });

  it("re-surfaces the panel with the error when a backgrounded delete fails", () => {
    renderDefault();
    confirmDelete("feat-clean");
    act(() => {
      streamMock.callbacks?.onStarted(false);
    });
    fireEvent.click(screen.getByTestId("worktree-delete-close-button"));
    expect(screen.queryByTestId("worktree-delete-progress-modal")).toBeNull();

    act(() => {
      streamMock.callbacks?.onFailed("Worktree /wt/clean is busy");
    });

    // The failure brings the panel back so the error is visible.
    screen.getByTestId("worktree-delete-progress-modal");
    expect(screen.getByTestId("worktree-delete-error").textContent).toContain(
      "is busy",
    );
  });

  it("closes a completed foreground delete instead of backgrounding it", () => {
    renderDefault();
    confirmDelete("feat-clean");
    act(() => {
      streamMock.callbacks?.onStarted(true);
      streamMock.callbacks?.onComplete(true);
    });
    // Terminal success: the modal now offers an explicit Close.
    screen.getByText("Worktree deleted");

    fireEvent.click(screen.getByTestId("worktree-delete-close-button"));

    // Close fully dismisses the finished delete - it must NOT background it
    // (which would leave a deleting row and fire a spurious progress strip).
    expect(screen.queryByTestId("worktree-delete-progress-modal")).toBeNull();
    expect(screen.queryByTestId("worktree-row-deleting-spinner")).toBeNull();
    expect(screen.queryByText("1/1 deleted")).toBeNull();
    screen.getByRole("button", { name: "Delete worktree feat-clean" });
  });

  it("surfaces a batch failure in the strip without a modal, and Dismiss clears it", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: WORKTREES,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    selectRows(["feat-clean", "feat-dirty"]);
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    // Two selectable worktrees go to the background (the in-use one cannot be
    // selected); one succeeds and one fails.
    expect(streamMock.paths).toEqual(["/wt/clean", "/wt/dirty"]);
    act(() => {
      callbacksFor("/wt/clean").onComplete(true);
      callbacksFor("/wt/dirty").onFailed("Worktree /wt/dirty is busy");
    });

    // A batch failure must not pop a modal; it shows in the strip with a count.
    expect(screen.queryByTestId("worktree-delete-progress-modal")).toBeNull();
    screen.getByText("Some worktrees couldn't be deleted");
    screen.getByText("1/2 deleted, 1 failed");

    // The settled-with-failures strip offers an explicit Dismiss that clears it.
    fireEvent.click(screen.getByTestId("worktree-delete-progress-dismiss"));
    expect(screen.queryByText("1/2 deleted, 1 failed")).toBeNull();
    expect(screen.queryByTestId("worktree-delete-progress-dismiss")).toBeNull();
  });
});

describe("WorktreesList confirm-time re-check", () => {
  afterEach(() => {
    cleanup();
    __resetWorktreeDeleteRunForTests();
    streamMock.paths = [];
    streamMock.callbacksByPath.clear();
    toastMock.messages = [];
  });

  function merged(path: string, branch: string): WorktreeHostEntryV14 {
    return entry({
      worktreePath: path,
      branch,
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
  }

  function renderWith(
    queryClient: QueryClient,
    worktrees: readonly WorktreeHostEntryV14[],
  ) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WorktreesList
            openStreamTransport={() => stubOpenStreamTransport()}
            hostId="host-a"
            worktrees={worktrees}
            enrichedByPath={fullyEnriched(worktrees)}
            erroredPaths={new Set()}
            seededPaths={new Set()}
            onVisiblePathsChange={vi.fn()}
            taskTitlesByEpicId={new Map()}
            toolbarProps={testToolbarProps()}
          />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  it("drops a swept row that became dirty in the freshest snapshot, updates the dialog, and names the drop", () => {
    const queryClient = new QueryClient();
    const clean = [
      merged("/wt/a", "feat-a"),
      merged("/wt/b", "feat-b"),
      merged("/wt/c", "feat-c"),
    ];
    const rendered = render(renderWith(queryClient, clean));

    // Global select-all picks all three (all selectable) rows.
    fireEvent.click(screen.getByTestId("worktrees-select-all"));
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    screen.getByText("Delete 3 worktrees?");

    // A background refresh makes /wt/c busy (and dirty) while the dialog is open,
    // so it is no longer selectable and drops out of the confirm.
    rendered.rerender(
      renderWith(queryClient, [
        merged("/wt/a", "feat-a"),
        merged("/wt/b", "feat-b"),
        entry({
          worktreePath: "/wt/c",
          branch: "feat-c",
          inUse: true,
          uncommittedCount: 2,
        }),
      ]),
    );

    // The dialog copy re-resolves to the freshest snapshot: only 2 remain.
    screen.getByText("Delete 2 worktrees?");

    fireEvent.click(screen.getByTestId("confirm-action"));

    // The now-ineligible row is excluded from the started delete and named by the
    // lock reason instead of by its underlying git facts.
    expect(streamMock.paths).toEqual(["/wt/a", "/wt/b"]);
    expect(toastMock.messages.join("\n")).toContain("1 in use");
  });

  it("filter → Landed then select-all picks only the Landed rows (fast path)", () => {
    render(
      renderWith(new QueryClient(), [
        merged("/wt/merged", "feat-merged"),
        entry({
          worktreePath: "/wt/unref",
          branch: "feat-unref",
          branchStatus: null,
        }),
      ]),
    );

    // Both rows visible initially; select-all would take both.
    screen.getByRole("button", { name: "Delete worktree feat-unref" });
    // Narrow to the Landed tier via the standard status filter.
    fireEvent.click(screen.getByTestId("worktrees-filter-merged"));
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-unref" }),
    ).toBeNull();

    // Standard select-all now acts only on the visible (Landed) row.
    fireEvent.click(screen.getByTestId("worktrees-select-all"));
    expect(screen.getByText("1 selected")).not.toBeNull();
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(streamMock.paths).toEqual(["/wt/merged"]);
  });

  function atBase(path: string, branch: string): WorktreeHostEntryV14 {
    return entry({ worktreePath: path, branch, atBaseCommit: true });
  }

  it("status filter is multi-select: Landed + At base commit shows their union", () => {
    render(
      renderWith(new QueryClient(), [
        merged("/wt/merged", "feat-merged"),
        atBase("/wt/base", "feat-base"),
        entry({
          worktreePath: "/wt/review",
          branch: "feat-review",
          branchStatus: { ahead: 2, behind: 0, mergedIntoDefault: false },
        }),
      ]),
    );

    // All three visible initially.
    screen.getByRole("button", { name: "Delete worktree feat-review" });

    // Select two tiers together - the menu stays open across toggles.
    fireEvent.click(screen.getByTestId("worktrees-filter-trigger"));
    fireEvent.click(screen.getByTestId("worktrees-filter-merged"));
    fireEvent.click(screen.getByTestId("worktrees-filter-at-base-commit"));

    // Union of Landed + At base commit: the review row is filtered out, the two
    // green rows remain.
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-review" }),
    ).toBeNull();
    screen.getByRole("button", { name: "Delete worktree feat-merged" });
    screen.getByRole("button", { name: "Delete worktree feat-base" });

    // "All" clears every tier selection and restores the full list.
    fireEvent.click(screen.getByTestId("worktrees-filter-all"));
    screen.getByRole("button", { name: "Delete worktree feat-review" });
  });

  it("toggling a tier off restores it (multi-select membership)", () => {
    render(
      renderWith(new QueryClient(), [
        merged("/wt/merged", "feat-merged"),
        entry({
          worktreePath: "/wt/review",
          branch: "feat-review",
          branchStatus: null,
        }),
      ]),
    );

    fireEvent.click(screen.getByTestId("worktrees-filter-trigger"));
    // On: only merged rows.
    fireEvent.click(screen.getByTestId("worktrees-filter-merged"));
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-review" }),
    ).toBeNull();
    // Off again: empty set means no filter, both rows return.
    fireEvent.click(screen.getByTestId("worktrees-filter-merged"));
    screen.getByRole("button", { name: "Delete worktree feat-review" });
  });

  it("a stale tier filter whose tier vanishes shows all rows (no empty dead-end under 'All')", () => {
    const queryClient = new QueryClient();
    const reviewRow = entry({
      worktreePath: "/wt/review",
      branch: "feat-review",
      branchStatus: { ahead: 2, behind: 0, mergedIntoDefault: false },
    });
    const rendered = render(
      renderWith(queryClient, [merged("/wt/merged", "feat-merged"), reviewRow]),
    );

    // Filter to Landed only - the review row hides and the toolbar reads Landed.
    fireEvent.click(screen.getByTestId("worktrees-filter-trigger"));
    fireEvent.click(screen.getByTestId("worktrees-filter-merged"));
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-review" }),
    ).toBeNull();
    screen.getByRole("button", { name: "Filter: Landed" });

    // The last Landed row is deleted out from under the filter (only review left).
    rendered.rerender(renderWith(queryClient, [reviewRow]));

    // The stale "Landed" selection is no longer available, so the effective
    // filter is empty and every row shows - matching the "All" the toolbar now
    // reads. The list must NOT dead-end to the empty state.
    screen.getByRole("button", { name: "Delete worktree feat-review" });
    expect(screen.queryByText("No worktrees match your search.")).toBeNull();
    screen.getByRole("button", { name: "Filter: All" });
  });

  it("bulk-delete copy buckets an orphaned+dirty row as orphaned, matching its pill (shared classifier)", () => {
    render(
      renderWith(new QueryClient(), [
        merged("/wt/merged", "feat-merged"),
        entry({
          worktreePath: "/wt/orphan",
          branch: "feat-orphan",
          // !gitRemovable outranks dirty in the classifier, so the pill is
          // Orphaned; the bulk copy must agree (not bucket it as "dirty").
          gitRemovable: false,
          uncommittedCount: 3,
        }),
      ]),
    );

    // Pill agrees: the orphan row carries the orphaned tier.
    const pills = screen.getAllByTestId("worktree-tier-pill");
    const tiers = pills.map((pill) => pill.getAttribute("data-tier"));
    expect(tiers).toContain("orphaned");

    // Select both and open the bulk-delete dialog.
    fireEvent.click(screen.getByTestId("worktrees-select-all"));
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));

    // The class summary buckets the row as orphaned (its tier), NOT dirty - the
    // dirty LOSS is still named separately in its own caveat line.
    screen.getByText(/1 merged, 1 orphaned/);
    screen.getByTestId("worktree-bulk-delete-dirty-loss");
  });

  it("only offers filter options for tiers present in the list", () => {
    render(
      renderWith(new QueryClient(), [
        merged("/wt/merged", "feat-merged"),
        entry({
          worktreePath: "/wt/review",
          branch: "feat-review",
          branchStatus: null,
        }),
      ]),
    );
    // Present tiers get options.
    screen.getByTestId("worktrees-filter-all");
    screen.getByTestId("worktrees-filter-merged");
    screen.getByTestId("worktrees-filter-review");
    // Absent tiers do not.
    expect(screen.queryByTestId("worktrees-filter-orphaned")).toBeNull();
    expect(screen.queryByTestId("worktrees-filter-in-use")).toBeNull();
  });

  it("header select-all is tri-state and covers only visible selectable rows (excludes in-use)", () => {
    render(
      renderWith(new QueryClient(), [
        merged("/wt/a", "feat-a"),
        merged("/wt/b", "feat-b"),
        entry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
          branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
        }),
      ]),
    );

    const selectAll = screen.getByTestId("worktrees-select-all");
    expect(selectAll.getAttribute("aria-checked")).toBe("false");

    // One of two selectable rows -> indeterminate.
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select worktree feat-a" }),
    );
    expect(selectAll.getAttribute("aria-checked")).toBe("mixed");

    // Header selects all visible SELECTABLE rows; the in-use row is excluded.
    fireEvent.click(selectAll);
    expect(screen.getByText("2 selected")).not.toBeNull();
    expect(selectAll.getAttribute("aria-checked")).toBe("true");
    const busy = screen.getByRole("checkbox", {
      name: "Select worktree feat-busy",
    });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-checked")).toBe("false");

    // Header again clears the selection (action bar disappears).
    fireEvent.click(selectAll);
    expect(screen.queryByTestId("worktrees-selection-action-bar")).toBeNull();
    expect(selectAll.getAttribute("aria-checked")).toBe("false");
  });

  it("prunes a dropped row from the selection bookkeeping after confirm", () => {
    const queryClient = new QueryClient();
    const rendered = render(
      renderWith(queryClient, [
        merged("/wt/a", "feat-a"),
        merged("/wt/b", "feat-b"),
        merged("/wt/c", "feat-c"),
      ]),
    );

    fireEvent.click(screen.getByTestId("worktrees-select-all"));
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    screen.getByText("Delete 3 worktrees?");

    // /wt/c becomes in-use, so it is dropped at confirm while /wt/a and /wt/b run.
    rendered.rerender(
      renderWith(queryClient, [
        merged("/wt/a", "feat-a"),
        merged("/wt/b", "feat-b"),
        entry({
          worktreePath: "/wt/c",
          branch: "feat-c",
          inUse: true,
          branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
        }),
      ]),
    );
    screen.getByText("Delete 2 worktrees?");
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(streamMock.paths).toEqual(["/wt/a", "/wt/b"]);

    // On a later refresh /wt/c is selectable again. If the dropped path had
    // lingered in the selection it would show selected; the prune keeps it
    // unselected, so it reads as a fresh pick.
    rendered.rerender(renderWith(queryClient, [merged("/wt/c", "feat-c")]));
    const cCheckbox = screen.getByRole("checkbox", {
      name: "Select worktree feat-c",
    });
    expect(cCheckbox.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(cCheckbox);
    screen.getByText("1 selected");
  });

  it("names local-only commits in the per-row confirm for a clean, ahead worktree", () => {
    render(
      renderWith(new QueryClient(), [
        entry({
          worktreePath: "/wt/ahead",
          branch: "feat-ahead",
          branchStatus: { ahead: 2, behind: 0, mergedIntoDefault: false },
        }),
      ]),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete worktree feat-ahead" }),
    );
    screen.getByText("Delete worktree with 2 unpushed commits?");
    screen.getByText(/2 commits not on the default branch/i);
  });

  it("skips the unpushed-commits warning when the branch's PR is proven merged, even if local ancestry can't see it (squash merge)", () => {
    render(
      renderWith(new QueryClient(), [
        entry({
          worktreePath: "/wt/squash-merged",
          branch: "feat-squash-merged",
          // A squash merge creates a new default-branch commit that isn't a
          // literal ancestor of these commits, so mergedIntoDefault stays
          // false and ahead stays >0 — but the GitHub-proven merge fact
          // (prState/mergedHeadShaMatches) means the work already landed.
          branchStatus: { ahead: 2, behind: 0, mergedIntoDefault: false },
          prState: "merged",
          mergedHeadShaMatches: true,
        }),
      ]),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete worktree feat-squash-merged",
      }),
    );
    screen.getByText("Delete worktree?");
    expect(
      screen.queryByText("Delete worktree with 2 unpushed commits?"),
    ).toBeNull();
  });

  it("warns about never-pushed local-only commits in the per-row confirm", () => {
    render(
      renderWith(new QueryClient(), [
        entry({
          worktreePath: "/wt/never-pushed",
          branch: "feat-never-pushed",
          // No upstream (ahead null) and not contained in the default branch:
          // honest per-row warning rather than the generic "Delete worktree?".
          branchStatus: { ahead: null, behind: null, mergedIntoDefault: false },
        }),
      ]),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete worktree feat-never-pushed",
      }),
    );
    screen.getByText("Delete worktree with unpushed local commits?");
    screen.getByText(/local-only commits not on the default branch/i);
  });
});

describe("WorktreesList v1.2 signals", () => {
  afterEach(() => {
    cleanup();
    __resetWorktreeDeleteRunForTests();
    routerMock.navigate.mockClear();
    tabNavigationMock.navigateToTabIntent.mockClear();
    tabNavigationMock.openOrFocusEpicIntent.mockClear();
  });

  it("renders a Task chip per owning epic, resolving titles from the cache", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/owned",
          branch: "feat-owned",
          owners: [
            {
              epicId: "epic-1",
              ownerKind: "chat",
              ownerId: "chat-1",
              updatedAt: 10,
            },
            {
              epicId: "epic-1",
              ownerKind: "terminal-agent",
              ownerId: "agent-1",
              updatedAt: 20,
            },
            {
              epicId: "epic-2",
              ownerKind: "chat",
              ownerId: "chat-2",
              updatedAt: 30,
            },
          ],
        }),
      ],
      taskTitlesByEpicId: new Map([["epic-1", "Ship the audit"]]),
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });

    // The resolved epic-1 renders a button chip (the duplicate epic-1 owner collapses).
    screen.getByRole("button", { name: "Open Task Ship the audit" });
    // epic-2 has no cached title -> demoted muted "Owner unresolved" text, not a
    // prominent chip.
    screen.getByText("Owner unresolved");
  });

  it("opens the owning Task epic when a resolved Task chip is clicked", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/owned",
          branch: "feat-owned",
          owners: [
            {
              epicId: "epic-1",
              ownerKind: "chat",
              ownerId: "chat-1",
              updatedAt: 10,
            },
          ],
        }),
      ],
      taskTitlesByEpicId: new Map([["epic-1", "Ship the audit"]]),
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Open Task Ship the audit" }),
    );

    expect(tabNavigationMock.openOrFocusEpicIntent).toHaveBeenCalledTimes(1);
    expect(tabNavigationMock.openOrFocusEpicIntent).toHaveBeenCalledWith({
      epicId: "epic-1",
      focus: undefined,
    });
    expect(tabNavigationMock.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(tabNavigationMock.navigateToTabIntent).toHaveBeenCalledWith(
      routerMock.navigate,
      {
        kind: "epic",
        epicId: "epic-1",
        tabId: "tab-epic-1",
        focus: undefined,
      },
    );
  });

  it("keeps unresolved owners non-interactive", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/owned",
          branch: "feat-owned",
          owners: [
            {
              epicId: "epic-unknown",
              ownerKind: "chat",
              ownerId: "chat-1",
              updatedAt: 10,
            },
          ],
        }),
      ],
      taskTitlesByEpicId: new Map(),
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });

    screen.getByText("Owner unresolved");
    expect(screen.queryByRole("button", { name: /Open Task/i })).toBeNull();
  });

  it("renders linked PR chips for the superproject and every displayable submodule PR", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/prs",
          branch: "feat-prs",
          prState: "merged",
          prNumber: 10,
          prUrl: "https://github.com/acme/app/pull/10",
          mergedHeadShaMatches: true,
          submodules: [
            {
              repoIdentifier: { owner: "acme", repo: "open-sub" },
              branch: "feat-prs",
              prState: "open",
              prNumber: 11,
              prUrl: "https://github.com/acme/open-sub/pull/11",
              mergedHeadShaMatches: false,
              mergedIntoDefault: false,
              atPinnedCommit: false,
            },
            {
              repoIdentifier: { owner: "acme", repo: "closed-sub" },
              branch: "feat-prs",
              prState: "closed",
              prNumber: 12,
              prUrl: "https://github.com/acme/closed-sub/pull/12",
              mergedHeadShaMatches: false,
              mergedIntoDefault: false,
              atPinnedCommit: false,
            },
            {
              repoIdentifier: { owner: "acme", repo: "merged-sub" },
              branch: "feat-prs",
              prState: "merged",
              prNumber: 13,
              prUrl: "https://github.com/acme/merged-sub/pull/13",
              mergedHeadShaMatches: true,
              mergedIntoDefault: true,
              atPinnedCommit: false,
            },
            {
              repoIdentifier: { owner: "acme", repo: "none-sub" },
              branch: "feat-prs",
              prState: "none",
              prNumber: 14,
              prUrl: "https://github.com/acme/none-sub/pull/14",
              mergedHeadShaMatches: false,
              mergedIntoDefault: false,
              atPinnedCommit: false,
            },
            {
              repoIdentifier: { owner: "acme", repo: "cold-sub" },
              branch: "feat-prs",
              prState: null,
              prNumber: 15,
              prUrl: "https://github.com/acme/cold-sub/pull/15",
              mergedHeadShaMatches: false,
              mergedIntoDefault: false,
              atPinnedCommit: false,
            },
          ],
        }),
      ],
      taskTitlesByEpicId: undefined,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });

    const prChips = screen.getAllByTestId("worktree-pr-chip");
    expect(prChips.map((chip) => chip.getAttribute("data-pr-state"))).toEqual([
      "merged",
      "open",
      "closed",
      "merged",
      "unmerged",
    ]);
    expect(prChips[0]?.className).toContain("text-purple-700");
    expect(prChips[1]?.className).toContain("text-green-700");
    expect(prChips[2]?.className).toContain("text-red-700");
    expect(prChips[4]?.className).toContain("text-muted-foreground");
    expect(
      screen
        .getByRole("link", { name: "Open PR #10 Merged" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/app/pull/10");
    expect(
      screen
        .getByRole("link", { name: "Open open-sub PR #11 Open" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/open-sub/pull/11");
    expect(
      screen
        .getByRole("link", { name: "Open closed-sub PR #12 Closed" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/closed-sub/pull/12");
    expect(
      screen
        .getByRole("link", { name: "Open merged-sub PR #13 Merged" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/merged-sub/pull/13");
    expect(
      screen.queryByRole("link", { name: "Open none-sub PR #14" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Open cold-sub PR #15" }),
    ).toBeNull();
    screen.getByText("none-sub · unmerged commits");
  });

  it("explains unmerged submodule commits with a count and newest subjects", async () => {
    const submodule: WorktreeSubmoduleMergeFactV12 = {
      repoIdentifier: { owner: "acme", repo: "traycer" },
      branch: "traycer/feature",
      prState: "none",
      prNumber: null,
      prUrl: null,
      mergedHeadShaMatches: false,
      mergedIntoDefault: false,
      atPinnedCommit: false,
      unmergedCommitCount: 7,
      unmergedCommitSubjects: [
        "Newest change",
        "Fourth change",
        "Third change",
        "Second change",
        "First change",
      ],
    };
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/unmerged",
          branch: "feat-unmerged",
          submodules: [submodule],
        }),
      ],
      taskTitlesByEpicId: undefined,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });

    const chip = screen.getByTestId("worktree-pr-chip");
    screen.getByText("traycer · 7 unmerged commits");
    fireEvent.pointerMove(chip);
    expect(
      (
        await screen.findAllByText(
          "This submodule branch has commits that never landed on traycer's main branch. Deleting the worktree deletes the branch and these commits with it:",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Newest change").length).toBeGreaterThan(0);
    expect(screen.getAllByText("First change").length).toBeGreaterThan(0);
    expect(screen.getAllByText("…and 2 more").length).toBeGreaterThan(0);
  });

  it("lists every Review reason once activity enrichment is available", async () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/review-reasons",
          branch: "feat-review",
          uncommittedCount: 2,
          branchStatus: { ahead: 2, behind: 0, mergedIntoDefault: false },
          submodules: [
            {
              repoIdentifier: { owner: "acme", repo: "lib" },
              branch: "traycer/lib",
              prState: "none",
              prNumber: null,
              prUrl: null,
              mergedHeadShaMatches: false,
              mergedIntoDefault: false,
              atPinnedCommit: false,
              unmergedCommitCount: 3,
              unmergedCommitSubjects: ["Newest"],
            },
          ],
        }),
      ],
      taskTitlesByEpicId: undefined,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });

    fireEvent.pointerMove(screen.getByTestId("worktree-tier-pill"));
    expect(
      (await screen.findAllByText("2 uncommitted changes")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("acme/lib (traycer/lib): 3 unmerged commits").length,
    ).toBeGreaterThan(0);
  });

  it("keeps the generic Review tooltip before activity enrichment", async () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/review-fallback",
          branch: "feat-review",
          uncommittedCount: 1,
          branchStatus: null,
        }),
      ],
      taskTitlesByEpicId: undefined,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });

    fireEvent.pointerMove(screen.getByTestId("worktree-tier-pill"));
    expect(
      (
        await screen.findAllByText(
          "Not proven safe to remove: it has uncommitted changes, unmerged or unpushed commits, an unmerged submodule branch, a detached HEAD, or unknown branch status. Review before deleting.",
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("hides PR facts from the row facts line now that chips carry the links", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/submodule-open",
          branch: "feat-submodule-open",
          submodules: [
            {
              repoIdentifier: { owner: "acme", repo: "sub" },
              branch: "feat-submodule-open",
              prState: "open",
              prNumber: 22,
              prUrl: "https://github.com/acme/sub/pull/22",
              mergedHeadShaMatches: false,
              mergedIntoDefault: false,
              atPinnedCommit: false,
            },
          ],
        }),
      ],
      taskTitlesByEpicId: undefined,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });

    expect(screen.queryByText("submodule acme/sub PR #22 open")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Open sub PR #22 Open" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/sub/pull/22");
  });

  it("does not render an unmerged chip for a submodule proven at its pinned gitlink", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/submodule-at-pin",
          branch: "feat-submodule-at-pin",
          atBaseCommit: true,
          submodules: [
            {
              repoIdentifier: { owner: "acme", repo: "sub" },
              branch: "feat-submodule-at-pin",
              prState: "none",
              prNumber: null,
              prUrl: null,
              mergedHeadShaMatches: false,
              mergedIntoDefault: false,
              atPinnedCommit: true,
            },
          ],
        }),
      ],
      taskTitlesByEpicId: undefined,
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });

    expect(screen.queryByText("sub · unmerged")).toBeNull();
  });

  it("labels a worktree with no owners as not used by any Task", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [entry({ worktreePath: "/wt/free", branch: "feat-free" })],
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });
    screen.getByText("Not used by any Task");
  });

  it("leads landed rows with a green Landed pill and shows ahead/behind facts", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/merged",
          branch: "feat-merged",
          branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
        }),
        entry({
          worktreePath: "/wt/diverged",
          branch: "feat-diverged",
          branchStatus: { ahead: 2, behind: 3, mergedIntoDefault: false },
        }),
      ],
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });
    // The merged row carries the proven-green "Landed" tier pill; the ahead/
    // unmerged row is amber Review, with the counts in its facts line.
    const tiers = screen
      .getAllByTestId("worktree-tier-pill")
      .map((pill) => pill.getAttribute("data-tier"));
    expect(tiers).toContain("merged");
    expect(tiers).toContain("review");
    expect(
      screen
        .getAllByTestId("worktree-tier-pill")
        .some((pill) => pill.textContent === "Landed"),
    ).toBe(true);
    screen.getByText("2 ahead · 3 behind");
  });

  it("shows a pending tier pill for a row not yet enriched (empty overlay)", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/merged",
          branch: "feat-merged",
          branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
        }),
      ],
      // No path enriched yet: the base row paints but its tier isn't known.
      enrichedByPath: new Map(),
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });
    // The base row is painted immediately (branch name visible), but the tier is
    // not classified yet - the pill reads "Checking…" (data-tier="pending"),
    // never a base-only tier that would flip once the probes land.
    screen.getByText("feat-merged");
    const tiers = screen
      .getAllByTestId("worktree-tier-pill")
      .map((pill) => pill.getAttribute("data-tier"));
    expect(tiers).toEqual(["pending"]);
    screen.getByText("Checking…");
  });

  it("filters rows by branch, path, repo label, and resolved Task title", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          repoLabel: "acme/app",
          worktreePath: "/wt/alpha",
          branch: "feat-alpha",
          owners: [
            {
              epicId: "epic-1",
              ownerKind: "chat",
              ownerId: "chat-1",
              updatedAt: 1,
            },
          ],
        }),
        entry({
          repoLabel: "acme/app",
          worktreePath: "/wt/beta",
          branch: "feat-beta",
        }),
      ],
      taskTitlesByEpicId: new Map([["epic-1", "Payments revamp"]]),
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });

    const search = screen.getByRole("searchbox", { name: "Search worktrees" });

    // Match on the resolved Task title -> only the alpha row survives.
    fireEvent.change(search, { target: { value: "payments" } });
    screen.getByRole("button", { name: "Delete worktree feat-alpha" });
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-beta" }),
    ).toBeNull();

    // Match on the branch name -> only the beta row survives.
    fireEvent.change(search, { target: { value: "feat-beta" } });
    screen.getByRole("button", { name: "Delete worktree feat-beta" });
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-alpha" }),
    ).toBeNull();

    // A query that matches nothing shows the empty-search message.
    fireEvent.change(search, { target: { value: "no-such-thing" } });
    screen.getByText("No worktrees match your search.");
  });

  it("Task chip shows partial 'Merged 1/2' when a submodule merged but the superproject PR is still open", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/alpha",
          branch: "feat-alpha",
          owners: [
            {
              epicId: "epic-1",
              ownerKind: "chat",
              ownerId: "chat-1",
              updatedAt: 1,
            },
          ],
          // Superproject gitlink-bump PR still open; owned submodule PR merged.
          prState: "open",
          prNumber: 10,
          mergedHeadShaMatches: false,
          submodules: [
            {
              repoIdentifier: { owner: "acme", repo: "sub" },
              branch: "feat-alpha",
              prState: "merged",
              prNumber: 11,
              prUrl: null,
              mergedHeadShaMatches: true,
              mergedIntoDefault: true,
              atPinnedCommit: false,
            },
          ],
        }),
      ],
      taskTitlesByEpicId: new Map([["epic-1", "Payments revamp"]]),
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });
    const rollup = screen.getByTestId("task-merge-rollup");
    expect(rollup.getAttribute("data-rollup-status")).toBe("partial");
    expect(rollup.textContent).toContain("Merged 1/2");
  });

  it("Task chip shows 'Merged' when the superproject and every owned submodule have merged PRs", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/alpha",
          branch: "feat-alpha",
          owners: [
            {
              epicId: "epic-1",
              ownerKind: "chat",
              ownerId: "chat-1",
              updatedAt: 1,
            },
          ],
          prState: "merged",
          prNumber: 20,
          mergedHeadShaMatches: true,
          submodules: [
            {
              repoIdentifier: { owner: "acme", repo: "sub" },
              branch: "feat-alpha",
              prState: "merged",
              prNumber: 21,
              prUrl: null,
              mergedHeadShaMatches: true,
              mergedIntoDefault: true,
              atPinnedCommit: false,
            },
          ],
        }),
      ],
      taskTitlesByEpicId: new Map([["epic-1", "Payments revamp"]]),
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });
    const rollup = screen.getByTestId("task-merge-rollup");
    expect(rollup.getAttribute("data-rollup-status")).toBe("merged");
    expect(rollup.textContent).toContain("Merged");
    expect(rollup.textContent).not.toContain("/");
  });

  it("Task chip shows no merge rollup when there is no PR anywhere (pre-M4 / gh absent degrade)", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/alpha",
          branch: "feat-alpha",
          owners: [
            {
              epicId: "epic-1",
              ownerKind: "chat",
              ownerId: "chat-1",
              updatedAt: 1,
            },
          ],
          // No PR facts, no submodules - the honest "nothing to claim" case.
        }),
      ],
      taskTitlesByEpicId: new Map([["epic-1", "Payments revamp"]]),
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });
    // The Task title still renders; the merge-rollup badge does not.
    screen.getByText("Payments revamp");
    expect(screen.queryByTestId("task-merge-rollup")).toBeNull();
  });

  it("orders by createdAt: Newest by default, Oldest reverses; null createdAt last", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/old",
          branch: "feat-old",
          createdAt: 1_000,
        }),
        entry({
          worktreePath: "/wt/new",
          branch: "feat-new",
          createdAt: 2_000,
        }),
        // A null createdAt sorts last in both directions.
        entry({
          worktreePath: "/wt/unknown",
          branch: "feat-unknown",
          createdAt: null,
        }),
      ],
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    const deleteLabel = (element: Element): string | null =>
      element.getAttribute("aria-label");
    const order = (): (string | null)[] =>
      screen
        .getAllByRole("button", { name: /^Delete worktree/ })
        .map(deleteLabel);

    // Default "Newest": most recently created first, null last.
    expect(order()).toEqual([
      "Delete worktree feat-new",
      "Delete worktree feat-old",
      "Delete worktree feat-unknown",
    ]);

    fireEvent.click(screen.getByTestId("worktrees-sort-oldest"));

    // "Oldest": reverses the dated rows, null still last.
    expect(order()).toEqual([
      "Delete worktree feat-old",
      "Delete worktree feat-new",
      "Delete worktree feat-unknown",
    ]);
  });

  it("keeps distinct labels for all three green tiers: Landed, At base commit, Unreferenced", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/merged",
          branch: "feat-merged",
          branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
        }),
        entry({
          worktreePath: "/wt/at-base",
          branch: "feat-at-base",
          atBaseCommit: true,
        }),
        entry({
          worktreePath: "/wt/unreferenced",
          branch: "feat-unreferenced",
          branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: false },
        }),
      ],
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });
    const pills = screen.getAllByTestId("worktree-tier-pill");
    const tiers = pills.map((pill) => pill.getAttribute("data-tier"));
    expect(tiers).toEqual(
      expect.arrayContaining(["merged", "at-base-commit", "unreferenced"]),
    );
    // Three proven-green tiers never collapse into one generic "Safe" label.
    // Scoped to the pills themselves - the (always-open, per test mock) tier
    // filter menu also lists these same three labels as menu items.
    const labels = pills.map((pill) => pill.textContent);
    expect(labels).toContain("Landed");
    expect(labels).toContain("At base commit");
    expect(labels).toContain("Unreferenced");
  });

  it("keeps risk-bearing facts visible without hover for Review, Unknown, Orphaned, and dirty/unpushed rows", () => {
    const reviewRow = entry({
      worktreePath: "/wt/review",
      branch: "feat-review",
      uncommittedCount: 2,
      branchStatus: { ahead: 3, behind: 0, mergedIntoDefault: false },
    });
    const orphanRow = entry({
      worktreePath: "/wt/orphan",
      branch: "feat-orphan",
      gitRemovable: false,
    });
    const unknownRow = entry({
      worktreePath: "/wt/unknown",
      branch: "feat-unknown-risk",
    });
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [reviewRow, orphanRow, unknownRow],
      // Review + Orphaned are enriched (ready); Unknown is left out of the
      // overlay and named in `erroredPaths`, so it settles to a static Unknown
      // pill rather than an infinite Checking spinner.
      enrichedByPath: new Map([
        [reviewRow.worktreePath, reviewRow],
        [orphanRow.worktreePath, orphanRow],
      ]),
      erroredPaths: new Set([unknownRow.worktreePath]),
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    // Every risk fact below is asserted directly against the rendered DOM -
    // no hover, focus, or expansion interaction fires before these queries.
    screen.getByText("3 ahead · 2 uncommitted changes");
    screen.getByText("git can't remove");
    screen.getByText("branch status unknown");

    const tiers = screen
      .getAllByTestId("worktree-tier-pill")
      .map((pill) => pill.getAttribute("data-tier"));
    expect(tiers).toEqual(
      expect.arrayContaining(["review", "orphaned", "unknown"]),
    );
  });

  it("renders Checking and Unknown pills with distinct, non-green styling", () => {
    const readyRow = entry({
      worktreePath: "/wt/ready",
      branch: "feat-ready",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    const pendingRow = entry({
      worktreePath: "/wt/pending",
      branch: "feat-pending",
    });
    const unknownRow = entry({
      worktreePath: "/wt/unknown",
      branch: "feat-unknown",
    });
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [readyRow, pendingRow, unknownRow],
      // `pendingRow` is left out of the overlay entirely (still Checking);
      // `unknownRow` is out of the overlay AND settled to an error (Unknown).
      enrichedByPath: new Map([[readyRow.worktreePath, readyRow]]),
      erroredPaths: new Set([unknownRow.worktreePath]),
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    const pills = screen.getAllByTestId("worktree-tier-pill");
    const mergedPill = pills.find(
      (pill) => pill.getAttribute("data-tier") === "merged",
    );
    const pendingPill = pills.find(
      (pill) => pill.getAttribute("data-tier") === "pending",
    );
    const unknownPill = pills.find(
      (pill) => pill.getAttribute("data-tier") === "unknown",
    );
    if (
      mergedPill === undefined ||
      pendingPill === undefined ||
      unknownPill === undefined
    ) {
      throw new Error("expected merged, pending, and unknown pills");
    }

    // Neither pending nor unknown ever claims the proven-green treatment.
    expect(mergedPill.className).toContain("emerald");
    expect(pendingPill.className).not.toContain("emerald");
    expect(unknownPill.className).not.toContain("emerald");

    // Both read as visibly unresolved (dashed border), distinct from every
    // resolved tier pill's solid border - and each still carries its own
    // accessible text label, never color alone.
    expect(pendingPill.className).toContain("border-dashed");
    expect(unknownPill.className).toContain("border-dashed");
    expect(mergedPill.className).not.toContain("border-dashed");
    screen.getByText("Checking…");
    screen.getByText("Unknown");
  });

  it("demotes the Task merge rollup to quiet text, distinct from the row's own tier pill", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({
          worktreePath: "/wt/alpha",
          branch: "feat-alpha",
          owners: [
            {
              epicId: "epic-1",
              ownerKind: "chat",
              ownerId: "chat-1",
              updatedAt: 1,
            },
          ],
          prState: "merged",
          prNumber: 20,
          mergedHeadShaMatches: true,
        }),
      ],
      taskTitlesByEpicId: new Map([["epic-1", "Payments revamp"]]),
      enrichedByPath: undefined,
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
    });

    const tierPill = screen.getByTestId("worktree-tier-pill");
    const rollup = screen.getByTestId("task-merge-rollup");

    // The rollup carries no icon and no Badge chrome (border/background) - it
    // cannot be mistaken for the row's own loud worktree-tier signal, which
    // keeps its icon and colored border.
    expect(rollup.querySelector("svg")).toBeNull();
    expect(rollup.className).not.toContain("border");
    expect(rollup.className).not.toContain("bg-emerald");
    expect(rollup.className).not.toContain("bg-amber");
    expect(tierPill.querySelector("svg")).not.toBeNull();

    // Wording scopes it to the Task, distinct from the row's own tier label -
    // both happen to say "Merged" for different subjects, so the prefix is
    // what keeps them from reading as the same claim.
    expect(rollup.textContent).toBe("Task Merged");
    expect(tierPill.textContent).not.toBe(rollup.textContent);
  });
});

describe("WorktreesList virtualization + per-viewport enrichment", () => {
  afterEach(() => {
    cleanup();
    __resetWorktreeDeleteRunForTests();
  });

  function listElement(args: {
    readonly worktrees: readonly WorktreeHostEntryV14[];
    readonly enrichedByPath: ReadonlyMap<string, WorktreeHostEntryV14>;
    readonly erroredPaths: ReadonlySet<string> | undefined;
    readonly onVisiblePathsChange:
      ((paths: readonly string[]) => void) | undefined;
  }): ReactNode {
    return (
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <WorktreesList
            openStreamTransport={() => stubOpenStreamTransport()}
            hostId="host-a"
            worktrees={args.worktrees}
            enrichedByPath={args.enrichedByPath}
            erroredPaths={args.erroredPaths ?? new Set()}
            seededPaths={new Set()}
            onVisiblePathsChange={args.onVisiblePathsChange ?? vi.fn()}
            taskTitlesByEpicId={new Map()}
            toolbarProps={testToolbarProps()}
          />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  function manyWorktrees(count: number): WorktreeHostEntryV14[] {
    return Array.from({ length: count }, (_unused, index) =>
      entry({
        worktreePath: `/wt/w${index}`,
        branch: `feat-${index}`,
        branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
      }),
    );
  }

  it("renders only a windowed subset of a large list, not every row", () => {
    // A short viewport forces a real window: far fewer rows mount than exist.
    virtualViewportHeight = 3 * WORKTREE_TEST_VIRTUAL_ITEM_HEIGHT;
    const worktrees = manyWorktrees(60);
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees,
      enrichedByPath: fullyEnriched(worktrees),
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    const renderedRows = screen.getAllByTestId("worktree-row");
    // Windowed: only a viewport-bounded handful mount, never all 60.
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(worktrees.length);
    expect(renderedRows.length).toBeLessThanOrEqual(20);
  });

  it("reports only the on-screen worktree paths (drives the per-visible query)", () => {
    virtualViewportHeight = 3 * WORKTREE_TEST_VIRTUAL_ITEM_HEIGHT;
    const worktrees = manyWorktrees(60);
    const onVisiblePathsChange = vi.fn<(paths: readonly string[]) => void>();
    render(
      listElement({
        worktrees,
        enrichedByPath: fullyEnriched(worktrees),
        onVisiblePathsChange,
        erroredPaths: undefined,
      }),
    );

    expect(onVisiblePathsChange).toHaveBeenCalled();
    const lastCall = onVisiblePathsChange.mock.lastCall;
    const reported = lastCall === undefined ? [] : lastCall[0];
    // Only the on-screen paths are reported - a viewport-bounded subset, never
    // the whole list - and every one is a real worktree path.
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.length).toBeLessThan(worktrees.length);
    const allPaths = new Set(
      worktrees.map((worktree) => worktree.worktreePath),
    );
    for (const path of reported) expect(allPaths.has(path)).toBe(true);
  });

  it("paints the base list with zero enrichment: rows show, tiers read Checking…", () => {
    const worktrees = [
      entry({
        worktreePath: "/wt/a",
        branch: "feat-a",
        branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
      }),
      entry({
        worktreePath: "/wt/b",
        branch: "feat-b",
        branchStatus: { ahead: 2, behind: 0, mergedIntoDefault: false },
      }),
    ];
    // Empty overlay: nothing enriched yet.
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees,
      enrichedByPath: new Map(),
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    // Base fields paint immediately (branch names, delete affordances) - the
    // delete affordance is present but disabled while the row is Checking.
    screen.getByText("feat-a");
    screen.getByText("feat-b");
    expect(
      screen.getAllByRole("button", {
        name: "Delete worktree (status is still being checked)",
      }),
    ).toHaveLength(2);
    // Every tier pill is the neutral pending state - NOT a base-only tier that
    // would flip once the probes land. A base-only classify would call /wt/b
    // "Review"; it must not, while pending.
    const tiers = screen
      .getAllByTestId("worktree-tier-pill")
      .map((pill) => pill.getAttribute("data-tier"));
    expect(tiers).toEqual(["pending", "pending"]);
    expect(tiers).not.toContain("review");
    expect(screen.getAllByText("Checking…")).toHaveLength(2);
  });

  it("fills a row's tier by path once its enrichment lands (merge by path)", () => {
    const merged = entry({
      worktreePath: "/wt/merged",
      branch: "feat-merged",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    const { rerender } = render(
      listElement({
        worktrees: [merged],
        enrichedByPath: new Map(),
        erroredPaths: undefined,
        onVisiblePathsChange: undefined,
      }),
    );

    // Pending first: the pill is "Checking…".
    expect(
      screen.getByTestId("worktree-tier-pill").getAttribute("data-tier"),
    ).toBe("pending");

    // The overlay gains this path (merge is by worktreePath, not index) - the row
    // resolves to its enriched entry and the tier fills in.
    rerender(
      listElement({
        worktrees: [merged],
        enrichedByPath: new Map([[merged.worktreePath, merged]]),
        erroredPaths: undefined,
        onVisiblePathsChange: undefined,
      }),
    );
    expect(
      screen.getByTestId("worktree-tier-pill").getAttribute("data-tier"),
    ).toBe("merged");
    expect(screen.queryByText("Checking…")).toBeNull();
  });

  it("keeps a still-pending row under an active tier filter (no dead-end)", () => {
    // One enriched Landed row + one still-pending row. Filtering to Landed must
    // keep the pending row visible (its tier is unknown, so it can't be excluded
    // yet) so it can enrich, instead of dead-ending the filtered view to empty.
    const mergedRow = entry({
      worktreePath: "/wt/merged",
      branch: "feat-merged",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    const pendingRow = entry({
      worktreePath: "/wt/pending",
      branch: "feat-pending",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    render(
      listElement({
        worktrees: [mergedRow, pendingRow],
        // Only the merged row is enriched; the other stays pending.
        enrichedByPath: new Map([[mergedRow.worktreePath, mergedRow]]),
        erroredPaths: undefined,
        onVisiblePathsChange: undefined,
      }),
    );

    // Landed is the only known tier, so it is the only filter option offered.
    fireEvent.click(screen.getByTestId("worktrees-filter-merged"));

    // The enriched Landed row stays; the still-pending row is KEPT (shown as
    // "Checking…"), not dropped - its delete affordance is disabled, not absent.
    screen.getByRole("button", { name: "Delete worktree feat-merged" });
    screen.getByRole("button", {
      name: "Delete worktree (status is still being checked)",
    });
    screen.getByText("Checking…");
  });

  it("excludes a still-pending row's unknown tier from the filter options", () => {
    const mergedRow = entry({
      worktreePath: "/wt/merged",
      branch: "feat-merged",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    const pendingReview = entry({
      worktreePath: "/wt/review",
      branch: "feat-review",
      branchStatus: { ahead: 2, behind: 0, mergedIntoDefault: false },
    });
    render(
      listElement({
        worktrees: [mergedRow, pendingReview],
        enrichedByPath: new Map([[mergedRow.worktreePath, mergedRow]]),
        erroredPaths: undefined,
        onVisiblePathsChange: undefined,
      }),
    );

    // Only the enriched row contributes a tier option; the pending row's would-be
    // "Review" tier is not offered until it enriches.
    screen.getByTestId("worktrees-filter-merged");
    expect(screen.queryByTestId("worktrees-filter-review")).toBeNull();
  });

  it("renders a settled-error row as a non-spinner Unknown, not an infinite spinner", () => {
    const erroredRow = entry({
      worktreePath: "/wt/errored",
      branch: "feat-errored",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    render(
      listElement({
        worktrees: [erroredRow],
        // Not enriched, but its per-path query SETTLED to an error.
        enrichedByPath: new Map(),
        erroredPaths: new Set([erroredRow.worktreePath]),
        onVisiblePathsChange: undefined,
      }),
    );

    // Base info still paints; the pill reads a static "Unknown" (data-tier=unknown)
    // with NO "Checking…" spinner.
    screen.getByText("feat-errored");
    const pill = screen.getByTestId("worktree-tier-pill");
    expect(pill.getAttribute("data-tier")).toBe("unknown");
    screen.getByText("Unknown");
    expect(screen.queryByText("Checking…")).toBeNull();
    expect(
      screen.queryByTestId("worktree-tier-pill-pending-spinner"),
    ).toBeNull();
  });

  it("keeps an errored row out of tier filters exactly like a pending one", () => {
    const mergedRow = entry({
      worktreePath: "/wt/merged",
      branch: "feat-merged",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    const erroredRow = entry({
      worktreePath: "/wt/errored",
      branch: "feat-errored",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    render(
      listElement({
        worktrees: [mergedRow, erroredRow],
        enrichedByPath: new Map([[mergedRow.worktreePath, mergedRow]]),
        erroredPaths: new Set([erroredRow.worktreePath]),
        onVisiblePathsChange: undefined,
      }),
    );

    // The errored row's tier is unknown, so it contributes no filter option and
    // (like a pending row) is KEPT under an active tier filter rather than dropped.
    expect(screen.queryByTestId("worktrees-filter-errored")).toBeNull();
    fireEvent.click(screen.getByTestId("worktrees-filter-merged"));
    screen.getByRole("button", { name: "Delete worktree feat-merged" });
    screen.getByRole("button", { name: "Delete worktree feat-errored" });
    // Still shown as Unknown while filtered, not spinning.
    screen.getByText("Unknown");
  });

  it("upgrades an errored row in place once a later refetch succeeds", () => {
    const merged = entry({
      worktreePath: "/wt/errored",
      branch: "feat-errored",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    const { rerender } = render(
      listElement({
        worktrees: [merged],
        enrichedByPath: new Map(),
        erroredPaths: new Set([merged.worktreePath]),
        onVisiblePathsChange: undefined,
      }),
    );

    // First: settled error → Unknown pill.
    expect(
      screen.getByTestId("worktree-tier-pill").getAttribute("data-tier"),
    ).toBe("unknown");

    // A refresh / scroll-back retry succeeds: the path moves from errored to
    // enriched and the row upgrades in place to its real tier.
    rerender(
      listElement({
        worktrees: [merged],
        enrichedByPath: new Map([[merged.worktreePath, merged]]),
        erroredPaths: new Set(),
        onVisiblePathsChange: undefined,
      }),
    );
    expect(
      screen.getByTestId("worktree-tier-pill").getAttribute("data-tier"),
    ).toBe("merged");
    expect(screen.queryByText("Unknown")).toBeNull();
  });
});

describe("WorktreesList status-aware delete safety", () => {
  afterEach(() => {
    cleanup();
    __resetWorktreeDeleteRunForTests();
    streamMock.paths = [];
    streamMock.callbacksByPath.clear();
    toastMock.messages = [];
  });

  // Returns the tree directly (no intermediate wrapper component, unlike
  // `renderList`'s locally-scoped `Wrapper`) so a later `.rerender(...)` call
  // with this same helper keeps the SAME root element type across renders -
  // required for React to preserve component state (selection,
  // `pendingDeleteTargets`) instead of remounting the whole subtree.
  function statusAwareElement(args: {
    readonly queryClient: QueryClient;
    readonly worktrees: readonly WorktreeHostEntryV14[];
    readonly enrichedByPath: ReadonlyMap<string, WorktreeHostEntryV14>;
    readonly erroredPaths: ReadonlySet<string>;
  }): ReactNode {
    return (
      <QueryClientProvider client={args.queryClient}>
        <TooltipProvider>
          <WorktreesList
            openStreamTransport={() => stubOpenStreamTransport()}
            hostId="host-a"
            worktrees={args.worktrees}
            enrichedByPath={args.enrichedByPath}
            erroredPaths={args.erroredPaths}
            seededPaths={new Set()}
            onVisiblePathsChange={vi.fn()}
            taskTitlesByEpicId={new Map()}
            toolbarProps={testToolbarProps()}
          />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  it("disables the row delete button while Checking and blocks the confirmation", () => {
    const pendingRow = entry({
      worktreePath: "/wt/pending",
      branch: "feat-pending",
    });
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [pendingRow],
      // Never enriched - the row stays "Checking…" for the whole test.
      enrichedByPath: new Map(),
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    const deleteButton = screen.getByRole("button", {
      name: "Delete worktree (status is still being checked)",
    });
    expect(deleteButton.hasAttribute("disabled")).toBe(true);

    fireEvent.click(deleteButton);
    expect(screen.queryByText("Delete worktree?")).toBeNull();
    expect(screen.queryByTestId("confirm-action")).toBeNull();
  });

  it("disables bulk delete and names how many selected rows are still Checking", () => {
    const mergedRow = entry({
      worktreePath: "/wt/merged",
      branch: "feat-merged",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    const pendingRow = entry({
      worktreePath: "/wt/pending",
      branch: "feat-pending",
    });
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [mergedRow, pendingRow],
      enrichedByPath: new Map([[mergedRow.worktreePath, mergedRow]]),
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    selectRows(["feat-merged", "feat-pending"]);

    const deleteSelected = screen.getByTestId("worktrees-list-delete-selected");
    expect(deleteSelected.hasAttribute("disabled")).toBe(true);
    screen.getByText("1 selected worktree is still checking status");

    fireEvent.click(deleteSelected);
    expect(screen.queryByText(/^Delete \d+ worktrees\?$/)).toBeNull();
  });

  it("opens an unknown-risk confirmation for a settled-error row instead of the generic one", () => {
    const erroredRow = entry({
      worktreePath: "/wt/errored",
      branch: "feat-errored",
    });
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [erroredRow],
      enrichedByPath: new Map(),
      erroredPaths: new Set([erroredRow.worktreePath]),
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Delete worktree feat-errored" }),
    );
    screen.getByText("Delete worktree with unknown status?");
    expect(screen.getByTestId("confirm-action").textContent).toContain(
      "Delete anyway",
    );

    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(streamMock.paths).toEqual(["/wt/errored"]);
  });

  it("includes an unknown-risk caveat in the bulk summary when selected rows include an Unknown row", () => {
    const mergedRow = entry({
      worktreePath: "/wt/merged",
      branch: "feat-merged",
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
    const erroredRow = entry({
      worktreePath: "/wt/errored",
      branch: "feat-errored",
    });
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [mergedRow, erroredRow],
      enrichedByPath: new Map([[mergedRow.worktreePath, mergedRow]]),
      erroredPaths: new Set([erroredRow.worktreePath]),
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    selectRows(["feat-merged", "feat-errored"]);
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));

    screen.getByText("Delete 2 worktrees?");
    screen.getByTestId("worktree-bulk-delete-unknown-caveat");

    fireEvent.click(screen.getByTestId("confirm-action"));
    expect([...streamMock.paths].sort()).toEqual(["/wt/errored", "/wt/merged"]);
  });

  it("clears a stale single-row delete target that regresses to Checking, names it in the drop toast, and does not reopen once it settles", () => {
    const readyRow = entry({ worktreePath: "/wt/ready", branch: "feat-ready" });
    const queryClient = new QueryClient();
    const rendered = render(
      statusAwareElement({
        queryClient,
        worktrees: [readyRow],
        enrichedByPath: new Map([[readyRow.worktreePath, readyRow]]),
        erroredPaths: new Set(),
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete worktree feat-ready" }),
    );
    screen.getByText("Delete worktree?");

    // A refresh re-arms the row's enrichment while the confirmation is open -
    // it regresses from ready back to Checking. The only pending target
    // dropped to zero eligible rows, so the confirmation - which can no
    // longer be trusted - closes, the drop is named, and the stale intent is
    // cleared (not just visually hidden).
    rendered.rerender(
      statusAwareElement({
        queryClient,
        worktrees: [readyRow],
        enrichedByPath: new Map(),
        erroredPaths: new Set(),
      }),
    );

    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(streamMock.paths).toEqual([]);
    expect(toastMock.messages.join("\n")).toContain("still checking status");

    // The row later settles back to ready. Since the stale intent was already
    // cleared (not merely hidden), the old confirmation must NOT silently
    // reopen without the user choosing Delete again.
    rendered.rerender(
      statusAwareElement({
        queryClient,
        worktrees: [readyRow],
        enrichedByPath: new Map([[readyRow.worktreePath, readyRow]]),
        erroredPaths: new Set(),
      }),
    );

    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(screen.queryByText("Delete worktree?")).toBeNull();
    expect(streamMock.paths).toEqual([]);
  });

  it("clears a stale bulk delete target set when every selected row regresses to Checking, and does not reopen once settled", () => {
    const readyA = entry({ worktreePath: "/wt/a", branch: "feat-a" });
    const readyB = entry({ worktreePath: "/wt/b", branch: "feat-b" });
    const queryClient = new QueryClient();
    const rendered = render(
      statusAwareElement({
        queryClient,
        worktrees: [readyA, readyB],
        enrichedByPath: new Map([
          [readyA.worktreePath, readyA],
          [readyB.worktreePath, readyB],
        ]),
        erroredPaths: new Set(),
      }),
    );

    selectRows(["feat-a", "feat-b"]);
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    screen.getByText("Delete 2 worktrees?");

    // Both selected rows regress to Checking while the bulk confirmation is
    // open - every pending target drops, unlike the mixed-drop case where a
    // sibling stays eligible.
    rendered.rerender(
      statusAwareElement({
        queryClient,
        worktrees: [readyA, readyB],
        enrichedByPath: new Map(),
        erroredPaths: new Set(),
      }),
    );

    expect(screen.queryByText("Delete 2 worktrees?")).toBeNull();
    expect(screen.queryByTestId("worktree-bulk-delete-dialog")).toBeNull();
    expect(streamMock.paths).toEqual([]);
    expect(toastMock.messages.join("\n")).toContain("still checking status");

    // Both rows later settle back to ready - the stale bulk intent was
    // already cleared, so the old bulk confirmation must not reopen.
    rendered.rerender(
      statusAwareElement({
        queryClient,
        worktrees: [readyA, readyB],
        enrichedByPath: new Map([
          [readyA.worktreePath, readyA],
          [readyB.worktreePath, readyB],
        ]),
        erroredPaths: new Set(),
      }),
    );

    expect(screen.queryByText("Delete 2 worktrees?")).toBeNull();
    expect(screen.queryByTestId("worktree-bulk-delete-dialog")).toBeNull();
    expect(streamMock.paths).toEqual([]);
  });

  it("skips a row that regresses to Checking mid-dialog, names it in the drop toast, and still deletes its still-eligible sibling", () => {
    const readyA = entry({ worktreePath: "/wt/a", branch: "feat-a" });
    const readyB = entry({ worktreePath: "/wt/b", branch: "feat-b" });
    const queryClient = new QueryClient();
    const rendered = render(
      statusAwareElement({
        queryClient,
        worktrees: [readyA, readyB],
        enrichedByPath: new Map([
          [readyA.worktreePath, readyA],
          [readyB.worktreePath, readyB],
        ]),
        erroredPaths: new Set(),
      }),
    );

    selectRows(["feat-a", "feat-b"]);
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    screen.getByText("Delete 2 worktrees?");

    // /wt/b regresses to Checking while the bulk confirmation is open; /wt/a
    // stays ready.
    rendered.rerender(
      statusAwareElement({
        queryClient,
        worktrees: [readyA, readyB],
        enrichedByPath: new Map([[readyA.worktreePath, readyA]]),
        erroredPaths: new Set(),
      }),
    );

    // Only one target remains eligible, so the dialog re-resolves to the
    // single-row confirmation for /wt/a.
    screen.getByText("Delete worktree?");
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(streamMock.paths).toEqual(["/wt/a"]);
    expect(toastMock.messages.join("\n")).toContain("still checking status");
  });

  it("names permanent dirty loss and unknown risk for an Unknown row with uncommitted changes", () => {
    const dirtyErroredRow = entry({
      worktreePath: "/wt/errored-dirty",
      branch: "feat-errored-dirty",
      uncommittedCount: 5,
    });
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [dirtyErroredRow],
      // Never enriched, but settled to an error - Unknown, not Checking. The
      // uncommitted count is still known: it is a cheap base-listing field.
      enrichedByPath: new Map(),
      erroredPaths: new Set([dirtyErroredRow.worktreePath]),
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete worktree feat-errored-dirty",
      }),
    );

    // Leads with the known, stronger dirty-loss warning...
    screen.getByText("Discard 5 uncommitted changes?");
    screen.getByText(/will be permanently lost/i);
    expect(screen.getByTestId("confirm-action").textContent).toContain(
      "Delete and discard",
    );
    // ...and still names the unverified branch/activity risk, rather than
    // silently dropping it because a stronger warning already fired.
    screen.getByText(/could not be verified/i);

    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(streamMock.paths).toEqual(["/wt/errored-dirty"]);
  });
});

describe("WorktreesList PR-number search", () => {
  afterEach(() => {
    cleanup();
  });

  // The BASE listing exactly as the host serves it: `prNumber` pinned to null on
  // every row (see `worktree-setup-orchestrator`'s base shape). PR facts do not
  // exist here - they only arrive on the enrichment overlay below. Building the
  // fixture this way is what makes the un-enriched cases honest.
  const PR_BASE: readonly WorktreeHostEntryV14[] = [
    entry({ worktreePath: "/wt/super-pr", branch: "feat-super-pr" }),
    entry({ worktreePath: "/wt/sub-pr", branch: "feat-sub-pr" }),
    entry({ worktreePath: "/wt/no-pr", branch: "feat-no-pr" }),
  ];

  // What those rows resolve to once probed: a superproject PR, a submodule-only
  // PR, and a row that genuinely has none.
  const PR_ENRICHED: readonly WorktreeHostEntryV14[] = [
    entry({
      worktreePath: "/wt/super-pr",
      branch: "feat-super-pr",
      prState: "merged",
      prNumber: 4360,
      prUrl: "https://github.com/acme/app/pull/4360",
    }),
    entry({
      worktreePath: "/wt/sub-pr",
      branch: "feat-sub-pr",
      submodules: [
        {
          repoIdentifier: { owner: "acme", repo: "sub" },
          branch: "feat-sub-pr",
          prState: "open",
          prNumber: 256,
          prUrl: "https://github.com/acme/sub/pull/256",
          mergedHeadShaMatches: false,
          mergedIntoDefault: false,
          atPinnedCommit: false,
        },
      ],
    }),
    entry({ worktreePath: "/wt/no-pr", branch: "feat-no-pr" }),
  ];

  // The overlay with the named paths held back - i.e. still awaiting their probe.
  function enrichedExcept(
    unprobedPaths: readonly string[],
  ): ReadonlyMap<string, WorktreeHostEntryV14> {
    return new Map(
      PR_ENRICHED.filter(
        (worktree) => !unprobedPaths.includes(worktree.worktreePath),
      ).map((worktree) => [worktree.worktreePath, worktree]),
    );
  }

  function search(value: string): void {
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search worktrees" }),
      { target: { value } },
    );
  }

  function renderPrList(args: {
    readonly enrichedByPath: ReadonlyMap<string, WorktreeHostEntryV14>;
    readonly erroredPaths: ReadonlySet<string> | undefined;
  }): void {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: PR_BASE,
      enrichedByPath: args.enrichedByPath,
      erroredPaths: args.erroredPaths,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });
  }

  function visibleBranches(): readonly string[] {
    return PR_BASE.map((worktree) => worktree.branch).filter(
      (branch): branch is string =>
        branch !== null &&
        screen.queryByRole("button", { name: `Delete worktree ${branch}` }) !==
          null,
    );
  }

  it.each([
    ["4360", "feat-super-pr"],
    ["#4360", "feat-super-pr"],
    // The submodule leg is indexed too - the row wears a `#256` pill, so the
    // number on that pill has to find it.
    ["256", "feat-sub-pr"],
    ["#256", "feat-sub-pr"],
  ])("narrows to the row owning PR %s", (query, expectedBranch) => {
    renderPrList({
      enrichedByPath: enrichedExcept([]),
      erroredPaths: undefined,
    });
    search(query);
    expect(visibleBranches()).toEqual([expectedBranch]);
  });

  it("still matches repo, branch, path, and Task after the PR leg is added", () => {
    renderPrList({
      enrichedByPath: enrichedExcept([]),
      erroredPaths: undefined,
    });
    // The PR index is a UNION with the text haystack, never a replacement: a
    // non-PR query must keep behaving exactly as it did before.
    search("feat-no-pr");
    expect(visibleBranches()).toEqual(["feat-no-pr"]);
    search("acme/app");
    expect(visibleBranches()).toEqual([
      "feat-super-pr",
      "feat-sub-pr",
      "feat-no-pr",
    ]);
  });

  it("reads 'still checking' - not 'no matches' - while the PR row is un-enriched", () => {
    // `/wt/super-pr` is held back from the overlay, so its base row still carries
    // `prNumber: null`. It genuinely cannot match `4360` yet - but claiming "no
    // matches" would be a lie, because the worktree being looked for is right
    // there, one probe away.
    renderPrList({
      enrichedByPath: enrichedExcept(["/wt/super-pr"]),
      erroredPaths: undefined,
    });
    search("4360");

    expect(visibleBranches()).toEqual([]);
    screen.getByText("No matches yet - still checking 1 worktree.");
    expect(screen.queryByText("No worktrees match your search.")).toBeNull();
  });

  it("settles to 'no matches' once every probe has landed", () => {
    renderPrList({
      enrichedByPath: enrichedExcept([]),
      erroredPaths: undefined,
    });
    search("9999");

    expect(visibleBranches()).toEqual([]);
    screen.getByText("No worktrees match your search.");
  });

  it("does not hold the 'still checking' notice open for an errored row", () => {
    // An errored row is un-enriched too, but its probe SETTLED - it will never
    // learn its PR number. Counting it would pin the spinner on forever, so the
    // empty state has to fall through to the plain no-match copy.
    renderPrList({
      enrichedByPath: enrichedExcept(["/wt/super-pr"]),
      erroredPaths: new Set(["/wt/super-pr"]),
    });
    search("4360");

    expect(visibleBranches()).toEqual([]);
    screen.getByText("No worktrees match your search.");
    expect(screen.queryByText(/still checking/)).toBeNull();
  });

  it("suppresses the 'still checking' notice while a tier filter is active", () => {
    // A pending row bypasses the tier stage only WHILE it's pending (see
    // `filteredWorktrees`) - once it resolves it might land in a tier the
    // active filter excludes, and the search would never surface it despite
    // the notice having promised to. `/wt/atbase` is enriched purely so
    // "At base commit" is an available filter option to select; the two rows
    // that matter, `/wt/super-pr` and `/wt/other-pending`, are left pending
    // and irrelevant to the "4360" query either way.
    const atBase = entry({
      worktreePath: "/wt/atbase",
      branch: "feat-atbase",
      atBaseCommit: true,
    });
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [
        entry({ worktreePath: "/wt/super-pr", branch: "feat-super-pr" }),
        entry({
          worktreePath: "/wt/other-pending",
          branch: "feat-other-pending",
        }),
        atBase,
      ],
      enrichedByPath: new Map([[atBase.worktreePath, atBase]]),
      erroredPaths: undefined,
      seededPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    fireEvent.click(screen.getByTestId("worktrees-filter-at-base-commit"));
    search("4360");

    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-super-pr" }),
    ).toBeNull();
    screen.getByText("No worktrees match your search.");
    expect(screen.queryByText(/still checking/)).toBeNull();
  });
});
