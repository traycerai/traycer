import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type { OwnerTeardownSnapshot } from "@/lib/worktree/owner-teardown-snapshot";
import { teardownHolderKey } from "@/lib/worktree/owner-teardown-snapshot";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeFolderIntent,
  WorktreeWorkspaceSummaryV15,
} from "@traycer/protocol/host/worktree-schemas";
import type { PreparedWorkspaceFolder } from "@traycer/protocol/host/epic/unary-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";

// ── Hook mocks: the real InEpicSurface pulls host/query/mutation hooks; every
// one is stubbed inert so the surface renders its REAL row-item mapping (the
// thing under test: bound rows must hand `canChangePrimary: false`). ──────────

const FAKE_CLIENT = {
  request: () => new Promise(() => undefined),
  getActiveHostId: () => "host-test",
  getRequestContextUserId: () => "user-test",
  onChange: () => () => undefined,
};
const mutationMocks = vi.hoisted(() => ({
  addBindingFolder: vi.fn(),
  createWorktree: vi.fn().mockResolvedValue({ perEntry: [] }),
  createPending: false,
  recordRecent: vi.fn(),
  removeBindingFolder: vi.fn().mockResolvedValue({}),
}));
const recentMocks = vi.hoisted(() => ({
  prepareRecent: vi.fn(),
  recordRecentAsync: vi.fn(),
}));
const teardownMocks = vi.hoisted(() => ({
  snapshot: vi.fn((_dropped: readonly string[]): OwnerTeardownSnapshot => ({
    holders: [],
    stopTargets: [],
  })),
}));
const teardownStopMocks = vi.hoisted(() => ({
  stopShell: vi.fn().mockResolvedValue({}),
  stopAgent: vi.fn().mockResolvedValue({ stoppedAgentIds: [] }),
}));
const listByPathsMocks = vi.hoisted(() => ({
  workspaces: [] as WorktreeWorkspaceSummaryV15[],
  isLoading: false,
}));
const folderActionsMocks = vi.hoisted(() => ({
  pickAndPrepareFolders: vi.fn(
    (): Promise<{ folders: PreparedWorkspaceFolder[] } | null> =>
      Promise.resolve(null),
  ),
}));
const toastMocks = vi.hoisted(() => ({
  reportableErrorToast: vi.fn(),
}));

const RECENT_FOLDER: PreparedWorkspaceFolder = {
  workspacePath: "/repo/recent",
  workspaceName: "recent",
  repoIdentifier: null,
  repoUrl: null,
};

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => FAKE_CLIENT,
  // Spine and app-wide client are separate exports since redesign P2.1.
  useHostRuntimeClient: () => FAKE_CLIENT,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => FAKE_CLIENT,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-test",
        label: "Test host",
        kind: "local",
        websocketUrl: null,
        version: null,
        transportDialability: "dialable",
      },
    ],
  }),
}));
vi.mock("@/hooks/worktree/use-worktree-list-by-workspace-paths-query", () => ({
  useWorktreeListByWorkspacePathsForClient: () => ({
    data: { workspaces: listByPathsMocks.workspaces },
    isFetching: listByPathsMocks.isLoading,
    isLoading: listByPathsMocks.isLoading,
  }),
}));
vi.mock("@/hooks/worktree/use-owner-teardown-snapshot", () => ({
  useOwnerTeardownSnapshot: () => teardownMocks.snapshot,
}));
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/managed-command/use-managed-command-lifecycle-mutations")
    >()),
    useManagedCommandStop: () => ({
      mutateAsync: teardownStopMocks.stopShell,
      isPending: false,
    }),
  }),
);
vi.mock("@/hooks/agent/use-stop-agent-mutation", () => ({
  useAgentStop: () => ({
    mutateAsync: teardownStopMocks.stopAgent,
    isPending: false,
  }),
}));
vi.mock("@/hooks/worktree/use-worktree-workspaces-refresh", () => ({
  useWorktreeWorkspacesRefresh: () => ({
    refresh: () => Promise.resolve(),
    isRefreshing: false,
    checkedAt: null,
    canRefresh: false,
    verifyFailed: false,
    refreshGeneration: 0,
  }),
}));
vi.mock("@/hooks/worktree/use-worktree-set-entry-mode-mutation", () => ({
  useWorktreeSetEntryModeForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));
vi.mock("@/hooks/worktree/use-worktree-import-mutation", () => ({
  useWorktreeImportForClient: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/worktree/use-worktree-create-mutation", () => ({
  useWorktreeCreateForClient: () => ({
    mutate: mutationMocks.createWorktree,
    mutateAsync: mutationMocks.createWorktree,
    isPending: mutationMocks.createPending,
  }),
}));
vi.mock(
  "@/hooks/workspace/use-workspace-binding-remove-entry-mutation",
  () => ({
    useWorkspaceBindingRemoveEntryForClient: () => ({
      mutate: mutationMocks.removeBindingFolder,
      mutateAsync: mutationMocks.removeBindingFolder,
      isPending: false,
    }),
    usePendingRemoveBindingEntryPaths: () => new Set<string>(),
  }),
);
vi.mock("@/hooks/workspace/use-workspace-binding-add-folder-mutation", () => ({
  useWorkspaceBindingAddFolderForClient: () => ({
    mutateAsync: mutationMocks.addBindingFolder,
    isPending: false,
  }),
}));
vi.mock(
  "@/hooks/workspace/use-workspace-record-recent-workspace-mutation",
  () => ({
    useWorkspaceRecordRecentWorkspace: () => ({
      mutate: mutationMocks.recordRecent,
      mutateAsync: recentMocks.recordRecentAsync,
    }),
  }),
);
vi.mock("@/hooks/workspace/use-workspace-list-recent-workspaces-query", () => ({
  useWorkspaceListRecentWorkspaces: () => ({
    data: {
      recentWorkspaces: [
        {
          path: RECENT_FOLDER.workspacePath,
          lastOpenedAt: "2026-08-20T00:00:00.000Z",
        },
      ],
    },
  }),
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => ({ major: 1, minor: 2 }),
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  // Host-parametric clone create (redesign P1.2, D6): the panel now runs the
  // clone on the target host's own client via this hook, not the app-wide one.
  useEpicCreateChatForHostClient: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));
vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({
    folders: [],
    isLoading: false,
    isFetching: false,
  }),
}));
vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  useWorkspaceFolderActionsForClient: () => ({
    pickAndPrepareFolders: folderActionsMocks.pickAndPrepareFolders,
    isPreparing: false,
  }),
  preparedWorkspaceFolderToWorkspaceFolderInfo: (value: unknown) => value,
}));
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: () => [],
}));
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: undefined, isLoading: false }),
  useHostMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: recentMocks.prepareRecent,
    isPending: false,
  }),
}));
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [
          hostScopeOptionFixture({
            hostId: "host-test",
            name: "Test host",
          }),
        ],
        activeHostId: "host-test",
      }),
  };
});
vi.mock("@/hooks/auth/use-registered-hosts-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/auth/use-registered-hosts-query")
  >()),
  useRegisteredHostsPollLiveness: () => undefined,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));
