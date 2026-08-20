import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
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
  createWorktree: vi.fn(),
  recordRecent: vi.fn(),
  removeBindingFolder: vi.fn(),
}));
const recentMocks = vi.hoisted(() => ({
  prepareRecent: vi.fn(),
  recordRecentAsync: vi.fn(),
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
    data: { workspaces: [] },
    isFetching: false,
    isLoading: false,
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
    isPending: false,
  }),
}));
vi.mock(
  "@/hooks/workspace/use-workspace-binding-remove-entry-mutation",
  () => ({
    useWorkspaceBindingRemoveEntryForClient: () => ({
      mutate: mutationMocks.removeBindingFolder,
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
    pickAndPrepareFolders: vi.fn(() => Promise.resolve(null)),
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

function renderBoundSurface(
  kind: "chat" | "terminal-agent",
  bindingResolved: boolean,
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <HostWorkspaceSelector
          disabled={false}
          surface={{
            kind,
            hostId: "host-test",
            epicId: "epic-1",
            tabId: "tab-1",
            ownerId: "owner-1",
            binding: BINDING,
            isOwnerActive: false,
            hasActiveTurn: false,
            missingWorktreePaths: [],
            bindingResolved,
            onBindingCommitted: null,
            onForkOnHost: null,
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  recentMocks.prepareRecent.mockResolvedValue({ folders: [RECENT_FOLDER] });
  recentMocks.recordRecentAsync.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  mutationMocks.addBindingFolder.mockReset();
  mutationMocks.createWorktree.mockReset();
  mutationMocks.recordRecent.mockReset();
  mutationMocks.removeBindingFolder.mockReset();
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

  const switcher = screen.getByTestId("composer-host-trigger");
  expect(switcher instanceof HTMLButtonElement && switcher.disabled).toBe(true);
  fireEvent.focus(switcher);
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "Terminal host is fixed",
  );
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
