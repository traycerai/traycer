import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";

/**
 * Phase-1 (client-local) owner-scoped teardown snapshot.
 *
 * Synthesizes the T2 `WorktreeBusyHolder` shape so `TeardownDisclosure` does
 * not know where the list came from. When the host-authoritative
 * `listHolders` minor lands (path-scoped with optional owner filter), only
 * this provider changes.
 *
 * Known gaps vs the T6 inventory, acceptable at gesture time because they
 * are not a user-stoppable thing here, or cannot be proven from GUI state:
 * - host-only `active-run-cwd` marks after a partial rebind
 * - grace-window PTYs (no live session in the terminal store)
 * - TUI-owned (and any other) supervised shells whose host or cwd is
 *   unproven — the resource projection has no cwd and is not
 *   host-attributed, so those rows are omitted rather than over-matched
 */
export type OwnerTeardownShell = {
  readonly id: string;
  readonly description: string;
  readonly command: string | null;
  readonly cwd: string | null;
  readonly live: boolean;
};

export type OwnerTeardownSnapshotInput = {
  readonly ownerRef: WorktreeBusyHolder["ownerRef"];
  readonly ownerLabel: string;
  readonly hasActiveTurn: boolean;
  readonly ptyLive: boolean;
  readonly shells: readonly OwnerTeardownShell[];
  readonly droppedRunDirectories: readonly string[];
};

export function runDirectoryOfBindingEntry(
  entry: WorktreeBindingEntry,
): string {
  return entry.worktreePath ?? entry.workspacePath;
}

export function runDirectoryOfFolderIntent(
  entry: WorktreeFolderIntent,
): string | null {
  if (entry.kind === "import") return entry.worktreePath;
  if (entry.kind === "local") return entry.workspacePath;
  return null;
}

/**
 * Run directories the draft would leave: each staged folder whose next run
 * directory differs from the live binding, plus each pending-removed folder's
 * current run directory. Staged intent is a sparse overlay (changed folders
 * only), so unstaged binding entries are not dropped unless listed in
 * `removedWorkspacePaths`.
 */
export function droppedRunDirectoriesFromDraft(input: {
  readonly binding: WorktreeBinding | null;
  readonly draft: WorktreeIntent | null;
  readonly removedWorkspacePaths: readonly string[];
}): readonly string[] {
  const previousByWorkspace = new Map(
    (input.binding?.entries ?? []).map((entry) => [
      entry.workspacePath,
      runDirectoryOfBindingEntry(entry),
    ]),
  );
  const dropped: string[] = [];
  const seen = new Set<string>();
  const pushDropped = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    dropped.push(path);
  };
  if (input.draft !== null) {
    for (const entry of input.draft.entries) {
      const previous = previousByWorkspace.get(entry.workspacePath);
      if (previous === undefined) continue;
      const next = runDirectoryOfFolderIntent(entry);
      if (next === previous) continue;
      pushDropped(previous);
    }
  }
  for (const workspacePath of input.removedWorkspacePaths) {
    const previous = previousByWorkspace.get(workspacePath);
    if (previous === undefined) continue;
    pushDropped(previous);
  }
  return dropped;
}

export function pathContainsDirectory(
  root: string,
  candidate: string,
): boolean {
  const normalizedRoot = root.replace(/\/+$/, "");
  const normalizedCandidate = candidate.replace(/\/+$/, "");
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

export function snapshotOwnerTeardownHolders(
  input: OwnerTeardownSnapshotInput,
): readonly WorktreeBusyHolder[] {
  const holders: WorktreeBusyHolder[] = [];
  if (input.hasActiveTurn) {
    holders.push({
      ownerRef: input.ownerRef,
      holdKind: "chat-turn",
      activity: "working",
      label: `${input.ownerLabel} is working`,
    });
  }
  if (input.ptyLive) {
    holders.push({
      ownerRef: input.ownerRef,
      holdKind: "terminal-agent-pty",
      activity: "working",
      label: `${input.ownerLabel} will restart in the new folder`,
    });
  }
  for (const shell of input.shells) {
    if (!shell.live) continue;
    if (!shellBelongsToDroppedPaths(shell, input.droppedRunDirectories)) {
      continue;
    }
    holders.push({
      ownerRef: input.ownerRef,
      holdKind: "supervised-shell",
      activity: "working",
      label: shellLabel(shell),
    });
  }
  return holders;
}

function shellBelongsToDroppedPaths(
  shell: OwnerTeardownShell,
  droppedRunDirectories: readonly string[],
): boolean {
  if (droppedRunDirectories.length === 0) return false;
  const cwd = shell.cwd;
  if (cwd === null) return false;
  return droppedRunDirectories.some((root) => pathContainsDirectory(root, cwd));
}

function shellLabel(shell: OwnerTeardownShell): string {
  if (shell.command !== null && shell.command.length > 0) return shell.command;
  if (shell.description.length > 0) return shell.description;
  return "Background shell";
}