vi.mock("@/lib/epic-selectors", () => ({
  useChatById: () => null,
}));
vi.mock("@/components/home/worktree/worktree-scripts-dialog", () => ({
  WorktreeScriptsDialog: () => null,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsMutating: () => 0,
}));
vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: (
    message: unknown,
    options: unknown,
    context: unknown,
  ): void => {
    toastMocks.reportableErrorToast(message, options, context);
  },
}));
// Always-open passthrough so Location menu items are queryable without
// fighting Radix pointer-open in jsdom (same mock as folder-controls).
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
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: (props: {
      readonly children: ReactNode;
      readonly "data-testid"?: string;
    }) => <div data-testid={props["data-testid"]}>{props.children}</div>,
    DropdownMenuItem: item,
    DropdownMenuLabel: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    DropdownMenuSub: passthrough,
    DropdownMenuSubTrigger: item,
    DropdownMenuSubContent: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    DropdownMenuPortal: passthrough,
  };
});

import { HostWorkspaceSelector } from "../host-workspace-selector";

function bindingEntry(input: {
  readonly workspacePath: string;
  readonly isPrimary: boolean;
}): WorktreeBindingEntry {
  return {
    workspacePath: input.workspacePath,
    mode: "local",
    repoIdentifier: null,
    worktreePath: null,
    branch: "main",
    isPrimary: input.isPrimary,
    isImported: false,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt: 0,
    ownedSubmodules: [],
  };
}

const BINDING: WorktreeBinding = {
  entries: [
    bindingEntry({ workspacePath: "/repo/alpha", isPrimary: false }),
    bindingEntry({ workspacePath: "/repo/beta", isPrimary: true }),
  ],
};
const THREE_FOLDER_BINDING: WorktreeBinding = {
  entries: [
    bindingEntry({ workspacePath: "/repo/alpha", isPrimary: false }),
    bindingEntry({ workspacePath: "/repo/gamma", isPrimary: false }),
    bindingEntry({ workspacePath: "/repo/beta", isPrimary: true }),
  ],
};

function BoundSurfaceTree(props: {
  readonly kind: "chat" | "terminal-agent";
  readonly bindingResolved: boolean;
  readonly onBindingCommitted: ((paths: ReadonlyArray<string>) => void) | null;
  readonly binding: WorktreeBinding;
  readonly nonce: number;
}) {
  void props.nonce;
  return (
    <TooltipProvider>
      <HostWorkspaceSelector
        disabled={false}
        surface={{
          kind: props.kind,
          hostId: "host-test",
          epicId: "epic-1",
          tabId: "tab-1",
          ownerId: "owner-1",
          binding: props.binding,
          isOwnerActive: false,
          hasActiveTurn: false,
          ownerLabel: "Owner",
          missingWorktreePaths: [],
          bindingResolved: props.bindingResolved,
          onBindingCommitted: props.onBindingCommitted,
          onForkOnHost: null,
        }}
      />
    </TooltipProvider>
  );
}

function renderBoundSurface(
  kind: "chat" | "terminal-agent",
  bindingResolved: boolean,
  onBindingCommitted: ((paths: ReadonlyArray<string>) => void) | null = null,
  binding: WorktreeBinding = BINDING,
): { rerenderSurface: () => void } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let nonce = 0;
  const tree = (nextNonce: number) => (
    <QueryClientProvider client={queryClient}>
      <BoundSurfaceTree
        kind={kind}
        bindingResolved={bindingResolved}
        onBindingCommitted={onBindingCommitted}
        binding={binding}
        nonce={nextNonce}
      />
    </QueryClientProvider>
  );
  const view = render(tree(nonce));
  return {
    rerenderSurface: () => {
      nonce += 1;
      view.rerender(tree(nonce));
    },
  };
}

