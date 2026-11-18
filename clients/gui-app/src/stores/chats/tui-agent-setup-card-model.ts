import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeSetupState,
} from "@traycer/protocol/host/worktree-schemas";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import type {
  SetupCardViewModel,
  SetupCardWorkspace,
  SetupWorkspaceState,
} from "@/components/chat/segments/setup-card-segment";
import { rollupState } from "./setup-card-rows";

/**
 * Build the setup-card view-model for a terminal (TUI) agent from its current
 * worktree binding, so the tile can render the SAME `SetupCardSegment` a chat
 * shows - the "Worktree ready / Setting up worktree / Setup failed" notice -
 * without a chat transcript of `setup.*` events to derive from.
 *
 * A terminal-agent never subscribes to `chat.subscribe`, so there are no setup
 * events; `worktree.getBinding` is the only source. Every field the card needs
 * (state, branch, worktree path, exit code, setup terminal id) already rides on
 * each binding entry, so this is a pure projection - no protocol change.
 *
 * Only a worktree this agent CREATED gets a card: Local folders (no
 * create/setup step) and IMPORTED (adopted, pre-existing) worktrees are both
 * skipped. `isImported` is the reliable discriminator - the create paths that
 * make a fresh worktree (`orchestrator.resolveIntent`) persist
 * `isImported: false`, while adopting an on-disk worktree persists
 * `isImported: true`, and neither is recomputed on reopen. This mirrors the
 * chat deriver, which likewise suppresses imported entries
 * (`bindingTransitionEvent` returns null for `isImported`), so an agent bound
 * to a pre-existing worktree shows no "creation" notice.
 *
 * There is also no `creating` state: by the time a binding row exists the
 * `git worktree add` has finished (it runs host-side before the agent record,
 * often as `not_required` setup), so the card opens at `setting-up`/`ready`.
 *
 * Returns null when there is nothing to show (no binding, or no created
 * worktree entry), so the caller can render nothing.
 */
export function buildTuiAgentSetupCardModel(
  binding: WorktreeBinding | null,
  owner: { readonly epicId: string; readonly ownerId: string },
): SetupCardViewModel | null {
  if (binding === null) return null;
  const created = binding.entries.filter(
    (entry) => entry.mode === "worktree" && !entry.isImported,
  );
  if (created.length === 0) return null;

  const workspaces = created.map(toSetupCardWorkspace);
  // Seed the live elapsed counter from the earliest created worktree.
  const createdAt = created.reduce(
    (earliest, entry) => Math.min(earliest, entry.createdAt),
    created[0].createdAt,
  );
  // Live (spinner + ticking elapsed) only while a setup script is still
  // running; a settled `ready`/`failed`/`cancelled` binding is not in flight.
  const isActive = workspaces.some(
    (workspace) => workspace.state === "setting-up",
  );

  return {
    aggregate: {
      epicId: owner.epicId,
      ownerId: owner.ownerId,
      ownerKind: "terminal-agent",
      state: rollupState(workspaces),
    },
    workspaces,
    createdAt,
    isActive,
  };
}

function toSetupCardWorkspace(entry: WorktreeBindingEntry): SetupCardWorkspace {
  return {
    workspacePath: entry.workspacePath,
    label: workspaceFolderName(entry.workspacePath),
    state: setupWorkspaceStateFor(entry.setupState),
    // The card only surfaces the exit code for a `failed` workspace; pass it
    // through verbatim (null for every other state).
    setupExitCode: entry.setupExitCode,
    terminalSessionId: entry.setupTerminalSessionId,
    worktreePath: entry.worktreePath,
    branch: entry.branch,
    // Binding entries carry no failure reason or attempted intent - those live
    // on the chat's `setup.failed` events, which this binding-derived model
    // never sees. Script failures here surface the exit code + terminal.
    errorMessage: null,
    retryFolderIntent: null,
  };
}

/**
 * Map the persisted `WorktreeSetupState` onto the card's `SetupWorkspaceState`.
 * `pending`/`running` both read as the script phase (`setting-up`); a worktree
 * with no setup script (`not_required`) is simply ready. `creating` is never
 * produced here - see the module doc.
 */
function setupWorkspaceStateFor(
  setupState: WorktreeSetupState,
): SetupWorkspaceState {
  switch (setupState) {
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "succeeded":
    case "not_required":
      return "ready";
    case "pending":
    case "running":
      return "setting-up";
  }
}
