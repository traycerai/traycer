import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
    summary: null,
    currentIntent: over.currentIntent,
    defaultNewBranchName: "traycer/swift-otter",
    repoIdentifier: null,
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
    onSelectMode: NOOP,
    onEmit: NOOP,
    onLocate: null,
    onMakePrimary: NOOP,
    onRemove: null,
  };
}

afterEach(cleanup);

describe("WorkspaceFolderHoverList", () => {
  it("shows the folder path for local and the worktree path for an adopted worktree, with no interactive descendants", () => {
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
    // This renders as Radix Tooltip content, which mounts an always-present
    // visually-hidden accessible clone of its children — any focusable
    // descendant here would exist twice in the a11y/tab order. The copy
    // action lives on the click-open folder row instead.
    const list = screen.getByTestId("workspace-folder-hover-list");
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    expect(within(list).queryAllByRole("link")).toHaveLength(0);
    // jsdom only enumerates explicit tabIndex/buttons/links for focus order,
    // so it can't reproduce Chromium making an overflowing scroll container
    // an implicit tab stop - assert the explicit opt-out is present instead
    // (verified against real Chromium separately; see the ticket notes).
    // `HTMLElement.tabIndex` (the IDL property) already reads -1 for a plain
    // div with NO tabindex attribute at all, so asserting on it would pass
    // before the fix too - read the content attribute explicitly instead.
    expect(list.getAttribute("tabindex")).toBe("-1");
  });

  it("keeps every rendered copy of the scroll root - including Radix's hidden accessible clone - out of sequential focus", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip open>
          <TooltipTrigger asChild>
            <button type="button">Hover-list trigger</button>
          </TooltipTrigger>
          <TooltipContent side="bottom" richContent>
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
            />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const copies = screen.getAllByTestId("workspace-folder-hover-list");
    // Radix mounts the visible popper content AND an always-present
    // visually-hidden accessible clone - both must carry the explicit
    // opt-out, since Chromium doesn't respect visual hiding for implicit
    // scroll-container focusability.
    expect(copies.length).toBeGreaterThanOrEqual(2);
    for (const copy of copies) {
      expect(copy.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("shows 'New worktree' with no path for a to-be-created worktree", () => {
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
    // The source folder path is not shown — there's no path yet.
    expect(screen.queryByText("/Users/me/Work/traycer")).toBeNull();
  });

  it("claims a viewport-aware width so a long path cannot drive unpredictable w-fit sizing", () => {
    render(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/a",
            displayName: "traycer",
            branchLabel: "main",
            displayPath:
              "/Users/me/Work/a-very-long-path-that-would-otherwise-drive-unpredictable-sizing",
            mode: "local",
            currentIntent: null,
          }),
        ]}
      />,
    );
    // The rich Tooltip variant drops the default `max-w-xs`, so this root must
    // claim its own viewport-aware width - matching the owner preview's
    // `w-[min(92vw,24rem)]` intent - instead of falling back to an unbounded
    // `w-fit` that a long path could stretch arbitrarily wide.
    const list = screen.getByTestId("workspace-folder-hover-list");
    expect(list.className).toContain("w-[min(92vw,24rem)]");
  });

  it("wraps full folder, target, and source names instead of truncating the hover details", () => {
    render(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/a",
            displayName: "a-very-long-repository-name-that-needs-more-room",
            branchLabel: "traycer/a-very-long-target-branch-name",
            displayPath: "/Users/me/Work/traycer",
            mode: "worktree",
            currentIntent: {
              kind: "worktree",
              workspacePath: "/Users/me/Work/traycer",
              repoIdentifier: null,
              isPrimary: true,
              scripts: null,
              branch: {
                type: "new",
                name: "traycer/a-very-long-target-branch-name",
                source: "release/a-very-long-base-branch-name",
                carryUncommittedChanges: false,
              },
            },
          }),
        ]}
      />,
    );

    const folderName = screen.getByTestId("workspace-hover-folder-name");
    const branchName = screen.getByTestId("workspace-hover-branch-name");
    expect(folderName.textContent).toBe(
      "a-very-long-repository-name-that-needs-more-room",
    );
    expect(folderName.className).toContain("break-words");
    expect(folderName.className).not.toContain("truncate");
    expect(branchName.textContent).toBe(
      "traycer/a-very-long-target-branch-name",
    );
    expect(branchName.className).toContain("break-words");
    expect(branchName.className).not.toContain("truncate");
    expect(
      screen.getByText(
        "From release/a-very-long-base-branch-name · created on send",
      ),
    ).toBeTruthy();
  });
});