beforeEach(() => {
  recentMocks.prepareRecent.mockResolvedValue({ folders: [RECENT_FOLDER] });
  recentMocks.recordRecentAsync.mockResolvedValue({});
  mutationMocks.createWorktree.mockResolvedValue({ perEntry: [] });
  mutationMocks.removeBindingFolder.mockResolvedValue({});
  teardownStopMocks.stopShell.mockResolvedValue({});
  teardownStopMocks.stopAgent.mockResolvedValue({ stoppedAgentIds: [] });
  teardownMocks.snapshot.mockImplementation(() => ({
    holders: [],
    stopTargets: [],
  }));
});

afterEach(() => {
  cleanup();
  mutationMocks.addBindingFolder.mockReset();
  mutationMocks.createWorktree.mockReset();
  mutationMocks.recordRecent.mockReset();
  mutationMocks.removeBindingFolder.mockReset();
  teardownStopMocks.stopShell.mockReset();
  teardownStopMocks.stopAgent.mockReset();
  teardownMocks.snapshot.mockReset();
  listByPathsMocks.workspaces = [];
  listByPathsMocks.isLoading = false;
  mutationMocks.createPending = false;
  folderActionsMocks.pickAndPrepareFolders.mockReset();
  folderActionsMocks.pickAndPrepareFolders.mockResolvedValue(null);
  toastMocks.reportableErrorToast.mockReset();
  recentMocks.prepareRecent.mockReset();
  recentMocks.recordRecentAsync.mockReset();
  useWorktreeIntentStagingStore.getState().resetForTests();
});

describe.each(["chat", "terminal-agent"] as const)(
  "InEpicSurface (%s owner)",
  (kind) => {
    it("renders the primary pin read-only and offers NO Set-as-primary action on any bound row", async () => {
      renderBoundSurface(kind, true);

      // Open the folder-rows popover from the collapsed summary.
      fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
      const rows = await screen.findAllByTestId("folder-row");
      expect(rows).toHaveLength(2);

      // The filled pin marks the bound primary (read-only display)...
      expect(screen.getByTestId("folder-primary-pin")).toBeTruthy();
      // ...and the collapsed chip agreed with it (isPrimary, not items[0]).
      expect(
        screen.getByRole("button", { name: /^beta/ }).textContent,
      ).toContain("beta");

      // No atomic set-primary RPC exists for a live binding - the action
      // must be absent on EVERY row of a bound surface.
      expect(screen.queryByTestId("folder-make-primary")).toBeNull();
      // The other row actions are still there (the rows are editable).
      expect(
        screen.getAllByRole("button", { name: /^(?:Move|Remove) / }).length,
      ).toBeGreaterThan(0);
    });
  },
);

it("explains why a terminal agent's host selector is locked", async () => {
  renderBoundSurface("terminal-agent", true);

  const switcher = screen.getByRole("button", { name: "Host: Test host" });
  expect(switcher.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(switcher);
  expect(screen.queryByTestId("settings-host-switcher-list")).toBeNull();
  await userEvent.setup().tab();
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "Terminal host is fixed",
  );
});

it("uses the shared host switcher for a live chat", () => {
  renderBoundSurface("chat", true);

  const switcher = screen.getByRole("button", { name: "Host: Test host" });
  const switcherSlot = switcher.parentElement?.parentElement;
  expect(switcherSlot?.className).toContain("flex-[0_1_auto]");
  expect(switcherSlot?.className).toContain("max-w-[min(50%,50vw)]");
  expect(switcher.className).toContain("w-fit");
  expect(switcher.className).toContain("max-w-full");

  fireEvent.click(switcher);
  expect(screen.getByRole("option", { name: /Test host/ })).toBeTruthy();
  expect(screen.queryByTestId("composer-host-popover")).toBeNull();
});

it("shows Recent folders in a live chat picker but not a terminal-agent binding", async () => {
  renderBoundSurface("chat", true);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  expect(
    await screen.findByRole("button", { name: "Recent folders, 1" }),
  ).toBeTruthy();

  cleanup();
  renderBoundSurface("terminal-agent", true);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  expect(
    screen.queryByRole("button", { name: "Recent folders, 1" }),
  ).toBeNull();
});

it("keeps Recent unavailable until a chat binding snapshot resolves", () => {
  renderBoundSurface("chat", false);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));

  expect(
    screen.queryByRole("button", { name: "Recent folders, 1" }),
  ).toBeNull();
});

it("adds a Recent folder through the chat owner binding", async () => {
  mutationMocks.addBindingFolder.mockResolvedValue({});
  renderBoundSurface("chat", true);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Recent folders, 1" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Add recent to context" }),
  );

  await waitFor(() => {
    expect(mutationMocks.addBindingFolder).toHaveBeenCalledWith({
      epicId: "epic-1",
      ownerId: "owner-1",
      ownerKind: "chat",
      workspacePath: "/repo/recent",
    });
  });
});

it("removes a chat folder only after moving it to Recent succeeds", async () => {
  renderBoundSurface("chat", true);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  fireEvent.click(
    (
      await screen.findAllByRole("button", {
        name: /^(?:Move|Remove) alpha(?: to Recent)?$/,
      })
    )[0],
  );

  await waitFor(() => {
    expect(recentMocks.recordRecentAsync).toHaveBeenCalledWith({
      path: "/repo/alpha",
      bumpRecency: false,
      failureFeedback: "move_warning",
    });
    expect(mutationMocks.removeBindingFolder).toHaveBeenCalledTimes(1);
  });

  cleanup();
  recentMocks.recordRecentAsync.mockRejectedValueOnce(new Error("nope"));
  mutationMocks.removeBindingFolder.mockClear();
  renderBoundSurface("chat", true);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  fireEvent.click(
    (
      await screen.findAllByRole("button", {
        name: /^(?:Move|Remove) alpha(?: to Recent)?$/,
      })
    )[0],
  );

  await waitFor(() => {
    expect(recentMocks.recordRecentAsync).toHaveBeenCalledWith({
      path: "/repo/alpha",
      bumpRecency: false,
      failureFeedback: "move_warning",
    });
  });
  expect(mutationMocks.removeBindingFolder).not.toHaveBeenCalled();
});

