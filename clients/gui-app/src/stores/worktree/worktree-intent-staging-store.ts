import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  type WorktreeBindingOwnerKind,
  type WorktreeEntryScripts,
  type WorktreeFolderIntent,
  type WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  mergeWorktreeIntentEntry,
  removeWorktreeIntentEntry,
  setWorktreeIntentEntryScripts,
} from "@/components/home/host-workspace-selector/worktree-intent-merge";
import { basePersistOptions, worktreeIntentStagingKey } from "@/lib/persist";

/**
 * The *current, not-yet-created* worktree intent for a surface - the pending
 * layer that sits above the host binding (`stagedEntry ?? binding`), so a
 * mid-setup "create worktree" shows before it is materialized at send.
 *
 * Persisted to localStorage (bucketed by the signed-in user's email) so a
 * pending pick survives a mid-setup reload before send - otherwise the row would
 * revert to the binding's mode. Cleared on send (the binding then owns it). The
 * transient launcher / fork scratch slots are NOT persisted: they back one-shot
 * dialogs that are closed on reload, so a restored stale pick there would be
 * confusing - they re-seed fresh on reopen. Client-local only; intent carries
 * local paths and never enters the cloud-synced Chat Y.Doc.
 */
export type WorktreeStagingKey =
  | { readonly surface: "landing"; readonly draftId: string | null }
  | {
      readonly surface: "new-conversation";
      readonly epicId: string;
      // `null` for a top-level conversation; the parent conversation id when the
      // modal is adding a CHILD. Scoping the scratch slot by parent keeps a
      // stale top-level (or other-parent) staged intent from leaking into a
      // child, where it would override the parent's inherited worktree.
      readonly parentId: string | null;
    }
  | {
      readonly surface: "owner";
      readonly epicId: string;
      readonly ownerKind: WorktreeBindingOwnerKind;
      readonly ownerId: string;
    };

// Backstop cap for abandoned (never-sent) staged picks. Clear-on-send handles
// the common case; this bounds pathological growth (FIFO by insertion order).
export const WORKTREE_INTENT_STAGING_CAP = 100;

const PENDING_TERMINAL_AGENT_OWNER_ID = "__pending_terminal_agent__";
const PENDING_FORK_CHAT_OWNER_ID = "__pending_fork_chat__";
// Per-parent child-launcher owner-id prefix. Each chat / terminal-agent row's
// "+" submenu stages under `<prefix><parentId>` so concurrent rows never share
// the single `__pending_terminal_agent__` slot (nor the panel-header root
// create). The serialized owner segment carries the prefix, so the
// scratch-slot persistence guard matches on it the same way it matches the two
// fixed scratch ids above.
const PENDING_CHILD_TERMINAL_AGENT_OWNER_PREFIX =
  "__pending_child_terminal_agent__:";
const PENDING_FORK_TERMINAL_AGENT_OWNER_ID = "__pending_fork_terminal_agent__";

export function worktreeStagingKeyString(key: WorktreeStagingKey): string {
  if (key.surface === "landing") {
    return `landing:${key.draftId ?? ""}`;
  }
  if (key.surface === "new-conversation") {
    return `new-conversation:${key.epicId}:${key.parentId ?? ""}`;
  }
  return `owner:${key.epicId}:${key.ownerKind}:${key.ownerId}`;
}

/**
 * Scratch slot for the in-epic new conversation modal. It is scoped to an epic
 * AND the parent being added to (`null` for a top-level create), and paired with
 * `useNewConversationModalStore`; it persists while the modal is being
 * configured in-session, then clears on send. Scoping by parent keeps a stale
 * top-level / other-parent staged intent from overriding a child's inherited
 * worktree when the same modal reopens in a different context.
 */
export function newConversationModalStagingKey(
  epicId: string,
  parentId: string | null,
): WorktreeStagingKey {
  return { surface: "new-conversation", epicId, parentId };
}

