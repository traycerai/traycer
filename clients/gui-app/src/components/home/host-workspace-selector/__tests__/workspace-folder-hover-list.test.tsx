import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type {
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { WorkspaceFolderHoverList } from "../workspace-folder-hover-list";

const NOOP = (): void => undefined;

function folder(over: {
  readonly key: string;
  readonly displayName: string;
  readonly branchLabel: string;
  readonly displayPath: string;
  readonly mode: "local" | "worktree";
  readonly currentIntent: WorktreeFolderIntent | null;
  readonly hasStagedIntent?: boolean;
  readonly summary?: WorktreeWorkspaceSummary;
  readonly metadataPending?: boolean;
}) {
  return {
    key: over.key,
    displayName: over.displayName,
    displayPath: over.displayPath,
    unresolved: false,
    metadataPending: over.metadataPending ?? false,
    missing: false,
    isGitRepo: true,
    mode: over.mode,
    branchLabel: over.branchLabel,
    summary: over.summary ?? null,
    currentIntent: over.currentIntent,
    defaultNewBranchName: "traycer/swift-otter",
    branchPrefixWarning: null,
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
    hasStagedIntent: over.hasStagedIntent,
  };
}

afterEach(cleanup);

describe("WorkspaceFolderHoverList", () => {
  it("shows the folder path for local and the worktree path for an adopted worktree, with a copy-path action per folder", () => {
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
    // This renders inside a HoverCard (not a Tooltip), which mounts a single
    // copy of its content with no visually-hidden accessible clone - so the
    // per-folder copy-path button is safe here. One per folder with a path.
    const list = screen.getByTestId("workspace-folder-hover-list");
    expect(
      within(list).getAllByTestId("workspace-hover-copy-path"),
    ).toHaveLength(2);
    // jsdom can't reproduce Chromium making an overflowing scroll container an
    // implicit tab stop - assert the explicit opt-out is present instead
    // (verified against real Chromium separately; see the ticket notes).
    // `HTMLElement.tabIndex` reads -1 for a plain div with NO tabindex
    // attribute, so read the content attribute explicitly.
    expect(list.getAttribute("tabindex")).toBe("-1");
  });

  it("keeps the scroll root out of sequential focus inside a HoverCard", () => {
    render(
      <HoverCard open>
        <HoverCardTrigger asChild>
          <button type="button">Hover-list trigger</button>
        </HoverCardTrigger>
        <HoverCardContent side="bottom">
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
        </HoverCardContent>
      </HoverCard>,
    );
    // HoverCard renders a single copy (no hidden a11y clone), and its scroll
    // root carries the explicit tab-stop opt-out.
    const copies = screen.getAllByTestId("workspace-folder-hover-list");
    expect(copies).toHaveLength(1);
    expect(copies[0].getAttribute("tabindex")).toBe("-1");
  });

  it("shows the source branch of an adopted worktree once its disk metadata resolves", () => {
    const worktreePath = "/Users/me/.traycer/worktrees/infra/feat-login";
    const importIntent: WorktreeFolderIntent = {
      kind: "import",
      workspacePath: "/Users/me/Work/infra",
      repoIdentifier: null,
      isPrimary: true,
      worktreePath,
    };
    const summary = (
      sourceBranch: string | null,
    ): WorktreeWorkspaceSummary => ({
      workspacePath: "/Users/me/Work/infra",
      isGitRepo: true,
      repoIdentifier: null,
      mainBranch: "main",
      scripts: null,
      worktrees: [
        {
          worktreePath: "/Users/me/Work/infra",
          branch: "main",
          sourceBranch: null,
          head: "abc",
          isMain: true,
          isLocked: false,
        },
        {
          worktreePath,
          branch: "feat/login",
          sourceBranch,
          head: "def",
          isMain: false,
          isLocked: false,
        },
      ],
    });
    const { rerender } = render(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/b",
            displayName: "infra",
            branchLabel: "feat/login",
            displayPath: "/Users/me/Work/infra",
            mode: "worktree",
            currentIntent: importIntent,
          }),
        ]}
      />,
    );
    // No summary yet → no provenance line (never a placeholder).
    expect(screen.queryByTestId("workspace-hover-source-branch")).toBeNull();

    rerender(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/b",
            displayName: "infra",
            branchLabel: "feat/login",
            displayPath: "/Users/me/Work/infra",
            mode: "worktree",
            currentIntent: importIntent,
            summary: summary("develop"),
          }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("workspace-hover-source-branch").textContent,
    ).toBe("from develop");

    // A worktree with no recorded source falls back to the main checkout.
    rerender(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/b",
            displayName: "infra",
            branchLabel: "feat/login",
            displayPath: "/Users/me/Work/infra",
            mode: "worktree",
            currentIntent: importIntent,
            summary: summary(null),
          }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("workspace-hover-source-branch").textContent,
    ).toBe("from main");
  });

  it("omits the source branch while the row's metadata is still pending", () => {
    // A pending row still carries a non-null summary - the binding-entry
    // fallback, whose `mainBranch` comes from the folder's own checkout. That
    // is a guess, not provenance, so nothing is attributed until it resolves.
    render(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/b",
            displayName: "infra",
            branchLabel: "feat/login",
            displayPath: "/Users/me/Work/infra",
            mode: "worktree",
            metadataPending: true,
            currentIntent: {
              kind: "import",
              workspacePath: "/Users/me/Work/infra",
              repoIdentifier: null,
              isPrimary: true,
              worktreePath: "/Users/me/.traycer/worktrees/infra/feat-login",
            },
            summary: {
              workspacePath: "/Users/me/Work/infra",
              isGitRepo: true,
              repoIdentifier: null,
              mainBranch: "main",
              scripts: null,
              worktrees: [
                {
                  worktreePath: "/Users/me/.traycer/worktrees/infra/feat-login",
                  branch: "feat/login",
                  sourceBranch: "develop",
                  head: "def",
                  isMain: false,
                  isLocked: false,
                },
              ],
            },
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId("workspace-hover-source-branch")).toBeNull();
    // The branch itself still renders - only the provenance is withheld.
    expect(screen.getByTestId("workspace-hover-branch-name").textContent).toBe(
      "feat/login",
    );
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

  it("names a staged local switch instead of New worktree", () => {
    render(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/a",
            displayName: "traycer",
            branchLabel: "main",
            displayPath: "/Users/me/Work/traycer",
            mode: "worktree",
            currentIntent: {
              kind: "local",
              workspacePath: "/Users/me/Work/traycer",
              repoIdentifier: null,
              isPrimary: true,
            },
            hasStagedIntent: true,
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("workspace-hover-draft-hint").textContent).toBe(
      "Local folder · applies on send",
    );
    expect(screen.queryByText(/New worktree/)).toBeNull();
  });

  it("does not hint a committed local row as a staged apply", () => {
    render(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/a",
            displayName: "traycer",
            branchLabel: "main",
            displayPath: "/Users/me/Work/traycer",
            mode: "worktree",
            currentIntent: {
              kind: "local",
              workspacePath: "/Users/me/Work/traycer",
              repoIdentifier: null,
              isPrimary: true,
            },
            hasStagedIntent: false,
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId("workspace-hover-draft-hint")).toBeNull();
  });

  it("names a staged existing-worktree switch", () => {
    render(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/a",
            displayName: "traycer",
            branchLabel: "feat/login",
            displayPath: "/Users/me/Work/traycer",
            mode: "local",
            currentIntent: {
              kind: "import",
              workspacePath: "/Users/me/Work/traycer",
              repoIdentifier: null,
              isPrimary: true,
              worktreePath: "/wt/feat-login",
            },
            hasStagedIntent: true,
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("workspace-hover-draft-hint").textContent).toBe(
      "Switch to feat/login · applies on send",
    );
  });

  it("names a staged new worktree from a source branch", () => {
    render(
      <WorkspaceFolderHoverList
        items={[
          folder({
            key: "/a",
            displayName: "traycer",
            branchLabel: "traycer/new-thing",
            displayPath: "/Users/me/Work/traycer",
            mode: "local",
            currentIntent: {
              kind: "worktree",
              scripts: null,
              workspacePath: "/Users/me/Work/traycer",
              repoIdentifier: null,
              isPrimary: true,
              branch: {
                type: "new",
                name: "traycer/new-thing",
                source: "main",
                carryUncommittedChanges: false,
              },
            },
            hasStagedIntent: true,
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("workspace-hover-draft-hint").textContent).toBe(
      "From main · created on send",
    );
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
    // The hover-preview card has no `max-w-xs`, so this root must claim its own
    // viewport-aware width - matching the owner preview's `w-[min(92vw,24rem)]`
    // intent - instead of falling back to an unbounded `w-fit` that a long path
    // could stretch arbitrarily wide.
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