it("refuses terminal Update when metadata regresses to unresolved", async () => {
  const key = {
    surface: "owner" as const,
    hostId: "host-test",
    epicId: "epic-1",
    ownerKind: "terminal-agent" as const,
    ownerId: "owner-1",
  };
  useWorktreeIntentStagingStore.getState().stageIntent(key, {
    entries: [
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo/alpha",
        repoIdentifier: null,
        isPrimary: false,
        branch: {
          type: "new",
          name: "feat-unresolved",
          source: "main",
          carryUncommittedChanges: false,
        },
      },
    ],
  });

  renderBoundSurface("terminal-agent", true);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  const update = await screen.findByRole("button", { name: "Update" });
  fireEvent.click(update);

  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();
  expect(
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(key)
    ],
  ).toBeDefined();
});

const TERMINAL_STAGING_KEY = {
  surface: "owner" as const,
  hostId: "host-test",
  epicId: "epic-1",
  ownerKind: "terminal-agent" as const,
  ownerId: "owner-1",
};
const CHAT_STAGING_KEY = {
  surface: "owner" as const,
  hostId: "host-test",
  epicId: "epic-1",
  ownerKind: "chat" as const,
  ownerId: "owner-1",
};

function shellHolder(
  label: string,
  ownerKind: WorktreeBusyHolder["ownerRef"]["ownerKind"] = "terminal-agent",
): WorktreeBusyHolder {
  return {
    ownerRef: {
      epicId: "epic-1",
      ownerKind,
      ownerId: "owner-1",
    },
    holdKind: "supervised-shell",
    activity: "working",
    label,
  };
}

function chatTurnHolder(label: string): WorktreeBusyHolder {
  return {
    ownerRef: {
      epicId: "epic-1",
      ownerKind: "chat",
      ownerId: "owner-1",
    },
    holdKind: "chat-turn",
    activity: "working",
    label,
  };
}

function shellSnapshot(
  label: string,
  commandId = "sh-1",
  ownerKind: WorktreeBusyHolder["ownerRef"]["ownerKind"] = "terminal-agent",
): OwnerTeardownSnapshot {
  const holder = shellHolder(label, ownerKind);
  return {
    holders: [{ ...holder, holderKey: teardownHolderKey(holder) }],
    stopTargets: [
      {
        kind: "supervised-shell",
        commandId,
        holderKey: teardownHolderKey(holder),
      },
    ],
  };
}

function newWorktreeIntent(
  workspacePath: string,
  branchName: string,
): WorktreeFolderIntent {
  return {
    kind: "worktree",
    scripts: null,
    workspacePath,
    repoIdentifier: null,
    isPrimary: false,
    branch: {
      type: "new",
      name: branchName,
      source: "main",
      carryUncommittedChanges: false,
    },
  };
}

function resolvedSummary(workspacePath: string): WorktreeWorkspaceSummaryV15 {
  return {
    workspacePath,
    isGitRepo: true,
    repoIdentifier: { owner: "acme", repo: "app" },
    mainBranch: "main",
    worktrees: [
      {
        worktreePath: workspacePath,
        branch: "main",
        head: null,
        isMain: true,
        isLocked: false,
      },
    ],
    scripts: null,
    repoBranchPrefix: { status: "absent" },
    resolvedAt: 1,
    presence: "present",
  };
}

function seedResolvedBindingMetadata(): void {
  listByPathsMocks.workspaces = [
    resolvedSummary("/repo/alpha"),
    resolvedSummary("/repo/beta"),
  ];
}

async function openTerminalFolderPopover(): Promise<{
  rerenderSurface: () => void;
}> {
  const view = renderBoundSurface("terminal-agent", true);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  await screen.findAllByTestId("folder-row");
  return view;
}

it("stages a TUI folder removal and discloses a shell under it on Update", async () => {
  teardownMocks.snapshot.mockImplementation((dropped: readonly string[]) =>
    dropped.includes("/repo/alpha")
      ? shellSnapshot("npm run dev")
      : { holders: [], stopTargets: [] },
  );

  await openTerminalFolderPopover();
  fireEvent.click(screen.getByRole("button", { name: "Remove alpha" }));

  expect(mutationMocks.removeBindingFolder).not.toHaveBeenCalled();

  fireEvent.click(await screen.findByRole("button", { name: "Update" }));

  expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();
  expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
    "npm run dev",
  );
  expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
    "Shell",
  );
  expect(teardownMocks.snapshot).toHaveBeenCalledWith(["/repo/alpha"]);

  fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

  await waitFor(() => {
    expect(mutationMocks.removeBindingFolder).toHaveBeenCalledWith({
      epicId: "epic-1",
      ownerId: "owner-1",
      ownerKind: "terminal-agent",
      workspacePath: "/repo/alpha",
    });
  });
  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();
});

it("re-discloses when TUI staging mutates under an open confirmation", async () => {
  seedResolvedBindingMetadata();
  teardownMocks.snapshot.mockImplementation(() => shellSnapshot("npm run dev"));
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });

  await openTerminalFolderPopover();
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();

  act(() => {
    useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
      entries: [newWorktreeIntent("/repo/alpha", "feat-b")],
    });
  });

  fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

  expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();
  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

  await waitFor(() => {
    expect(mutationMocks.createWorktree).toHaveBeenCalledTimes(1);
  });
  const createArg = mutationMocks.createWorktree.mock.calls[0]?.[0] as {
    readonly entries: ReadonlyArray<{
      readonly branch?: { readonly name?: string };
    }>;
  };
  expect(createArg.entries[0]?.branch?.name).toBe("feat-b");
});

