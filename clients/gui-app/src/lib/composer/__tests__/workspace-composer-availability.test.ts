import { describe, expect, it } from "vitest";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
} from "@traycer/protocol/host/worktree-schemas";
import {
  CHECKING_WORKSPACE_FOLDER_HINT,
  NO_BOUND_WORKSPACE_FOLDER_HINT,
  NO_WORKSPACE_FOLDER_HINT,
  UNRESOLVED_WORKSPACE_FOLDER_HINT,
  WORKSPACE_COMPOSER_READY,
  deriveResolvedWorkspaceAvailability,
  deriveWorktreeBindingWorkspaceAvailability,
  effectiveMissingWorktreePaths,
  workspaceComposerCanStart,
  worktreeMissingComposerHint,
} from "@/lib/composer/workspace-composer-availability";
import type { ResolvedFolder } from "@/lib/workspace/resolved-folder";

describe("deriveResolvedWorkspaceAvailability", () => {
  it("keeps composer submit checking while empty folders are still resolving", () => {
    expect(deriveResolvedWorkspaceAvailability([], true)).toEqual({
      status: "checking",
      disabledHint: CHECKING_WORKSPACE_FOLDER_HINT,
    });
  });

  it("blocks once resolving finishes with no folders", () => {
    expect(deriveResolvedWorkspaceAvailability([], false)).toEqual({
      status: "blocked",
      disabledHint: NO_WORKSPACE_FOLDER_HINT,
    });
  });

  it("blocks unresolved folders and allows resolved folders", () => {
    expect(
      deriveResolvedWorkspaceAvailability(
        [unresolvedFolder("/Users/me/missing")],
        false,
      ),
    ).toEqual({
      status: "blocked",
      disabledHint: UNRESOLVED_WORKSPACE_FOLDER_HINT,
    });

    expect(
      deriveResolvedWorkspaceAvailability(
        [localOnlyFolder("/Users/me/project")],
        false,
      ),
    ).toEqual(WORKSPACE_COMPOSER_READY);
  });
});

describe("deriveWorktreeBindingWorkspaceAvailability", () => {
  it("keeps chat submit blocked while the binding has not resolved", () => {
    expect(
      deriveWorktreeBindingWorkspaceAvailability(null, false, 1, []),
    ).toEqual({
      status: "checking",
      disabledHint: CHECKING_WORKSPACE_FOLDER_HINT,
    });
  });

  it("keeps chat submit checking while the epic folder list is unresolved", () => {
    expect(
      deriveWorktreeBindingWorkspaceAvailability(null, true, null, []),
    ).toEqual({
      status: "checking",
      disabledHint: CHECKING_WORKSPACE_FOLDER_HINT,
    });
  });

  it("blocks a resolved chat only when the epic has no folders", () => {
    expect(
      deriveWorktreeBindingWorkspaceAvailability(null, true, 0, []),
    ).toEqual({
      status: "blocked",
      disabledHint: NO_BOUND_WORKSPACE_FOLDER_HINT,
    });
    expect(
      deriveWorktreeBindingWorkspaceAvailability(binding([]), true, 0, []),
    ).toEqual({
      status: "blocked",
      disabledHint: NO_BOUND_WORKSPACE_FOLDER_HINT,
    });
  });

  it("allows an unbound chat when the epic has at least one folder", () => {
    expect(
      deriveWorktreeBindingWorkspaceAvailability(null, true, 1, []),
    ).toEqual(WORKSPACE_COMPOSER_READY);
    expect(
      deriveWorktreeBindingWorkspaceAvailability(binding([]), true, 2, []),
    ).toEqual(WORKSPACE_COMPOSER_READY);
  });

  it("allows chat submit when the chat binding has a folder", () => {
    expect(
      deriveWorktreeBindingWorkspaceAvailability(
        binding([bindingEntry("/Users/me/project")]),
        true,
        0,
        [],
      ),
    ).toEqual(WORKSPACE_COMPOSER_READY);
  });

  it("blocks submit on a missing bound folder with a folder-naming hint", () => {
    const availability = deriveWorktreeBindingWorkspaceAvailability(
      binding([bindingEntry("/Users/me/project")]),
      true,
      1,
      ["/Users/me/project"],
    );
    // A missing bound folder now BLOCKS send (status `worktree-missing` with a
    // hint), so a turn can never be launched into a missing directory from the
    // composer. The disable is paired with the chat tile's on-focus
    // `worktree.getBinding` re-check, so restoring the folder + refocusing
    // recomputes the missing set fresh and lifts the disable — recovery does not
    // depend on a send the disable would forbid.
    expect(availability).toEqual({
      status: "worktree-missing",
      disabledHint: worktreeMissingComposerHint(["/Users/me/project"]),
      missingWorkspacePaths: ["/Users/me/project"],
    });
    expect(workspaceComposerCanStart(availability)).toBe(false);
  });

  it("carries (and names) every missing bound folder while blocking submit", () => {
    const availability = deriveWorktreeBindingWorkspaceAvailability(
      binding([
        bindingEntry("/Users/me/project"),
        bindingEntry("/Users/me/other"),
      ]),
      true,
      2,
      ["/Users/me/project", "/Users/me/other"],
    );
    expect(availability).toEqual({
      status: "worktree-missing",
      disabledHint: worktreeMissingComposerHint([
        "/Users/me/project",
        "/Users/me/other",
      ]),
      missingWorkspacePaths: ["/Users/me/project", "/Users/me/other"],
    });
    expect(workspaceComposerCanStart(availability)).toBe(false);
    // The hint names both folders so the disabled-send tooltip is actionable.
    expect(availability.disabledHint).toContain("/Users/me/project");
    expect(availability.disabledHint).toContain("/Users/me/other");
  });
});

describe("effectiveMissingWorktreePaths", () => {
  it("returns the source missing paths when no workspace paths changed", () => {
    const missingPaths = ["/Users/me/project", "/Users/me/other"];

    expect(effectiveMissingWorktreePaths(missingPaths, new Set())).toBe(
      missingPaths,
    );
  });

  it("hides only changed missing paths while keeping other warnings visible", () => {
    const missingPaths = [
      "/Users/me/project",
      "/Users/me/other",
      "/Users/me/third",
    ];

    expect(
      effectiveMissingWorktreePaths(missingPaths, new Set(["/Users/me/other"])),
    ).toEqual(["/Users/me/project", "/Users/me/third"]);
  });

  it("hides all missing paths only when every missing path changed", () => {
    const missingPaths = ["/Users/me/project"];

    expect(
      effectiveMissingWorktreePaths(
        missingPaths,
        new Set(["/Users/me/project"]),
      ),
    ).toEqual([]);
  });
});

function binding(
  entries: ReadonlyArray<WorktreeBindingEntry>,
): WorktreeBinding {
  return { entries: [...entries] };
}

function bindingEntry(workspacePath: string): WorktreeBindingEntry {
  return {
    workspacePath,
    mode: "local",
    repoIdentifier: null,
    worktreePath: null,
    branch: "main",
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt: 1,
    ownedSubmodules: [],
  };
}

function localOnlyFolder(path: string): ResolvedFolder {
  return {
    kind: "local-only",
    path,
    name: "project",
  };
}

function unresolvedFolder(path: string): ResolvedFolder {
  return {
    kind: "unresolved",
    path,
    name: "missing",
    repoIdentifier: { owner: "acme", repo: "app" },
  };
}
