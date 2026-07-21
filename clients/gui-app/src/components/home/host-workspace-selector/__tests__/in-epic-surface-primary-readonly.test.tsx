import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
} from "@traycer/protocol/host/worktree-schemas";
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
const mutationMocks = vi.hoisted(() => ({ createWorktree: vi.fn() }));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => FAKE_CLIENT,
}));
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-test",
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
        status: "available",
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
      mutate: vi.fn(),
      isPending: false,
    }),
    usePendingRemoveBindingEntryPaths: () => new Set<string>(),
  }),
);
vi.mock("@/hooks/workspace/use-workspace-binding-add-folder-mutation", () => ({
  useWorkspaceBindingAddFolderForClient: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChat: () => ({ mutate: vi.fn(), isPending: false }),
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
    pickAndPrepareFolders: vi.fn(),
    isPreparing: false,
  }),
  preparedWorkspaceFolderToWorkspaceFolderInfo: (value: unknown) => value,
}));
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: () => [],
}));
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: undefined, isLoading: false }),
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

function renderBoundSurface(kind: "chat" | "terminal-agent"): void {
  render(
    <TooltipProvider>
      <HostWorkspaceSelector
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
          bindingResolved: true,
          onBindingCommitted: null,
        }}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  mutationMocks.createWorktree.mockReset();
  useWorktreeIntentStagingStore.getState().resetForTests();
});

describe.each(["chat", "terminal-agent"] as const)(
  "InEpicSurface (%s owner)",
  (kind) => {
    it("renders the primary pin read-only and offers NO Set-as-primary action on any bound row", async () => {
      renderBoundSurface(kind);

      // Open the folder-rows popover from the collapsed summary.
      fireEvent.click(screen.getByTestId("workspace-summary-trigger"));
      const rows = await screen.findAllByTestId("folder-row");
      expect(rows).toHaveLength(2);

      // The filled pin marks the bound primary (read-only display)...
      expect(screen.getByTestId("folder-primary-pin")).toBeTruthy();
      // ...and the collapsed chip agreed with it (isPrimary, not items[0]).
      expect(
        screen.getByTestId("workspace-summary-trigger").textContent,
      ).toContain("beta");

      // No atomic set-primary RPC exists for a live binding - the action
      // must be absent on EVERY row of a bound surface.
      expect(screen.queryByTestId("folder-make-primary")).toBeNull();
      // The other row actions are still there (the rows are editable).
      expect(screen.getAllByTestId("folder-remove").length).toBeGreaterThan(0);
    });
  },
);

it("refuses terminal Update when metadata regresses to unresolved", async () => {
  const key = {
    surface: "owner" as const,
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

  renderBoundSurface("terminal-agent");
  fireEvent.click(screen.getByTestId("workspace-summary-trigger"));
  const update = await screen.findByRole("button", { name: "Update" });
  fireEvent.click(update);

  expect(mutationMocks.createWorktree).not.toHaveBeenCalled();
  expect(
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(key)
    ],
  ).toBeDefined();
});