it("commits the disclosed TUI draft when staging is unchanged", async () => {
  seedResolvedBindingMetadata();
  teardownMocks.snapshot.mockImplementation(() => shellSnapshot("npm run dev"));
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });

  await openTerminalFolderPopover();
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();

  fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

  await waitFor(() => {
    expect(mutationMocks.createWorktree).toHaveBeenCalledTimes(1);
  });
  const createArg = mutationMocks.createWorktree.mock.calls[0]?.[0] as {
    readonly entries: ReadonlyArray<{
      readonly branch?: { readonly name?: string };
    }>;
  };
  expect(createArg.entries[0]?.branch?.name).toBe("feat-a");
});

function deferredValue(): {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
} {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function drainMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  });
}

it("awaits a disclosed shell stop before worktree.create", async () => {
  seedResolvedBindingMetadata();
  teardownMocks.snapshot.mockImplementation(() => shellSnapshot("npm run dev"));
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });
  const stop = deferredValue();
  teardownStopMocks.stopShell.mockImplementation(() => stop.promise);

  await openTerminalFolderPopover();
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  fireEvent.click(await screen.findByTestId("teardown-commit-immediate"));

  await waitFor(() => {
    expect(teardownStopMocks.stopShell).toHaveBeenCalledWith({
      hostId: "host-test",
      epicId: "epic-1",
      commandId: "sh-1",
    });
  });
  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();

  act(() => {
    stop.resolve({});
  });
  await waitFor(() => {
    expect(mutationMocks.createWorktree).toHaveBeenCalledTimes(1);
  });
});

it("keeps the dialog open and skips create when a disclosed stop fails", async () => {
  seedResolvedBindingMetadata();
  teardownMocks.snapshot.mockImplementation(() => shellSnapshot("npm run dev"));
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });
  teardownStopMocks.stopShell.mockRejectedValue(
    new Error("shell still running"),
  );

  await openTerminalFolderPopover();
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  fireEvent.click(await screen.findByTestId("teardown-commit-immediate"));

  expect(
    (await screen.findByTestId("teardown-holder-failure")).textContent,
  ).toBe("shell still running");
  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();
});

it("discloses idle-chat folder removal when a live shell is under the folder", async () => {
  teardownMocks.snapshot.mockImplementation((dropped: readonly string[]) =>
    dropped.includes("/repo/alpha")
      ? shellSnapshot("npm run dev", "sh-1", "chat")
      : { holders: [], stopTargets: [] },
  );

  renderBoundSurface("chat", true);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  fireEvent.click(
    (
      await screen.findAllByRole("button", {
        name: /^(?:Move|Remove) alpha(?: to Recent)?$/,
      })
    )[0],
  );

  expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();
  expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
    "npm run dev",
  );
  expect(mutationMocks.removeBindingFolder).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("teardown-commit-immediate"));
  await waitFor(() => {
    expect(teardownStopMocks.stopShell).toHaveBeenCalled();
  });
  await waitFor(() => {
    expect(mutationMocks.removeBindingFolder).toHaveBeenCalledWith({
      epicId: "epic-1",
      ownerId: "owner-1",
      ownerKind: "chat",
      workspacePath: "/repo/alpha",
    });
  });
});

it("keeps a newer TUI draft after an in-flight commit of an older capture", async () => {
  seedResolvedBindingMetadata();
  let releaseCreate: ((value: unknown) => void) | null = null;
  mutationMocks.createWorktree.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseCreate = resolve;
      }),
  );
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });

  await openTerminalFolderPopover();
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  await waitFor(() => {
    expect(mutationMocks.createWorktree).toHaveBeenCalledTimes(1);
  });

  act(() => {
    useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
      entries: [newWorktreeIntent("/repo/alpha", "feat-b")],
    });
  });
  act(() => {
    releaseCreate?.({
      perEntry: [
        {
          workspacePath: "/repo/alpha",
          ok: true,
          worktreePath: "/wt/alpha",
          branch: "feat-a",
          errorMessage: null,
        },
      ],
    });
  });

  await waitFor(() => {
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(TERMINAL_STAGING_KEY)
      ]?.entries[0],
    ).toMatchObject({ branch: { name: "feat-b" } });
  });
});

it("stops a chat turn once and does not re-stop expanded agent.stop-consequence shells", async () => {
  seedResolvedBindingMetadata();
  const turn = chatTurnHolder(
    "Owner is working. Stopping the agent also stops its background shells and clears queued messages",
  );
  const shell = shellHolder("sleep 1", "chat");
  teardownMocks.snapshot.mockImplementation(() => ({
    holders: [
      { ...turn, holderKey: teardownHolderKey(turn) },
      { ...shell, holderKey: teardownHolderKey(shell) },
    ],
    stopTargets: [
      {
        kind: "chat-turn",
        holderKey: teardownHolderKey(turn),
      },
    ],
  }));
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });

  await openTerminalFolderPopover();
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();
  expect(screen.getByTestId("teardown-disclosure").textContent).toContain(
    "sleep 1",
  );
  fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

  await waitFor(() => {
    expect(teardownStopMocks.stopAgent).toHaveBeenCalledTimes(1);
  });
  expect(teardownStopMocks.stopShell).not.toHaveBeenCalled();
  await waitFor(() => {
    expect(mutationMocks.createWorktree).toHaveBeenCalledTimes(1);
  });
});

