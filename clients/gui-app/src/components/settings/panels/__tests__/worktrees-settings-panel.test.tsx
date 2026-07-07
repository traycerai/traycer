import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { WorktreeDeleteStreamCallbacks } from "@traycer-clients/shared/host-transport/worktree-delete-stream-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorktreeHostEntryV11 } from "@traycer/protocol/host/index";
import type { WorktreeEntryScripts } from "@traycer/protocol/host/worktree-schemas";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { WorktreesList } from "@/components/settings/panels/worktrees-settings-panel";
import { __resetWorktreeDeleteRunForTests } from "@/components/settings/panels/use-worktree-delete-run";
import { hostQueryKeys } from "@/lib/query-keys";
import { WORKTREE_BINDING_INVALIDATIONS } from "@/hooks/worktree/invalidations";

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
    error: () => {},
  },
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
    readonly "data-testid"?: string;
  }): ReactNode => (
    <button
      type="button"
      data-testid={props["data-testid"]}
      disabled={props.disabled ?? false}
      onClick={props.onSelect}
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
      readonly "data-testid"?: string;
    }) => <div data-testid={props["data-testid"]}>{props.children}</div>,
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

function entry(
  over: Partial<WorktreeHostEntryV11> & {
    worktreePath: string;
    branch: string;
  },
): WorktreeHostEntryV11 {
  return {
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    // v1.1 staleness + merge-provenance signals default to the "no signal /
    // older host" shape so each test opts into only the fields it exercises.
    owners: [],
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    ...over,
  };
}

const WORKTREES: WorktreeHostEntryV11[] = [
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

// jsdom has no layout, so `@tanstack/react-virtual` (which sizes the scroll
// viewport and measures items via `offsetHeight`) sees zero everywhere and would
// window down to nothing. Feed it a real height for the scroll element
// (`worktrees-virtual-scroll`) and a fixed height per measured virtual item
// (`data-index`); everything else keeps jsdom's zero. A tall default viewport
// renders every row (so the behavioural tests still find their rows); the
// windowing test shrinks `virtualViewportHeight` to force a real window.
const VIRTUAL_ITEM_TEST_HEIGHT = 80;
let virtualViewportHeight = 100_000;
let offsetHeightDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  virtualViewportHeight = 100_000;
  offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.dataset.testid === "worktrees-virtual-scroll") {
        return virtualViewportHeight;
      }
      if (this.hasAttribute("data-index")) return VIRTUAL_ITEM_TEST_HEIGHT;
      return 0;
    },
  });
});

afterEach(() => {
  if (offsetHeightDescriptor !== undefined) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      offsetHeightDescriptor,
    );
  }
  offsetHeightDescriptor = undefined;
});

// Treat every passed worktree as already-enriched (its base entry IS its enriched
// entry) - the default the behavioural tests want, so tiers classify immediately.
// Tests that exercise the pending/lazy path pass their own partial overlay.
function fullyEnriched(
  worktrees: readonly WorktreeHostEntryV11[],
): ReadonlyMap<string, WorktreeHostEntryV11> {
  return new Map(worktrees.map((entry) => [entry.worktreePath, entry]));
}

