import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveHostWorkspaceControls } from "../host-workspace-selector";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HostWorkspaceControlsHostScope } from "../host-workspace-controls-scope";

const mocks = vi.hoisted(() => ({
  selectById: vi.fn<(hostId: string) => void>(),
  onSelect: vi.fn<(hostId: string) => void>(),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    directory: {
      selectById: mocks.selectById,
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

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "tab-host-id",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "tab-host-id",
        label: "Tab host",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:0/tab-host-id",
        version: "0.0.0-test",
        transportDialability: "dialable",
      },
      {
        hostId: "other-host-id",
        label: "Other host",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:0/other-host-id",
        version: "0.0.0-test",
        transportDialability: "dialable",
      },
    ],
  }),
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

function renderStacked(hostScope: HostWorkspaceControlsHostScope): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ActiveHostWorkspaceControls
          disabled={false}
          // Scaffolding only — these cases assert on `hostScope`, never on
          // staged state, so the slot sits in the unresolved-host bucket
          // rather than claiming a host the assertions do not check.
          stagingKey={{ surface: "landing", hostId: null, draftId: null }}
          workspaceSeed={{
            folders: [],
            folderInfoByPath: {},
            primaryPath: null,
          }}
          seedIntent={null}
          seedIntentOverride={null}
          layout="stacked"
          hostScope={hostScope}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function pickOtherHost(): void {
  fireEvent.click(screen.getByRole("button", { name: "Host: Tab host" }));
  fireEvent.click(
    screen.getByTestId("settings-host-switcher-option-other-host-id"),
  );
}

describe("ActiveHostWorkspaceControls selected scope", () => {
  afterEach(() => {
    mocks.selectById.mockReset();
    mocks.onSelect.mockReset();
    cleanup();
  });

  it("routes a selected-scope pick to onSelect and never to directory.selectById", () => {
    renderStacked({
      kind: "selected",
      hostId: "tab-host-id",
      hostClient: null,
      onSelect: mocks.onSelect,
      refusalByHostId: NO_HOST_OPTION_REFUSALS,
      unselectableExceptHostId: null,
    });

    pickOtherHost();

    expect(mocks.onSelect).toHaveBeenCalledWith("other-host-id");
    expect(mocks.selectById).not.toHaveBeenCalled();
  });

  it("still rebinds the app-wide host from an active scope", () => {
    renderStacked({ kind: "active" });

    pickOtherHost();

    expect(mocks.selectById).toHaveBeenCalledWith("other-host-id");
    expect(mocks.onSelect).not.toHaveBeenCalled();
  });

  it("unselectableExceptHostId makes every other row inert with no word", () => {
    renderStacked({
      kind: "selected",
      hostId: "tab-host-id",
      hostClient: null,
      onSelect: mocks.onSelect,
      refusalByHostId: NO_HOST_OPTION_REFUSALS,
      unselectableExceptHostId: "tab-host-id",
    });

    fireEvent.click(screen.getByRole("button", { name: "Host: Tab host" }));

    const otherRow = screen.getByTestId(
      "settings-host-switcher-option-other-host-id",
    );
    expect(otherRow.getAttribute("aria-disabled")).toBe("true");
    expect(otherRow.textContent).not.toContain("needs update");
    expect(mocks.onSelect).not.toHaveBeenCalled();
  });
});