it("does not apply a cancelled teardown after a newer confirm starts", async () => {
  seedResolvedBindingMetadata();
  teardownMocks.snapshot.mockImplementation(() => shellSnapshot("npm run dev"));
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });
  const firstStop = deferredValue();
  const secondStop = deferredValue();
  teardownStopMocks.stopShell
    .mockImplementationOnce(() => firstStop.promise)
    .mockImplementationOnce(() => secondStop.promise);

  await openTerminalFolderPopover();
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  fireEvent.click(await screen.findByTestId("teardown-commit-immediate"));
  await waitFor(() => {
    expect(teardownStopMocks.stopShell).toHaveBeenCalledTimes(1);
  });
  fireEvent.click(screen.getByTestId("teardown-commit-cancel"));

  act(() => {
    useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
      entries: [newWorktreeIntent("/repo/alpha", "feat-b")],
    });
  });
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  await screen.findAllByTestId("folder-row");
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  fireEvent.click(await screen.findByTestId("teardown-commit-immediate"));
  await waitFor(() => {
    expect(teardownStopMocks.stopShell).toHaveBeenCalledTimes(2);
  });

  act(() => {
    firstStop.resolve({});
  });
  await drainMicrotasks();
  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();

  act(() => {
    secondStop.resolve({});
  });
  await waitFor(() => {
    expect(mutationMocks.createWorktree).toHaveBeenCalledTimes(1);
  });
  const createArg = mutationMocks.createWorktree.mock.calls[0]?.[0] as {
    readonly entries: ReadonlyArray<{
      readonly branch?: { readonly name?: string };
    }>;
  };
  expect(createArg.entries[0]?.branch?.name).toBe("feat-b");
});

it("does not stop holders when a staged create cannot apply after confirm", async () => {
  seedResolvedBindingMetadata();
  teardownMocks.snapshot.mockImplementation(() => shellSnapshot("npm run dev"));
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });

  await openTerminalFolderPopover();
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();
  act(() => {
    useWorktreeIntentStagingStore
      .getState()
      .setSuspendedWorkspacePaths(TERMINAL_STAGING_KEY, ["/repo/alpha"]);
  });
  fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

  expect(await screen.findByTestId("teardown-commit-refusal")).toBeTruthy();
  expect(teardownStopMocks.stopShell).not.toHaveBeenCalled();
  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();
});

it("does not apply remove or create if the user cancels during in-flight teardown", async () => {
  seedResolvedBindingMetadata();
  teardownMocks.snapshot.mockImplementation(() => shellSnapshot("npm run dev"));
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });
  const stop = deferredValue();
  teardownStopMocks.stopShell.mockImplementation(() => stop.promise);

  await openTerminalFolderPopover();
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  fireEvent.click(await screen.findByTestId("teardown-commit-immediate"));
  await waitFor(() => {
    expect(teardownStopMocks.stopShell).toHaveBeenCalled();
  });
  fireEvent.click(screen.getByTestId("teardown-commit-cancel"));
  act(() => {
    stop.resolve({});
  });
  await drainMicrotasks();
  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();
  expect(mutationMocks.removeBindingFolder).not.toHaveBeenCalled();
  expect(
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(TERMINAL_STAGING_KEY)
    ]?.entries[0],
  ).toMatchObject({ branch: { name: "feat-a" } });
});

it("applies only the disclosed folder removal and leaves a staged draft intact", async () => {
  teardownMocks.snapshot.mockImplementation((dropped: readonly string[]) =>
    dropped.includes("/repo/beta")
      ? shellSnapshot("npm run dev", "sh-1", "chat")
      : { holders: [], stopTargets: [] },
  );
  useWorktreeIntentStagingStore.getState().stageIntent(CHAT_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });

  renderBoundSurface("chat", true);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  fireEvent.click(
    (
      await screen.findAllByRole("button", {
        name: /^(?:Move|Remove) beta(?: to Recent)?$/,
      })
    )[0],
  );
  expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();
  fireEvent.click(screen.getByTestId("teardown-commit-immediate"));

  await waitFor(() => {
    expect(mutationMocks.removeBindingFolder).toHaveBeenCalledWith({
      epicId: "epic-1",
      ownerId: "owner-1",
      ownerKind: "chat",
      workspacePath: "/repo/beta",
    });
  });
  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();
  expect(
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(CHAT_STAGING_KEY)
    ]?.entries[0],
  ).toMatchObject({
    workspacePath: "/repo/alpha",
    branch: { name: "feat-a" },
  });
});

it("restores a same-folder draft when a removal disclosure is dismissed", async () => {
  teardownMocks.snapshot.mockImplementation((dropped: readonly string[]) =>
    dropped.includes("/repo/alpha")
      ? shellSnapshot("npm run dev", "sh-1", "chat")
      : { holders: [], stopTargets: [] },
  );
  useWorktreeIntentStagingStore.getState().stageIntent(CHAT_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });

  renderBoundSurface("chat", true);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  fireEvent.click(
    (
      await screen.findAllByRole("button", {
        name: /^(?:Move|Remove) alpha(?: to Recent)?$/,
      })
    )[0],
  );
  expect(await screen.findByTestId("teardown-commit-dialog")).toBeTruthy();
  expect(screen.queryByTestId("teardown-commit-defer")).toBeNull();
  fireEvent.click(screen.getByTestId("teardown-commit-cancel"));

  expect(mutationMocks.removeBindingFolder).not.toHaveBeenCalled();
  expect(
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(CHAT_STAGING_KEY)
    ]?.entries[0],
  ).toMatchObject({
    workspacePath: "/repo/alpha",
    branch: { name: "feat-a" },
  });
});

