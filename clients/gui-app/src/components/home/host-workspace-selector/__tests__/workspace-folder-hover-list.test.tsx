import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";
import { WorkspaceFolderHoverList } from "../workspace-folder-hover-list";

const NOOP = (): void => undefined;

function folder(over: {
  readonly key: string;
  readonly displayName: string;
  readonly branchLabel: string;
  readonly displayPath: string;
  readonly mode: "local" | "worktree";
  readonly currentIntent: WorktreeFolderIntent | null;
}) {
  return {
    key: over.key,
    displayName: over.displayName,
    displayPath: over.displayPath,
    unresolved: false,
    metadataPending: false,
    missing: false,
    isGitRepo: true,
    mode: over.mode,
    branchLabel: over.branchLabel,
    hoverLabel: over.displayPath,
    summary: null,
    currentIntent: over.currentIntent,
    defaultNewBranchName: "traycer/swift-otter",
    repoIdentifier: null,
    isPrimary: true,
    hostClient: null,
    modeDisabled: false,
    modeDisabledReason: null,
    removeDisabled: false,
    removeDisabledReason: null,
    removePending: false,
    onSelectMode: NOOP,
    onEmit: NOOP,
    onLocate: null,
    onRemove: null,
  };
}

afterEach(cleanup);

describe("WorkspaceFolderHoverList", () => {
  it("shows the folder path for local and the worktree path for an adopted worktree", () => {
    render(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/a",
            displayName: "traycer",
            branchLabel: "main",
            displayPath: "/Users/me/Work/traycer",
            mode: "local",
            currentIntent: null,
          }),
          folder({
            key: "/b",
            displayName: "infra",
            branchLabel: "feat/login",
            displayPath: "/Users/me/Work/infra",
            mode: "worktree",
            currentIntent: {
              kind: "import",
              workspacePath: "/Users/me/Work/infra",
              repoIdentifier: null,
              isPrimary: true,
              worktreePath: "/Users/me/.traycer/worktrees/infra/feat-login",
            },
          }),
        ]}
      />,
    );
    // Local → the source folder path.
    expect(screen.getByText("/Users/me/Work/traycer")).toBeTruthy();
    // Worktree (adopted) → the worktree path, NOT the source folder.
    expect(
      screen.getByText("/Users/me/.traycer/worktrees/infra/feat-login"),
    ).toBeTruthy();
    expect(screen.queryByText("/Users/me/Work/infra")).toBeNull();
    expect(screen.getAllByLabelText("Copy folder path")).toHaveLength(2);
  });

  it("shows 'New worktree' with no path/copy for a to-be-created worktree", () => {
    render(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/a",
            displayName: "traycer",
            branchLabel: "traycer/new-thing",
            displayPath: "/Users/me/Work/traycer",
            mode: "worktree",
            currentIntent: null,
          }),
        ]}
      />,
    );
    expect(screen.getByText(/New worktree/)).toBeTruthy();
    // The source folder path and a copy button are not shown — there's no path yet.
    expect(screen.queryByText("/Users/me/Work/traycer")).toBeNull();
    expect(screen.queryByLabelText("Copy folder path")).toBeNull();
  });

  it("copies the run path when the copy button is clicked", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/a",
            displayName: "traycer",
            branchLabel: "main",
            displayPath: "/Users/me/Work/traycer",
            mode: "local",
            currentIntent: null,
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByLabelText("Copy folder path"));
    expect(writeText).toHaveBeenCalledWith("/Users/me/Work/traycer");
  });
});
