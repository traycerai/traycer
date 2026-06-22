import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveHostWorkspaceControls } from "../host-workspace-selector";

const mocks = vi.hoisted(() => ({
  pickAndPrepareFolders: vi.fn(() => Promise.resolve(null)),
  selectHost: vi.fn(),
}));

vi.mock("@/components/ui/select", () => ({
  Select: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SelectTrigger: (props: {
    readonly children: ReactNode;
    readonly "aria-label"?: string;
    readonly "data-testid"?: string;
    readonly className?: string;
    readonly disabled?: boolean;
  }) => (
    <button
      type="button"
      aria-label={props["aria-label"]}
      className={props.className}
      data-testid={props["data-testid"]}
      disabled={props.disabled ?? false}
    >
      {props.children}
    </button>
  ),
  SelectValue: (props: { readonly placeholder?: string }) => (
    <span>{props.placeholder ?? ""}</span>
  ),
  SelectContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SelectItem: (props: {
    readonly children: ReactNode;
    readonly value: string;
  }) => <div data-value={props.value}>{props.children}</div>,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    directory: { selectById: mocks.selectHost },
  }),
  useHostClient: () => ({
    getActiveHost: () => ({
      hostId: "host-home",
      label: "Home Mac",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-test",
      status: "available",
    }),
    getActiveHostId: () => "host-home",
    getRequestContextUserId: () => "user-home",
    request: vi.fn(),
  }),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-home",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-home",
        label: "Home Mac",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:4917/rpc",
        version: "0.0.0-test",
        status: "available",
      },
    ],
  }),
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
    isLoading: false,
  }),
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: () => [],
}));

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  preparedWorkspaceFolderToWorkspaceFolderInfo: (folder: {
    readonly workspacePath: string;
    readonly workspaceName: string;
    readonly repoIdentifier: unknown;
  }) => ({
    path: folder.workspacePath,
    name: folder.workspaceName,
    repoIdentifier: folder.repoIdentifier,
  }),
  useWorkspaceFolderActions: () => ({
    pickAndPrepareFolders: mocks.pickAndPrepareFolders,
  }),
  useWorkspaceFolderActionsForClient: () => ({
    pickAndPrepareFolders: mocks.pickAndPrepareFolders,
  }),
}));

function renderControl() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ActiveHostWorkspaceControls
        stagingKey={{ surface: "landing", draftId: null }}
        workspaceSeed={null}
        seedIntent={null}
        layout="inline"
        hostScope={{ kind: "active" }}
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("landing workspace summary empty state", () => {
  beforeEach(() => {
    mocks.pickAndPrepareFolders.mockClear();
    mocks.selectHost.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows Add folder directly instead of a no-folder summary trigger", () => {
    const queryClient = renderControl();

    expect(screen.getByTestId("home-workspace-summary-control")).toBeTruthy();
    expect(screen.getByTestId("composer-host-trigger")).toBeTruthy();
    expect(screen.queryByTestId("workspace-summary-trigger")).toBeNull();
    expect(screen.getByTestId("folder-add").textContent).toContain(
      "Add folder",
    );

    fireEvent.click(screen.getByTestId("folder-add"));
    expect(mocks.pickAndPrepareFolders).toHaveBeenCalledTimes(1);

    queryClient.clear();
  });
});