it("keeps location selection enabled while the workspace snapshot is loading", async () => {
  seedResolvedBindingMetadata();
  listByPathsMocks.isLoading = true;
  await openTerminalFolderPopover();
  const triggers = await screen.findAllByTestId("folder-location-trigger");
  expect(triggers.length).toBeGreaterThan(0);
  for (const trigger of triggers) {
    expect(trigger instanceof HTMLButtonElement && trigger.disabled).toBe(
      false,
    );
  }
});

it("keeps location selection enabled while a folder Update is in flight", async () => {
  seedResolvedBindingMetadata();
  mutationMocks.createPending = true;
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });
  await openTerminalFolderPopover();
  const update = await screen.findByTestId("folder-update");
  expect(update instanceof HTMLButtonElement && update.disabled).toBe(true);
  const triggers = screen.getAllByTestId("folder-location-trigger");
  expect(triggers.length).toBeGreaterThan(0);
  for (const trigger of triggers) {
    expect(trigger instanceof HTMLButtonElement && trigger.disabled).toBe(
      false,
    );
  }
});

it("stages a location change from the last resolved snapshot while a refresh is pending", async () => {
  seedResolvedBindingMetadata();
  const view = await openTerminalFolderPopover();
  listByPathsMocks.workspaces = listByPathsMocks.workspaces.map(
    (workspace) => ({
      ...workspace,
      resolvedAt: null,
      isGitRepo: false,
    }),
  );
  listByPathsMocks.isLoading = true;
  view.rerenderSurface();
  const alphaRow = screen
    .getAllByTestId("folder-row")
    .find((row) => row.getAttribute("data-path") === "/repo/alpha");
  expect(alphaRow).toBeTruthy();
  if (alphaRow === undefined) return;
  fireEvent.click(within(alphaRow).getByTestId("folder-location-trigger"));
  fireEvent.click(within(alphaRow).getByTestId("folder-location-worktree"));
  expect(
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(TERMINAL_STAGING_KEY)
    ]?.entries[0],
  ).toMatchObject({
    workspacePath: "/repo/alpha",
    kind: "worktree",
  });
});

it("acknowledges a captured create that committed after Discard cancelled the run", async () => {
  seedResolvedBindingMetadata();
  const onBindingCommitted = vi.fn();
  let releaseCreate:
    | ((value: { perEntry: readonly unknown[] }) => void)
    | null = null;
  mutationMocks.createWorktree.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseCreate = resolve;
      }),
  );
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });
  renderBoundSurface("terminal-agent", true, onBindingCommitted);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  await waitFor(() => {
    expect(mutationMocks.createWorktree).toHaveBeenCalled();
  });
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  const discard = await screen.findByTestId("folder-discard-staged");
  expect(discard instanceof HTMLButtonElement).toBe(true);
  if (!(discard instanceof HTMLButtonElement)) return;
  expect(discard.disabled).toBe(true);
  fireEvent.click(discard);
  expect(
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(TERMINAL_STAGING_KEY)
    ],
  ).toBeDefined();
  act(() => {
    releaseCreate?.({
      perEntry: [
        {
          workspacePath: "/repo/alpha",
          ok: true,
          worktreePath: "/wt/feat-a",
          branch: "feat-a",
          errorMessage: null,
        },
      ],
    });
  });
  await waitFor(() => {
    expect(onBindingCommitted).toHaveBeenCalledWith(["/repo/alpha"]);
  });
  expect(
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(TERMINAL_STAGING_KEY)
    ],
  ).toBeUndefined();
});

it("acknowledges a host-committed folder removal even if Discard cancelled the run", async () => {
  seedResolvedBindingMetadata();
  const onBindingCommitted = vi.fn();
  let releaseRemove: ((value: unknown) => void) | null = null;
  mutationMocks.removeBindingFolder.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseRemove = resolve;
      }),
  );
  renderBoundSurface("terminal-agent", true, onBindingCommitted);
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove alpha" }));
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  await waitFor(() => {
    expect(mutationMocks.removeBindingFolder).toHaveBeenCalledWith({
      epicId: "epic-1",
      ownerId: "owner-1",
      ownerKind: "terminal-agent",
      workspacePath: "/repo/alpha",
    });
  });
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  fireEvent.click(await screen.findByTestId("folder-discard-staged"));
  act(() => {
    releaseRemove?.({});
  });
  await waitFor(() => {
    expect(onBindingCommitted).toHaveBeenCalledWith(["/repo/alpha"]);
  });
  expect(
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(TERMINAL_STAGING_KEY)
    ],
  ).toBeUndefined();
});

