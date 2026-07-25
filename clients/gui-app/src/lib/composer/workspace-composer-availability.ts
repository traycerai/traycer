import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import type { ResolvedFolder } from "@/lib/workspace/resolved-folder";

/**
 * Workspace-backed composers need two separate facts:
 * - whether submit/launch should be allowed
 * - what tooltip, if any, explains a disabled state
 *
 * Keeping those as a typed status prevents a transient "no hint" state from
 * accidentally becoming "send is allowed."
 */
export type WorkspaceComposerAvailability =
  | {
      readonly status: "ready";
      readonly disabledHint: null;
    }
  | {
      readonly status: "checking";
      readonly disabledHint: string;
    }
  | {
      readonly status: "blocked";
      readonly disabledHint: string;
    }
  | {
      // A bound folder is missing on disk. BLOCKING: send is disabled with a
      // hint, so a turn can never be launched into a missing directory from the
      // composer. (The host's on-send re-stat stays the authoritative backstop
      // for the non-composer send paths — queued drain, A2A/CLI, races.)
      //
      // The disable is safe against the old strand-the-chat deadlock because it
      // is PAIRED with an on-focus re-check: the chat tile re-queries
      // `worktree.getBinding` (which recomputes the missing set FRESH, server
      // side) on window focus + pane activation and syncs it into the store, so
      // restoring the folder on disk and returning to the window auto-clears the
      // disable. That re-check is the independent recompute trigger that prevents
      // a disabled composer from stranding recovery (the on-send re-stat is no
      // longer the only path that can clear a restored folder).
      readonly status: "worktree-missing";
      readonly disabledHint: string;
      readonly missingWorkspacePaths: ReadonlyArray<string>;
    };

export const WORKSPACE_COMPOSER_READY: WorkspaceComposerAvailability = {
  status: "ready",
  disabledHint: null,
};

export const NO_WORKSPACE_FOLDER_HINT =
  "Link at least one workspace folder to start.";
export const NO_BOUND_WORKSPACE_FOLDER_HINT =
  "Link at least one workspace folder to continue.";
export const UNRESOLVED_WORKSPACE_FOLDER_HINT =
  "Locate the selected workspace folder on this host to continue.";
export const CHECKING_WORKSPACE_FOLDER_HINT =
  "Checking workspace folders on this host.";
export const WORKSPACE_FOLDER_CHECK_FAILED_HINT =
  "Couldn't check workspace folders on this host. Return to the app to retry.";

/**
 * The disabled-send hint shown when one or more bound folders are missing on
 * disk. Names the offending folders and points at both recoveries (restore on
 * disk, or re-pick in the workspace picker). Phrasing is kept in step with the
 * host's `worktreeMissingMessage` so the composer hint, the recovery toast,
 * and the on-send reject read consistently. The disable lifts automatically
 * once the on-focus `worktree.getBinding` re-check finds the folder restored.
 */
export function worktreeMissingComposerHint(
  missingWorkspacePaths: ReadonlyArray<string>,
): string {
  const list = missingWorkspacePaths.join(", ");
  return missingWorkspacePaths.length === 1
    ? `A bound folder is missing on disk: ${list}. Restore it, or pick another folder in the workspace picker, to send.`
    : `Bound folders are missing on disk: ${list}. Restore them, or pick others in the workspace picker, to send.`;
}

const NO_EFFECTIVE_MISSING_WORKTREE_PATHS: ReadonlyArray<string> = [];

export function effectiveMissingWorktreePaths(
  missingWorktreePaths: ReadonlyArray<string>,
  changedWorkspacePaths: ReadonlySet<string>,
): ReadonlyArray<string> {
  if (changedWorkspacePaths.size === 0) return missingWorktreePaths;
  const next = missingWorktreePaths.filter(
    (path) => !changedWorkspacePaths.has(path),
  );
  if (next.length === missingWorktreePaths.length) return missingWorktreePaths;
  if (next.length === 0) return NO_EFFECTIVE_MISSING_WORKTREE_PATHS;
  return next;
}

const WORKSPACE_COMPOSER_CHECKING: WorkspaceComposerAvailability = {
  status: "checking",
  disabledHint: CHECKING_WORKSPACE_FOLDER_HINT,
};

const WORKSPACE_COMPOSER_EMPTY: WorkspaceComposerAvailability = {
  status: "blocked",
  disabledHint: NO_WORKSPACE_FOLDER_HINT,
};

