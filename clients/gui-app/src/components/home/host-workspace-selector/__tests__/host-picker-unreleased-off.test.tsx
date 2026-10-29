/**
 * The build without sandboxes (`unreleased-features.ts`): a composer's host
 * picker is the list the release before them had — one `Host` group of plain
 * rows, and a search only once there are enough hosts to need one. The
 * surface still passes a staging surface; `useSandboxStaging` answers `null`
 * for it, so no caller carries the composer layout.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveHostWorkspaceControls } from "../host-workspace-selector";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

const mocks = vi.hoisted(() => ({
  pinSetSelection: vi.fn<(selection: string | null) => void>(),
}));

// The staging reads the account and the catalogue; without sandboxes neither
// is read, and this suite has no auth runtime behind them either way.
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: undefined }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/lib/host", () => ({
  useHostRuntimeClient: () => null,
  useHostBinding: () => ({
    directory: {
      selectById: () => undefined,
      refresh: () => Promise.resolve([]),
    },
  }),
  useHostClient: () => ({
    getActiveHostId: () => "tab-host-id",
    getActiveHost: () => ({
      hostId: "tab-host-id",
      label: "Tab host",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:0/tab-host-id",
      version: "0.0.0-test",
      transportDialability: "dialable",
    }),
    getRequestContextUserId: () => "user-test",
    request: () => Promise.resolve({}),
    onChange: () => () => undefined,
  }),
}));

vi.mock("@/hooks/host/use-composer-surface-host-pin", () => ({
  useComposerSurfaceHostPin: () => ({
    selection: null,
    honoredSelection: null,
    setSelection: mocks.pinSetSelection,
    resolvedHostId: "tab-host-id",
    isPinned: false,
    latchOnFirstUse: () => undefined,
  }),
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [
          hostScopeOptionFixture({ hostId: "tab-host-id", name: "Tab host" }),
          hostScopeOptionFixture({
            hostId: "other-host-id",
            name: "Other host",
          }),
        ],
        activeHostId: "tab-host-id",
      }),
  };
});

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));

vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHostsPollLiveness: () => undefined,
}));

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [] }),
}));

vi.mock("@/hooks/worktree/use-worktree-list-by-workspace-paths-query", () => ({
  useWorktreeListByWorkspacePaths: () => ({
    data: { workspaces: [] },
    isFetching: false,
  }),
  useWorktreeListByWorkspacePathsForClient: () => ({
    data: { workspaces: [] },
    isFetching: false,
    isPending: false,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: () => [],
  useHostQueriesWithResponseMap: () => new Map(),
}));

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  preparedWorkspaceFolderToWorkspaceFolderInfo: () => ({
    path: "",
    name: "",
    repoIdentifier: null,
    hostId: null,
  }),
  useWorkspaceFolderActions: () => ({
    pickAndPrepareFolders: () => Promise.resolve(null),
  }),
  useWorkspaceFolderActionsForClient: () => ({
    pickAndPrepareFolders: () => Promise.resolve(null),
  }),
}));

vi.mock("@/components/ui/select", () => ({
  Select: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SelectTrigger: (props: { readonly children: ReactNode }) => (
    <button type="button">{props.children}</button>
  ),
  SelectValue: () => null,
  SelectContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SelectItem: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
}));

function openPicker(): HTMLElement {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ActiveHostWorkspaceControls
          // The surface a composer passes: it stages nothing here.
          sandboxStaging={{
            surfaceKey: "landing:window-test",
            task: null,
            openTerminalInstead: null,
          }}
          disabled={false}
          stagingKey={{ surface: "landing", hostId: null, draftId: null }}
          workspaceSeed={null}
          seedIntent={null}
          seedIntentOverride={null}
          layout="stacked"
          hostScope={{ kind: "active" }}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Host:/ }));
  return screen.getByTestId("settings-host-switcher-list");
}

afterEach(() => {
  mocks.pinSetSelection.mockReset();
  cleanup();
});

describe("a composer host picker without sandboxes", () => {
  it("lists its hosts under one Host group, with no composer groups", () => {
    const list = openPicker();

    expect(within(list).getByText("Host")).not.toBeNull();
    expect(screen.queryByTestId("host-switcher-yours")).toBeNull();
    expect(screen.queryByTestId("host-switcher-in-this-task")).toBeNull();
    expect(
      screen.getByTestId("settings-host-switcher-option-other-host-id"),
    ).not.toBeNull();
  });

  it("shows no search field below the host threshold", () => {
    openPicker();

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByPlaceholderText("Search hosts…")).toBeNull();
  });
});