it("disables Discard while a captured folder commit is in flight", async () => {
  seedResolvedBindingMetadata();
  mutationMocks.removeBindingFolder.mockImplementation(
    () => new Promise(() => undefined),
  );
  await openTerminalFolderPopover();
  fireEvent.click(screen.getByRole("button", { name: "Remove alpha" }));
  expect(screen.getByTestId("folder-discard-staged")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  await waitFor(() => {
    expect(mutationMocks.removeBindingFolder).toHaveBeenCalled();
  });
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  await screen.findAllByTestId("folder-row");
  const discard = screen.getByTestId("folder-discard-staged");
  expect(discard.getAttribute("aria-disabled")).toBe("true");
  expect(discard.className).toContain("pointer-events-none");
});

it("preserves dirty-without-resume after Discard of a staged overlay", async () => {
  seedResolvedBindingMetadata();
  folderActionsMocks.pickAndPrepareFolders.mockResolvedValue({
    folders: [
      {
        workspacePath: "/repo/gamma",
        workspaceName: "gamma",
        repoIdentifier: { owner: "acme", repo: "app" },
        repoUrl: null,
      },
    ],
  });
  mutationMocks.addBindingFolder.mockResolvedValue({});
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });
  await openTerminalFolderPopover();
  fireEvent.click(screen.getByTestId("folder-add"));
  await waitFor(() => {
    expect(mutationMocks.addBindingFolder).toHaveBeenCalledWith({
      epicId: "epic-1",
      ownerId: "owner-1",
      ownerKind: "terminal-agent",
      workspacePath: "/repo/gamma",
    });
  });
  fireEvent.click(await screen.findByTestId("folder-discard-staged"));
  expect(
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(TERMINAL_STAGING_KEY)
    ],
  ).toBeUndefined();
  const update = screen.getByTestId("folder-update");
  expect(update instanceof HTMLButtonElement && update.disabled).toBe(false);
});

it("discards a staged location draft without a host RPC", async () => {
  seedResolvedBindingMetadata();
  useWorktreeIntentStagingStore.getState().stageIntent(TERMINAL_STAGING_KEY, {
    entries: [newWorktreeIntent("/repo/alpha", "feat-a")],
  });
  await openTerminalFolderPopover();
  fireEvent.click(await screen.findByTestId("folder-discard-staged"));
  expect(
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(TERMINAL_STAGING_KEY)
    ],
  ).toBeUndefined();
  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();
  expect(mutationMocks.removeBindingFolder).not.toHaveBeenCalled();
  expect(screen.queryByTestId("workspace-summary-draft")).toBeNull();
});

it("discards a staged folder removal without a host RPC", async () => {
  await openTerminalFolderPopover();
  fireEvent.click(screen.getByRole("button", { name: "Remove alpha" }));
  expect(mutationMocks.removeBindingFolder).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByTestId("folder-discard-staged"));
  expect(mutationMocks.removeBindingFolder).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Remove alpha" })).toBeTruthy();
});

async function openThreeFolderTerminalPopover(
  onBindingCommitted: ((paths: ReadonlyArray<string>) => void) | null = null,
): Promise<void> {
  renderBoundSurface(
    "terminal-agent",
    true,
    onBindingCommitted,
    THREE_FOLDER_BINDING,
  );
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  await screen.findAllByTestId("folder-row");
}

async function stageTwoFolderRemovalsAndUpdate(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Remove alpha" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove gamma" }));
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
}

it("settles and keeps both staged removals when the first folder rejects", async () => {
  const onBindingCommitted = vi.fn();
  mutationMocks.removeBindingFolder.mockRejectedValueOnce(
    new Error("folder in use"),
  );
  await openThreeFolderTerminalPopover(onBindingCommitted);
  await stageTwoFolderRemovalsAndUpdate();
  await waitFor(() => {
    expect(mutationMocks.removeBindingFolder).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(toastMocks.reportableErrorToast).toHaveBeenCalled();
  });
  expect(onBindingCommitted).not.toHaveBeenCalled();
  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();
  const firstToast = toastMocks.reportableErrorToast.mock.calls[0];
  expect(String(firstToast[0])).toContain("alpha");
  expect(firstToast[2]).toMatchObject({
    title: "Workspace update incomplete",
  });
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  const discard = await screen.findByTestId("folder-discard-staged");
  expect(discard.getAttribute("aria-disabled")).toBeNull();
  const update = screen.getByTestId("folder-update");
  expect(update instanceof HTMLButtonElement && update.disabled).toBe(false);
  mutationMocks.removeBindingFolder.mockClear();
  mutationMocks.removeBindingFolder.mockResolvedValue({});
  fireEvent.click(update);
  await waitFor(() => {
    expect(mutationMocks.removeBindingFolder).toHaveBeenCalledTimes(2);
  });
});

it("acknowledges a committed earlier removal when a later folder rejects", async () => {
  const onBindingCommitted = vi.fn();
  mutationMocks.removeBindingFolder
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("folder in use"));
  await openThreeFolderTerminalPopover(onBindingCommitted);
  await stageTwoFolderRemovalsAndUpdate();
  await waitFor(() => {
    expect(mutationMocks.removeBindingFolder).toHaveBeenCalledTimes(2);
  });
  await waitFor(() => {
    expect(onBindingCommitted).toHaveBeenCalledWith(["/repo/alpha"]);
  });
  expect(toastMocks.reportableErrorToast).toHaveBeenCalled();
  const laterToast = toastMocks.reportableErrorToast.mock.calls[0];
  expect(String(laterToast[0])).toContain("gamma");
  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /^beta/ }));
  const discard = await screen.findByTestId("folder-discard-staged");
  expect(discard.getAttribute("aria-disabled")).toBeNull();
  const update = screen.getByTestId("folder-update");
  expect(update instanceof HTMLButtonElement && update.disabled).toBe(false);
  mutationMocks.removeBindingFolder.mockClear();
  mutationMocks.removeBindingFolder.mockResolvedValue({});
  fireEvent.click(update);
  await waitFor(() => {
    expect(mutationMocks.removeBindingFolder).toHaveBeenCalledTimes(1);
    expect(mutationMocks.removeBindingFolder).toHaveBeenCalledWith({
      epicId: "epic-1",
      ownerId: "owner-1",
      ownerKind: "terminal-agent",
      workspacePath: "/repo/gamma",
    });
  });
});