/**
 * Scratch slot for the pre-create terminal-agent launcher dropdown. The
 * launcher has no owner id yet (the agent does not exist until launch), so the
 * key is scoped by the epic it launches into - opening the launcher in epic A
 * then epic B must not bleed A's seeded picks into B. Only one launcher is open
 * at a time per epic, so the epic id alone disambiguates.
 */
export function pendingTerminalAgentStagingKey(
  epicId: string,
): WorktreeStagingKey {
  return {
    surface: "owner",
    epicId,
    ownerKind: "terminal-agent",
    ownerId: PENDING_TERMINAL_AGENT_OWNER_ID,
  };
}

/**
 * Scratch slot for a chat / terminal-agent ROW's "+" terminal-agent submenu,
 * scoped to the spawning PARENT (`parentId`) on top of the epic. A per-parent
 * key (distinct owner id from the shared `__pending_terminal_agent__` launcher
 * and the fork slot) keeps two rows' open submenus from clobbering each other's
 * staged folder picks, and is seeded from the parent's `workspaceFolders` so the
 * picker defaults to the parent's workspace. Transient like the launcher slot:
 * never persisted (see `isPersistableStagingKey`).
 */
export function pendingChildTerminalAgentStagingKey(
  epicId: string,
  parentId: string,
): WorktreeStagingKey {
  return {
    surface: "owner",
    epicId,
    ownerKind: "terminal-agent",
    ownerId: `${PENDING_CHILD_TERMINAL_AGENT_OWNER_PREFIX}${parentId}`,
  };
}

/**
 * Scratch slot for the fork-chat dialog, which configures a worktree for a chat
 * that does not exist yet (its id is minted on submit). Scoped by the epic the
 * fork lands in for the same cross-epic isolation reason as the launcher above.
 */
export function pendingForkChatStagingKey(epicId: string): WorktreeStagingKey {
  return {
    surface: "owner",
    epicId,
    ownerKind: "chat",
    ownerId: PENDING_FORK_CHAT_OWNER_ID,
  };
}

export function pendingForkTerminalAgentStagingKey(
  epicId: string,
): WorktreeStagingKey {
  return {
    surface: "owner",
    epicId,
    ownerKind: "terminal-agent",
    ownerId: PENDING_FORK_TERMINAL_AGENT_OWNER_ID,
  };
}

interface WorktreeIntentStagingStore {
  // Values are possibly-undefined: most keys have nothing staged, and indexing
  // a missing key must narrow to `undefined` at the call sites.
  readonly intentByKey: Readonly<Record<string, WorktreeIntent | undefined>>;
  /** Merge one folder's intent into the staged intent for `key`. */
  readonly stageEntry: (
    key: WorktreeStagingKey,
    entry: WorktreeFolderIntent,
  ) => void;
  /** Merge every entry of `intent` into the staged intent for `key`. */
  readonly stageIntent: (
    key: WorktreeStagingKey,
    intent: WorktreeIntent,
  ) => void;
  /** Replace the staged intent for `key` wholesale (`null` / empty clears it). */
  readonly setIntent: (
    key: WorktreeStagingKey,
    intent: WorktreeIntent | null,
  ) => void;
  /** Drop a single workspace's staged entry; clears the key once empty. */
  readonly unstageEntry: (
    key: WorktreeStagingKey,
    workspacePath: string,
  ) => void;
  /**
   * Set the `scripts` override on the staged `worktree` entry for
   * `workspacePath`, preserving its branch. No-op when the folder has no staged
   * `worktree` entry (the Environment override only rides a worktree intent).
   */
  readonly stageScripts: (
    key: WorktreeStagingKey,
    workspacePath: string,
    scripts: WorktreeEntryScripts | null,
  ) => void;
  readonly clear: (key: WorktreeStagingKey) => void;
  readonly resetForTests: () => void;
}

