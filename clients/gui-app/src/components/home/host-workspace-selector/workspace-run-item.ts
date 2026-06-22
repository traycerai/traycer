import type {
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";

export type WorkspaceRunMode = "local" | "worktree";

/**
 * The stable per-folder contract feeding the workspace folder rows. Both
 * surfaces (landing + in-epic) build a `ReadonlyArray<WorkspaceRunItem>`; the
 * row controls call its handlers (`onSelectMode`, `onEmit`, `onRemove`,
 * `onLocate`) so the binding / staging / mutation orchestration stays in the
 * surfaces and the renderer only renders.
 */
export interface WorkspaceRunItem {
  readonly key: string;
  readonly displayName: string;
  readonly displayPath: string;
  readonly unresolved: boolean;
  readonly metadataPending: boolean;
  // The bound directory is gone on disk (this row's `workspacePath` is in the
  // owner's host-computed `missingWorktreePaths`). Drives the per-row + summary
  // "missing" indicator; the run itself is gated host-side (send / prepareLaunch
  // reject), this is the proactive surface.
  readonly missing: boolean;
  readonly isGitRepo: boolean;
  readonly mode: WorkspaceRunMode;
  readonly branchLabel: string;
  readonly hoverLabel: string;
  readonly summary: WorktreeWorkspaceSummary | null;
  readonly currentIntent: WorktreeFolderIntent | null;
  readonly defaultNewBranchName: string;
  readonly repoIdentifier: WorktreeFolderIntent["repoIdentifier"];
  readonly isPrimary: boolean;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly modeDisabled: boolean;
  readonly modeDisabledReason: string | null;
  readonly removeDisabled: boolean;
  readonly removeDisabledReason: string | null;
  readonly removePending: boolean;
  readonly onSelectMode: (mode: WorkspaceRunMode) => void;
  readonly onEmit: (intent: WorktreeFolderIntent) => void;
  readonly onLocate: (() => void) | null;
  readonly onRemove: (() => void) | null;
}

export type FolderLocationValue = "local" | "worktree" | "import";

/**
 * The Location-control value for a folder row. A staged / bound intent's `kind`
 * wins (so an adopted worktree reads as `import`); before any intent resolves, a
 * git folder defaults to a new worktree and a non-git folder to local. Both the
 * Location and Branch controls derive from this so an `import` is never treated
 * as an editable new-worktree branch (`mode` alone can't tell them apart — an
 * import is `mode: "worktree"`).
 */
export function folderLocationValue(
  item: WorkspaceRunItem,
): FolderLocationValue {
  return folderLocationValueFrom(item.currentIntent, item.mode);
}

/** {@link folderLocationValue} from the raw intent + mode (before an item is
 * built), used by the Location-select guard in the surfaces. */
function folderLocationValueFrom(
  currentIntent: WorktreeFolderIntent | null,
  mode: WorkspaceRunMode,
): FolderLocationValue {
  if (currentIntent !== null) return currentIntent.kind;
  return mode === "worktree" ? "worktree" : "local";
}

/**
 * Whether picking `nextMode` in the Location control is a real change. `import`
 * (existing worktree) and a `new` worktree both map to `WorkspaceRunMode
 * "worktree"`, so guarding on the coarse mode alone makes "switch existing → new
 * worktree" a no-op. Comparing the intent KIND fixes that: "New worktree"
 * (`nextMode "worktree"`) is a change from both `local` and `import`, and
 * re-picking the active kind stays a no-op (so it never resets a staged branch).
 */
export function locationSelectionChanges(
  nextMode: WorkspaceRunMode,
  currentIntent: WorktreeFolderIntent | null,
  currentMode: WorkspaceRunMode,
): boolean {
  const current = folderLocationValueFrom(currentIntent, currentMode);
  return nextMode === "local" ? current !== "local" : current !== "worktree";
}

/**
 * The branch label shown on a folder row / summary. A new worktree reads as its
 * SOURCE branch, not the fork's new name: a `new` fork carries its source
 * explicitly, and an `existing` checkout's `name` IS the adopted source branch.
 * `local` falls back to the checkout's current branch; an `import` reads the
 * adopted on-disk worktree's branch (or its folder name when headless).
 */
export function workspaceRunBranchLabel(input: {
  readonly mode: WorkspaceRunMode;
  readonly currentBranch: string | null;
  readonly currentIntent: WorktreeFolderIntent | null;
  readonly diskWorktrees: ReadonlyArray<{
    readonly worktreePath: string;
    readonly branch: string | null;
  }>;
}): string {
  if (input.mode === "local") return input.currentBranch ?? "Local";
  if (input.currentIntent === null) return input.currentBranch ?? "Worktree";
  if (input.currentIntent.kind === "local")
    return input.currentBranch ?? "Local";
  if (input.currentIntent.kind === "worktree") {
    const { branch } = input.currentIntent;
    if (branch.type !== "new") return branch.name;
    // A `new` worktree reads as its source branch. When it carries the working
    // tree's uncommitted WIP (only possible when the source matches the checkout's
    // current branch) say so explicitly; a clean fork reads as the plain source.
    return branch.carryUncommittedChanges &&
      branch.source === input.currentBranch
      ? `Working tree · ${branch.source}`
      : branch.source;
  }
  const importIntent = input.currentIntent;
  const matching =
    input.diskWorktrees.find(
      (worktree) => worktree.worktreePath === importIntent.worktreePath,
    ) ?? null;
  if (matching?.branch !== null && matching?.branch !== undefined) {
    return matching.branch;
  }
  return workspaceFolderName(importIntent.worktreePath);
}

/**
 * Muted, borderless trigger styling shared by the folder-row controls (Location,
 * Branch) so they match the host picker and the older folder chip — no border,
 * `text-muted-foreground` at reduced opacity, subtle hover. Pass through `cn(...)`.
 */
// `w-full` so each trigger fills its grid cell and the chevron (a `flex-1`
// label sits before it) pins to the cell's right edge instead of hugging short
// text. See the Location / Branch controls. Resting tone is the muted composer
// chip (muted-foreground @ 0.7) by default; a mount can set `--fc-text` /
// `--fc-opacity` to render full-opacity foreground text (e.g. fork / terminal
// panels, where it must match the surrounding non-muted sections).
export const FOLDER_CONTROL_TRIGGER_CLASS =
  // A disabled control (active-run lock / non-git folder) keeps the SAME base
  // `--fc-opacity` as the folder chip, branch label, and "Add folder" so it does
  // not render lighter than the rest of its row. The disabled affordance is the
  // not-allowed cursor + no hover-brighten + the rebind tooltip, not extra fade.
  "inline-flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-ui-sm text-[color:var(--fc-text,var(--color-muted-foreground))] opacity-[var(--fc-opacity,0.7)] transition-[background-color,opacity] hover:bg-accent/50 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:opacity-[var(--fc-opacity,0.7)] aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:opacity-[var(--fc-opacity,0.7)] data-[state=open]:bg-accent/50 data-[state=open]:opacity-100";

// The ⚙ scripts button opens the modal in every mode with no per-folder
// "configured" indicator, so no scripts-content derivation lives here.
