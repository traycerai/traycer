import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { WorktreeHostEntry } from "@traycer/protocol/host/index";
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

function entry(
  over: Partial<WorktreeHostEntry> & { worktreePath: string; branch: string },
): WorktreeHostEntry {
  return {
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    ...over,
  };
}

const WORKTREES: WorktreeHostEntry[] = [
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

function renderList(args: {
  readonly hostId: string;
  readonly queryClient: QueryClient;
  readonly worktrees: readonly WorktreeHostEntry[];
}) {
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={args.queryClient}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  return render(
    <Wrapper>
      <WorktreesList
        streamClient={stubStreamClient()}
        hostId={args.hostId}
        worktrees={args.worktrees}
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
  });
}

function confirmDelete(branch: string): void {
  fireEvent.click(
    screen.getByRole("button", { name: `Delete worktree ${branch}` }),
  );
  fireEvent.click(screen.getByTestId("confirm-action"));
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
  });

  it("disables delete for an in-use worktree", () => {
    renderDefault();
    const busyButton = screen.getByRole("button", {
      name: /in use by an active chat or agent/i,
    });
    expect(busyButton.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps refresh after repo and selection controls so it does not shift", () => {
    renderDefault();

    expect(toolbarButtonLabels()).toEqual([
      "Collapse all",
      "Select worktrees",
      "Refresh worktrees",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Select worktrees" }));

    expect(toolbarButtonLabels()).toEqual([
      "Collapse all",
      "Select all",
      "Cancel",
      "Delete selected worktrees",
      "Refresh worktrees",
    ]);
    const cancelClassName = screen.getByRole("button", {
      name: "Cancel",
    }).className;
    expect(cancelClassName).not.toContain("bg-destructive");
    expect(cancelClassName).not.toContain("text-destructive");
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
    fireEvent.click(screen.getByRole("button", { name: "Select worktrees" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Select worktrees" }));
    expect(screen.getByText("0 selected")).not.toBeNull();
    expect(
      screen
        .getByTestId("worktrees-list-delete-selected")
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

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
    expect(
      screen
        .getByRole("checkbox", { name: "Select worktree feat-busy" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));

    screen.getByText("Discard 3 uncommitted changes across 2 worktrees?");
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(streamMock.paths).toEqual(["/wt/clean", "/wt/dirty"]);
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
    });

    fireEvent.click(screen.getByRole("button", { name: "Select worktrees" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByTestId("worktrees-list-delete-selected"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(streamMock.paths).toEqual(["/wt/clean", "/wt/dirty"]);
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
    expect(screen.getAllByTestId("worktree-row-deleting-spinner")).toHaveLength(
      3,
    );
    expect(invalidateSpy).not.toHaveBeenCalled();

    act(() => {
      callbacksFor("/wt/api-clean").onComplete(true);
    });
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
    });

    fireEvent.click(screen.getByRole("button", { name: "Select worktrees" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
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
    expect(screen.getByTestId("worktree-delete-error").textContent).toContain(
      "cannot subscribe /wt/api-clean",
    );
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
    });

    confirmDelete("feat-clean");

    // The selector swaps to host-b while the host-a delete is still in
    // flight; the list re-renders with the new host id.
    rendered.rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WorktreesList
            streamClient={stubStreamClient()}
            hostId="host-b"
            worktrees={WORKTREES}
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
    screen.getByText(/Deleting/);
    expect(
      screen.queryByRole("button", { name: "Delete worktree feat-clean" }),
    ).toBeNull();
  });

  it("remembers a backgrounded delete after the list unmounts and remounts", () => {
    const rendered = renderList({
      hostId: "host-a",
      queryClient: new QueryClient(),
      worktrees: WORKTREES,
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
    screen.getByText(/Deleting/);
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
            streamClient={stubStreamClient()}
            hostId="host-a"
            worktrees={WORKTREES.filter(
              (worktree) => worktree.worktreePath !== "/wt/clean",
            )}
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
});
