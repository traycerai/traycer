import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeWorkspaceSummary } from "@traycer/protocol/host/worktree-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FolderLocationControl } from "../folder-location-control";
import type { WorkspaceRunItem } from "../workspace-run-item";

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: undefined, isLoading: false }),
}));

const GIT_SUMMARY: WorktreeWorkspaceSummary = {
  workspacePath: "/repo",
  isGitRepo: true,
  repoIdentifier: { owner: "acme", repo: "app" },
  mainBranch: "development",
  worktrees: [
    {
      worktreePath: "/repo",
      branch: "development",
      head: null,
      isMain: true,
      isLocked: false,
    },
  ],
  scripts: null,
};

function item(over: Partial<WorkspaceRunItem>): WorkspaceRunItem {
  return {
    key: "/repo",
    displayName: "repo",
    displayPath: "/repo",
    unresolved: false,
    metadataPending: false,
    missing: false,
    isGitRepo: true,
    mode: "worktree",
    branchLabel: "feat/x",
    summary: GIT_SUMMARY,
    currentIntent: null,
    defaultNewBranchName: "traycer/swift-otter",
    branchPrefixWarning: null,
    repoIdentifier: { owner: "acme", repo: "app" },
    isPrimary: true,
    canChangePrimary: true,
    makePrimaryDisabled: false,
    makePrimaryDisabledReason: null,
    hostClient: null,
    modeDisabled: false,
    modeDisabledReason: null,
    removeDisabled: false,
    removeDisabledReason: null,
    removePending: false,
    onSelectMode: () => undefined,
    onEmit: () => undefined,
    onLocate: null,
    onMakePrimary: () => undefined,
    onRemove: null,
    ...over,
  };
}

afterEach(cleanup);

// R5: the sibling `folder-controls.test.tsx` suite mocks `@/components/ui/dropdown-menu`
// wholesale (the menu content is always rendered inline), so it can never observe
// Base's real open-state attribute reaching the trigger. This file renders the
// real Base-backed DropdownMenu deliberately, so it is sensitive to both the
// attribute transition and the styling class token that reads it - removing
// either `FOLDER_CONTROL_TRIGGER_CLASS` open-state utility fails this test.
describe("FolderLocationControl - real open-state styling", () => {
  it("carries data-popup-open while open with matching style classes, and clears the state on close", () => {
    render(
      <TooltipProvider>
        <FolderLocationControl
          item={item({})}
          uncommittedByPath={new Map()}
          boundaryEl={null}
          readOnly={false}
        />
      </TooltipProvider>,
    );

    const trigger = screen.getByTestId("folder-location-trigger");
    expect(trigger.hasAttribute("data-popup-open")).toBe(false);
    expect(trigger.className).toContain("data-popup-open:bg-accent/50");
    expect(trigger.className).toContain("data-popup-open:text-foreground");

    fireEvent.click(trigger);
    expect(screen.getByTestId("folder-location-menu")).toBeTruthy();
    expect(trigger.hasAttribute("data-popup-open")).toBe(true);

    fireEvent.click(trigger);
    expect(trigger.hasAttribute("data-popup-open")).toBe(false);
    expect(screen.queryByTestId("folder-location-menu")).toBeNull();
  });
});
