import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// Isolate the presentation branch (loading / error / ready) from the real
// resolution chain: `useEpicAppearanceSource`, the summary query, and
// `WorktreeScriptsDialog` are all mocked, so these tests exercise only what
// `TabRepositorySettingsDialog` renders for a given resolution state.
const mocks = vi.hoisted(() => ({
  workspacePath: null as string | null,
  summariesResult: {
    data: undefined as
      | {
          readonly workspaces: ReadonlyArray<{
            readonly workspacePath: string;
          }>;
        }
      | undefined,
    isPending: true,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@/hooks/appearance/use-workspace-appearance", () => ({
  useEpicAppearanceSource: () => ({
    hostId: "host-a",
    workspacePath: mocks.workspacePath,
  }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/worktree/use-worktree-list-by-workspace-paths-query", () => ({
  useWorktreeListByWorkspacePathsForClient: () => mocks.summariesResult,
}));

vi.mock("@/components/home/worktree/worktree-scripts-dialog", () => ({
  WorktreeScriptsDialog: () => <div data-testid="worktree-scripts-dialog" />,
}));

interface Shell {
  readonly children: ReactNode;
}
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean } & Shell) =>
    open ? (
      <div data-testid="tab-repository-settings-shell">{children}</div>
    ) : null,
  DialogContent: ({ children }: Shell) => <div>{children}</div>,
  DialogHeader: ({ children }: Shell) => <div>{children}</div>,
  DialogFooter: ({ children }: Shell) => <div>{children}</div>,
  DialogTitle: ({ children }: Shell) => <h2>{children}</h2>,
  DialogDescription: ({ children }: Shell) => <p>{children}</p>,
}));

import { TabRepositorySettingsDialog } from "@/components/layout/tabs/tab-repository-settings-dialog";

function renderDialog(onClose: () => void = vi.fn()) {
  render(
    <TabRepositorySettingsDialog
      epicId="epic-1"
      hostId="host-a"
      identityPath={null}
      onClose={onClose}
    />,
  );
}

describe("<TabRepositorySettingsDialog />", () => {
  beforeEach(() => {
    mocks.workspacePath = null;
    mocks.summariesResult = {
      data: undefined,
      isPending: true,
      isError: false,
      refetch: vi.fn(),
    };
  });
  afterEach(() => {
    cleanup();
  });

  it("opens with a skeleton body while the workspace path is still resolving", () => {
    renderDialog();

    expect(screen.getByTestId("tab-repository-settings-shell")).toBeTruthy();
    expect(
      screen.getByTestId("tab-repository-settings-dialog-loading"),
    ).toBeTruthy();
    expect(screen.queryByTestId("worktree-scripts-dialog")).toBeNull();
    expect(
      screen.queryByTestId("tab-repository-settings-dialog-error"),
    ).toBeNull();
  });

  it("opens with a skeleton body while the summary query is in flight", () => {
    mocks.workspacePath = "/repo/a";
    mocks.summariesResult = {
      data: undefined,
      isPending: true,
      isError: false,
      refetch: vi.fn(),
    };
    renderDialog();

    expect(
      screen.getByTestId("tab-repository-settings-dialog-loading"),
    ).toBeTruthy();
  });

  it("opens with an inline error and a working Retry when the summary query fails", () => {
    mocks.workspacePath = "/repo/a";
    const refetch = vi.fn();
    mocks.summariesResult = {
      data: undefined,
      isPending: false,
      isError: true,
      refetch,
    };
    renderDialog();

    expect(
      screen.getByTestId("tab-repository-settings-dialog-error"),
    ).toBeTruthy();
    expect(screen.queryByTestId("worktree-scripts-dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("opens with an inline error when the query settles with no matching summary", () => {
    mocks.workspacePath = "/repo/a";
    mocks.summariesResult = {
      data: { workspaces: [] },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderDialog();

    expect(
      screen.getByTestId("tab-repository-settings-dialog-error"),
    ).toBeTruthy();
    expect(
      screen.getByText("Couldn't find this repository's settings."),
    ).toBeTruthy();
  });

  it("onClose works from the error state (never traps the user)", () => {
    mocks.workspacePath = "/repo/a";
    mocks.summariesResult = {
      data: undefined,
      isPending: false,
      isError: true,
      refetch: vi.fn(),
    };
    const onClose = vi.fn();
    renderDialog(onClose);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("onClose works from the loading state", () => {
    const onClose = vi.fn();
    renderDialog(onClose);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the real WorktreeScriptsDialog once the workspace and summary resolve", () => {
    mocks.workspacePath = "/repo/a";
    mocks.summariesResult = {
      data: { workspaces: [{ workspacePath: "/repo/a" }] },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderDialog();

    expect(screen.getByTestId("worktree-scripts-dialog")).toBeTruthy();
    expect(screen.queryByTestId("tab-repository-settings-shell")).toBeNull();
    expect(
      screen.queryByTestId("tab-repository-settings-dialog-loading"),
    ).toBeNull();
    expect(
      screen.queryByTestId("tab-repository-settings-dialog-error"),
    ).toBeNull();
  });
});