export const useWorktreeIntentStagingStore =
  create<WorktreeIntentStagingStore>()(
    persist(
      (set) => ({
        intentByKey: {},
        stageEntry: (key, entry) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            const existing = state.intentByKey[id] ?? null;
            return {
              intentByKey: {
                ...state.intentByKey,
                [id]: mergeWorktreeIntentEntry(existing, entry),
              },
            };
          }),
        stageIntent: (key, intent) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            const existing = state.intentByKey[id] ?? null;
            const merged = intent.entries.reduce<WorktreeIntent>(
              (acc, entry) => mergeWorktreeIntentEntry(acc, entry),
              existing ?? { entries: [] },
            );
            return { intentByKey: { ...state.intentByKey, [id]: merged } };
          }),
        setIntent: (key, intent) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            const next = { ...state.intentByKey };
            if (intent === null || intent.entries.length === 0) {
              if (!(id in next)) return state;
              delete next[id];
            } else {
              next[id] = intent;
            }
            return { intentByKey: next };
          }),
        unstageEntry: (key, workspacePath) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            const existing = state.intentByKey[id] ?? null;
            if (existing === null) return state;
            const next = removeWorktreeIntentEntry(existing, workspacePath);
            if (
              next !== null &&
              next.entries.length === existing.entries.length
            ) {
              return state;
            }
            const intentByKey = { ...state.intentByKey };
            if (next === null) {
              delete intentByKey[id];
            } else {
              intentByKey[id] = next;
            }
            return { intentByKey };
          }),
        stageScripts: (key, workspacePath, scripts) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            const existing = state.intentByKey[id] ?? null;
            const next = setWorktreeIntentEntryScripts(
              existing,
              workspacePath,
              scripts,
            );
            if (next === existing) return state;
            return {
              intentByKey: { ...state.intentByKey, [id]: next ?? undefined },
            };
          }),
        clear: (key) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            if (!(id in state.intentByKey)) return state;
            const next = { ...state.intentByKey };
            delete next[id];
            return { intentByKey: next };
          }),
        resetForTests: () => set({ intentByKey: {} }),
      }),
      {
        ...basePersistOptions(worktreeIntentStagingKey(null)),
        storage: createJSONStorage(() => window.localStorage),
        partialize: (state) => ({
          intentByKey: persistableStagingEntries(state.intentByKey),
        }),
      },
    ),
  );

/** Non-hook read of the staged intent for a surface (for getState callers). */
export function readStagedWorktreeIntent(
  key: WorktreeStagingKey,
): WorktreeIntent | null {
  return (
    useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(key)
    ] ?? null
  );
}

// Single source of truth for "this owner id backs a one-shot scratch dialog and
// must never persist": the two fixed launcher/fork ids (exact) plus any
// per-parent child slot (prefix). Checked against the structured owner id, not
// by sniffing the full serialized key.
function isTransientStagingOwnerId(ownerId: string): boolean {
  return (
    ownerId === PENDING_TERMINAL_AGENT_OWNER_ID ||
    ownerId === PENDING_FORK_CHAT_OWNER_ID ||
    ownerId === PENDING_FORK_TERMINAL_AGENT_OWNER_ID ||
    ownerId.startsWith(PENDING_CHILD_TERMINAL_AGENT_OWNER_PREFIX)
  );
}

function isPersistableStagingKey(serializedKey: string): boolean {
  if (serializedKey.startsWith("new-conversation:")) return false;
  // Only `owner:` keys carry an owner id (`landing:` keys always persist).
  // `worktreeStagingKeyString` serializes them as
  // `owner:<epicId>:<ownerKind>:<ownerId>`; epicId (uuid) and ownerKind never
  // contain ':', so the owner id is everything after the third segment.
  const parts = serializedKey.split(":");
  if (parts[0] !== "owner") return true;
  return !isTransientStagingOwnerId(parts.slice(3).join(":"));
}

function persistableStagingEntries(
  intentByKey: Readonly<Record<string, WorktreeIntent | undefined>>,
): Record<string, WorktreeIntent> {
  const entries = Object.entries(intentByKey).flatMap(([key, intent]) =>
    intent !== undefined && isPersistableStagingKey(key)
      ? [[key, intent] as const]
      : [],
  );
  // FIFO backstop: keep the most-recently-inserted keys.
  return Object.fromEntries(entries.slice(-WORKTREE_INTENT_STAGING_CAP));
}