function renderList(args: {
  readonly hostId: string;
  readonly queryClient: QueryClient;
  readonly worktrees: readonly WorktreeHostEntryV11[];
  readonly enrichedByPath:
    ReadonlyMap<string, WorktreeHostEntryV11> | undefined;
  readonly erroredPaths: ReadonlySet<string> | undefined;
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
        onVisiblePathsChange={args.onVisiblePathsChange ?? vi.fn()}
        taskTitlesByEpicId={args.taskTitlesByEpicId ?? new Map()}
        toolbarProps={testToolbarProps()}
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

function testToolbarProps() {
  return {
    hosts: [],
    value: null,
    onChange: vi.fn(),
    onRefresh: vi.fn(),
    refreshing: false,
    canRefresh: true,
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
    expect(busyButton.getAttribute("aria-disabled")).toBe("true");
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
    within(actionBar).getByText("1 selected");
    within(actionBar).getByTestId("worktrees-list-delete-selected");
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
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    screen.getByRole("button", { name: "Delete worktree feat-clean" });
    screen.getByRole("button", { name: "Delete worktree feat-api-clean" });

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

  it("shows row delete controls only on worktree row hover or focus", () => {
    renderDefault();

    const reviewButton = screen.getByRole("button", {
      name: "Manage scripts for worktree feat-clean",
    });
    const deleteButton = screen.getByRole("button", {
      name: "Delete worktree feat-clean",
    });

    const actionGroup = deleteButton.parentElement;
    expect(actionGroup?.className).toContain("opacity-0");
    expect(actionGroup?.className).toContain(
      "group-hover/worktree-row:opacity-100",
    );
    expect(actionGroup?.className).toContain("focus-within:opacity-100");
    expect(reviewButton.parentElement).toBe(actionGroup);
  });

  it("saves reviewed scripts before a later delete starts", async () => {
    vi.useFakeTimers();
    renderDefault();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Manage scripts for worktree feat-clean",
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
      refetchType: "all",
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
      refetchType: "all",
    });
    for (const method of WORKTREE_BINDING_INVALIDATIONS) {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: hostQueryKeys.methodScope("host-a", method),
        refetchType: "all",
      });
    }
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-b", "worktree.listAllForHost"),
      refetchType: "all",
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

  function merged(path: string, branch: string): WorktreeHostEntryV11 {
    return entry({
      worktreePath: path,
      branch,
      branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
    });
  }

  function renderWith(
    queryClient: QueryClient,
    worktrees: readonly WorktreeHostEntryV11[],
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

    // The now-ineligible row is excluded from the started delete and named in the
    // class-summarized drop toast (its freshest class is dirty).
    expect(streamMock.paths).toEqual(["/wt/a", "/wt/b"]);
    expect(toastMock.messages.join("\n")).toContain("1 dirty");
  });

  it("filter → Merged then select-all picks only the Merged rows (fast path)", () => {
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
    // Narrow to the Merged tier via the standard status filter.
    fireEvent.click(screen.getByTestId("worktrees-filter-merged"));
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-unref" }),
    ).toBeNull();

    // Standard select-all now acts only on the visible (Merged) row.
    fireEvent.click(screen.getByTestId("worktrees-select-all"));
    expect(screen.getByText("1 selected")).not.toBeNull();
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(streamMock.paths).toEqual(["/wt/merged"]);
  });

  function atBase(path: string, branch: string): WorktreeHostEntryV11 {
    return entry({ worktreePath: path, branch, atBaseCommit: true });
  }

  it("status filter is multi-select: Merged + At base commit shows their union", () => {
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

    // Union of Merged + At base commit: the review row is filtered out, the two
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

    // Filter to Merged only - the review row hides and the toolbar reads Merged.
    fireEvent.click(screen.getByTestId("worktrees-filter-trigger"));
    fireEvent.click(screen.getByTestId("worktrees-filter-merged"));
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-review" }),
    ).toBeNull();
    screen.getByRole("button", { name: "Filter: Merged" });

    // The last Merged row is deleted out from under the filter (only review left).
    rendered.rerender(renderWith(queryClient, [reviewRow]));

    // The stale "Merged" selection is no longer available, so the effective
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

describe("WorktreesList v1.1 signals", () => {
  afterEach(() => {
    cleanup();
    __resetWorktreeDeleteRunForTests();
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
      onVisiblePathsChange: undefined,
    });

    // The resolved epic-1 renders a chip (the duplicate epic-1 owner collapses).
    screen.getByText("Ship the audit");
    // epic-2 has no cached title -> demoted muted "Owner unresolved" text, not a
    // prominent chip.
    screen.getByText("Owner unresolved");
  });

  it("labels a worktree with no owners as not used by any Task", () => {
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: [entry({ worktreePath: "/wt/free", branch: "feat-free" })],
      enrichedByPath: undefined,
      erroredPaths: undefined,
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });
    screen.getByText("Not used by any Task");
  });

  it("leads merged rows with a green Merged pill and shows ahead/behind facts", () => {
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
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });
    // The merged row carries the proven-green "Merged" tier pill; the ahead/
    // unmerged row is amber Review, with the counts in its facts line.
    const tiers = screen
      .getAllByTestId("worktree-tier-pill")
      .map((pill) => pill.getAttribute("data-tier"));
    expect(tiers).toContain("merged");
    expect(tiers).toContain("review");
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
            },
          ],
        }),
      ],
      taskTitlesByEpicId: new Map([["epic-1", "Payments revamp"]]),
      enrichedByPath: undefined,
      erroredPaths: undefined,
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
            },
          ],
        }),
      ],
      taskTitlesByEpicId: new Map([["epic-1", "Payments revamp"]]),
      enrichedByPath: undefined,
      erroredPaths: undefined,
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
});

describe("WorktreesList virtualization + per-viewport enrichment", () => {
  afterEach(() => {
    cleanup();
    __resetWorktreeDeleteRunForTests();
  });

  function listElement(args: {
    readonly worktrees: readonly WorktreeHostEntryV11[];
    readonly enrichedByPath: ReadonlyMap<string, WorktreeHostEntryV11>;
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
            onVisiblePathsChange={args.onVisiblePathsChange ?? vi.fn()}
            taskTitlesByEpicId={new Map()}
            toolbarProps={testToolbarProps()}
          />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  function manyWorktrees(count: number): WorktreeHostEntryV11[] {
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
    virtualViewportHeight = 3 * VIRTUAL_ITEM_TEST_HEIGHT;
    const worktrees = manyWorktrees(60);
    renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees,
      enrichedByPath: fullyEnriched(worktrees),
      erroredPaths: undefined,
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
    virtualViewportHeight = 3 * VIRTUAL_ITEM_TEST_HEIGHT;
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
      onVisiblePathsChange: undefined,
      taskTitlesByEpicId: undefined,
    });

    // Base fields paint immediately (branch names, delete affordances).
    screen.getByText("feat-a");
    screen.getByText("feat-b");
    screen.getByRole("button", { name: "Delete worktree feat-a" });
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
    // One enriched Merged row + one still-pending row. Filtering to Merged must
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

    // Merged is the only known tier, so it is the only filter option offered.
    fireEvent.click(screen.getByTestId("worktrees-filter-merged"));

    // The enriched Merged row stays; the still-pending row is KEPT (shown as
    // "Checking…"), not dropped.
    screen.getByRole("button", { name: "Delete worktree feat-merged" });
    screen.getByRole("button", { name: "Delete worktree feat-pending" });
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
