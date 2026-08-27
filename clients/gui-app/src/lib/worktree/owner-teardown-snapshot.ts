import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { pathContainsDirectory as pathIsUnderRoot } from "@/lib/path/cross-platform-path";

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
  readonly queuedMessageCount: number;
  readonly backgroundItemCount: number;
};

export type TeardownStopTarget =
  | {
      readonly kind: "supervised-shell";
      readonly commandId: string;
      readonly holderKey: string;
    }
  | {
      readonly kind: "chat-turn";
      readonly holderKey: string;
    };

export type DisclosedTeardownHolder = WorktreeBusyHolder & {
  readonly holderKey: string;
};

export type OwnerTeardownSnapshot = {
  readonly holders: readonly DisclosedTeardownHolder[];
  readonly stopTargets: readonly TeardownStopTarget[];
};

export function teardownHolderKey(
  holder: WorktreeBusyHolder,
  uniqueId: string | undefined = undefined,
): string {
  const base = `${holder.ownerRef.ownerKind}:${holder.ownerRef.ownerId}:${holder.holdKind}:${holder.label}`;
  return uniqueId === undefined ? base : `${base}:${uniqueId}`;
}

export function teardownHolderRowKey(holder: WorktreeBusyHolder): string {
  if ("holderKey" in holder) {
    return (holder as DisclosedTeardownHolder).holderKey;
  }
  return teardownHolderKey(holder);
}

export function teardownHolderSetDrifted(
  disclosed: readonly WorktreeBusyHolder[],
  live: readonly WorktreeBusyHolder[],
): boolean {
  if (disclosed.length !== live.length) return true;
  const left = disclosed.map(teardownHolderRowKey).sort();
  const right = live.map(teardownHolderRowKey).sort();
  return left.some((key, index) => key !== right[index]);
}

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
  return pathIsUnderRoot(root, candidate);
}

export function snapshotOwnerTeardown(
  input: OwnerTeardownSnapshotInput,
): OwnerTeardownSnapshot {
  const holders: DisclosedTeardownHolder[] = [];
  const stopTargets: TeardownStopTarget[] = [];
  const agentStopClearsOwner = chatTurnWillCallAgentStop(input);
  if (input.hasActiveTurn) {
    const holder = disclosedHolder({
      ownerRef: input.ownerRef,
      holdKind: "chat-turn",
      activity: "working",
      label: chatTurnHolderLabel(input, agentStopClearsOwner),
    });
    holders.push(holder);
    if (agentStopClearsOwner) {
      stopTargets.push({
        kind: "chat-turn",
        holderKey: holder.holderKey,
      });
    }
  }
  if (input.ptyLive) {
    holders.push(
      disclosedHolder({
        ownerRef: input.ownerRef,
        holdKind: "terminal-agent-pty",
        activity: "working",
        label: `${input.ownerLabel} will restart in the new folder`,
      }),
    );
  }
  for (const shell of input.shells) {
    if (!shell.live) continue;
    if (
      !agentStopClearsOwner &&
      !shellBelongsToDroppedPaths(shell, input.droppedRunDirectories)
    ) {
      continue;
    }
    const holder = disclosedHolder(
      {
        ownerRef: input.ownerRef,
        holdKind: "supervised-shell",
        activity: "working",
        label: shellLabel(shell),
      },
      shell.id,
    );
    holders.push(holder);
    // agent.stop already awaits stopCommandsForAgent for every owner
    // shell. Expanded consequence rows are disclosure-only so a
    // follow-up managedCommand.stop cannot reject after teardown
    // succeeded and block the binding commit.
    if (!agentStopClearsOwner) {
      stopTargets.push({
        kind: "supervised-shell",
        commandId: shell.id,
        holderKey: holder.holderKey,
      });
    }
  }
  return { holders, stopTargets };
}

function disclosedHolder(
  holder: WorktreeBusyHolder,
  uniqueId: string | undefined = undefined,
): DisclosedTeardownHolder {
  return { ...holder, holderKey: teardownHolderKey(holder, uniqueId) };
}

export function snapshotOwnerTeardownHolders(
  input: OwnerTeardownSnapshotInput,
): readonly WorktreeBusyHolder[] {
  return snapshotOwnerTeardown(input).holders;
}

function chatTurnWillCallAgentStop(input: OwnerTeardownSnapshotInput): boolean {
  return input.hasActiveTurn && input.ownerRef.ownerKind === "chat";
}

function chatTurnHolderLabel(
  input: OwnerTeardownSnapshotInput,
  agentStopClearsOwner: boolean,
): string {
  const base = `${input.ownerLabel} is working`;
  if (!agentStopClearsOwner) return base;
  const named: string[] = [];
  if (input.queuedMessageCount === 1) named.push("1 queued message");
  if (input.queuedMessageCount > 1) {
    named.push(`${input.queuedMessageCount} queued messages`);
  }
  if (input.backgroundItemCount === 1) named.push("1 background item");
  if (input.backgroundItemCount > 1) {
    named.push(`${input.backgroundItemCount} background items`);
  }
  if (named.length > 0) {
    return `${base}. Stopping it also clears ${named.join(" and ")}`;
  }
  return `${base}. Stopping the agent also stops its background shells and clears queued messages`;
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