const WORKSPACE_COMPOSER_UNBOUND: WorkspaceComposerAvailability = {
  status: "blocked",
  disabledHint: NO_BOUND_WORKSPACE_FOLDER_HINT,
};

const WORKSPACE_COMPOSER_UNRESOLVED: WorkspaceComposerAvailability = {
  status: "blocked",
  disabledHint: UNRESOLVED_WORKSPACE_FOLDER_HINT,
};

const WORKSPACE_COMPOSER_RESOLUTION_ERROR: WorkspaceComposerAvailability = {
  status: "blocked",
  disabledHint: WORKSPACE_FOLDER_CHECK_FAILED_HINT,
};

export function workspaceComposerCanStart(
  availability: WorkspaceComposerAvailability,
): boolean {
  // A bound folder missing on disk BLOCKS send (status "worktree-missing"). The
  // disable is safe against the old strand-the-chat deadlock because the chat
  // tile re-checks via an on-focus `worktree.getBinding` refetch (a fresh
  // server-side recompute) and clears the missing set when the folder is
  // restored — so recovery no longer depends on a send the disable would forbid.
  return availability.status === "ready";
}

function deriveWorkspaceFoldersAvailability(
  folders: ReadonlyArray<ResolvedFolder>,
  isResolving: boolean,
  didResolutionFail: boolean,
  allowEmptyFolders: boolean,
): WorkspaceComposerAvailability {
  if (isResolving) return WORKSPACE_COMPOSER_CHECKING;
  if (didResolutionFail) return WORKSPACE_COMPOSER_RESOLUTION_ERROR;
  if (!allowEmptyFolders && folders.length === 0) {
    return WORKSPACE_COMPOSER_EMPTY;
  }
  if (folders.some((folder) => folder.kind === "unresolved")) {
    return WORKSPACE_COMPOSER_UNRESOLVED;
  }
  return WORKSPACE_COMPOSER_READY;
}

export function deriveResolvedWorkspaceAvailability(
  folders: ReadonlyArray<ResolvedFolder>,
  isResolving: boolean,
  didResolutionFail: boolean,
): WorkspaceComposerAvailability {
  return deriveWorkspaceFoldersAvailability(
    folders,
    isResolving,
    didResolutionFail,
    false,
  );
}

export function deriveFolderlessAllowedWorkspaceAvailability(
  folders: ReadonlyArray<ResolvedFolder>,
  isResolving: boolean,
  didResolutionFail: boolean,
): WorkspaceComposerAvailability {
  return deriveWorkspaceFoldersAvailability(
    folders,
    isResolving,
    didResolutionFail,
    true,
  );
}

export function deriveWorktreeBindingWorkspaceAvailability(
  binding: WorktreeBinding | null,
  bindingResolved: boolean,
  epicWorkspaceCount: number | null,
  missingWorktreePaths: ReadonlyArray<string>,
): WorkspaceComposerAvailability {
  if (!bindingResolved) return WORKSPACE_COMPOSER_CHECKING;
  // A bound folder missing on disk → a BLOCKING `worktree-missing` status
  // (checked before "ready" so it wins). Send is disabled with a hint and the
  // missing folder also shows on the picker chip + recovery toast. This pairs
  // with the chat tile's on-focus `worktree.getBinding` re-check: restoring the
  // folder and returning to the window recomputes the missing set fresh and
  // lifts the disable, so disabling here does not strand recovery.
  if (missingWorktreePaths.length > 0) {
    return {
      status: "worktree-missing",
      disabledHint: worktreeMissingComposerHint(missingWorktreePaths),
      missingWorkspacePaths: missingWorktreePaths,
    };
  }
  if (binding?.workspaceMode === "folderless") {
    return WORKSPACE_COMPOSER_READY;
  }
  // An explicit per-chat binding (local or worktree) is directly runnable.
  if (binding !== null && binding.entries.length > 0) {
    return WORKSPACE_COMPOSER_READY;
  }
  // No per-chat binding row: the chat runs in local mode against the epic's
  // workspace folders. The host's `deriveProviderDirectories` falls back to
  // the epic workspace context when the binding is empty, so submit is allowed
  // as long as the epic has at least one folder linked. Gating only on the
  // per-owner binding would block freshly-created chats that never carried a
  // `worktreeIntent` (e.g. created from the epic sidebar).
  if (epicWorkspaceCount === null) return WORKSPACE_COMPOSER_CHECKING;
  if (epicWorkspaceCount === 0) return WORKSPACE_COMPOSER_UNBOUND;
  return WORKSPACE_COMPOSER_READY;
}
