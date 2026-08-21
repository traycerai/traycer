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
  setWorktreeIntentEntryBranchName,
  setWorktreeIntentEntryScripts,
} from "@/components/home/host-workspace-selector/worktree-intent-merge";
import { basePersistOptions, worktreeIntentStagingKey } from "@/lib/persist";
import {
  worktreeFolderIntentReferencesRemoved,
  type RemovedWorktreeRefs,
} from "@/lib/worktree/removed-worktree-refs";

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
 *
 * Every slot carries the HOST it stages for. A staged intent is a list of
 * host-local `workspacePath`s and branch names, and the surfaces that own the
 * non-owner slots switch hosts in place - the landing composer follows the
 * app-wide host its picker rebinds, and the modal / launcher / fork slots are
 * keyed by epic plus a fixed scratch id. Without the host coordinate those
 * slots are shared across machines, so a pick made on host A shows on host B
 * for any path the two happen to have in common, and one host's worktree
 * removal purges the other's staged pick.
 *
 * `null` is the unresolved-host bucket, not a wildcard: it never collides with
 * a real host's slot. It is effectively unreachable for a folder pick (with no
 * host there are no resolved folders to pick), and exists so a surface can key
 * a slot before its host settles.
 *
 * MOST `owner` slots' `ownerId` implies one host for life, so their host
 * segment is redundant for isolation - it is carried anyway so the purge can
 * scope by host without asking each slot's owner which host it belongs to.
 *
 * The fork-chat scratch slot is the exception, and the reason this is worded as
 * "most" rather than "every": the fork dialog lets the user retarget another
 * machine while it is open, so that slot's host is a live choice rather than a
 * property of its owner, and the segment is its ONLY isolation. Treat a new
 * scratch slot as this case unless its owner id is minted per host.
 */
export type WorktreeStagingKey =
  | {
      readonly surface: "landing";
      readonly hostId: string | null;
      readonly draftId: string | null;
    }
  | {
      readonly surface: "new-conversation";
      readonly hostId: string | null;
      readonly epicId: string;
      // `null` for a top-level conversation; the parent conversation id when the
      // modal is adding a CHILD. Scoping the scratch slot by parent keeps a
      // stale top-level (or other-parent) staged intent from leaking into a
      // child, where it would override the parent's inherited worktree.
      readonly parentId: string | null;
    }
  | {
      readonly surface: "owner";
      readonly hostId: string | null;
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

// The host segment sits right after the surface tag and is percent-encoded, so
// a `:` inside a host id can never split the key (the rule
// `lib/persist/keys.ts` applies to its own id segments). An EMPTY segment is
// the unresolved-host bucket - `encodeURIComponent` of a non-empty id is
// non-empty, so the two can never be confused.
function stagingKeyHostSegment(hostId: string | null): string {
  return hostId === null ? "" : encodeURIComponent(hostId);
}

export function worktreeStagingKeyString(key: WorktreeStagingKey): string {
  const host = stagingKeyHostSegment(key.hostId);
  if (key.surface === "landing") {
    return `landing:${host}:${key.draftId ?? ""}`;
  }
  if (key.surface === "new-conversation") {
    return `new-conversation:${host}:${key.epicId}:${key.parentId ?? ""}`;
  }
  return `owner:${host}:${key.epicId}:${key.ownerKind}:${key.ownerId}`;
}

// One slot's identity with the host stripped, so every host's copy of the same
// landing draft / modal / owner slot compares equal. Blanking the segment
// rather than dropping it keeps the segment COUNT stable, so this can never
// conflate two different surfaces' keys.
function hostAgnosticStagingId(serializedKey: string): string {
  const parts = serializedKey.split(":");
  if (parts.length < 2) return serializedKey;
  parts[1] = "";
  return parts.join(":");
}

// `template`'s identity carrying `serializedKey`'s OWN host segment.
function withStagingHostOf(template: string, serializedKey: string): string {
  const parts = template.split(":");
  if (parts.length < 2) return template;
  parts[1] = serializedKey.split(":")[1] ?? "";
  return parts.join(":");
}

// Compared in ENCODED form so no serialized key is ever decoded - a
// hand-edited payload could carry a malformed escape, and `decodeURIComponent`
// throws on one.
function serializedStagingKeyHostSegment(serializedKey: string): string {
  return serializedKey.split(":")[1] ?? "";
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
  hostId: string | null,
  epicId: string,
  parentId: string | null,
): WorktreeStagingKey {
  return { surface: "new-conversation", hostId, epicId, parentId };
}

/**
 * Scratch slot for the pre-create terminal-agent launcher dropdown. The
 * launcher has no owner id yet (the agent does not exist until launch), so the
 * key is scoped by the epic it launches into - opening the launcher in epic A
 * then epic B must not bleed A's seeded picks into B. Only one launcher is open
 * at a time per epic, so the epic id alone disambiguates.
 */
export function pendingTerminalAgentStagingKey(
  hostId: string | null,
  epicId: string,
): WorktreeStagingKey {
  return {
    surface: "owner",
    hostId,
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
  hostId: string | null,
  epicId: string,
  parentId: string,
): WorktreeStagingKey {
  return {
    surface: "owner",
    hostId,
    epicId,
    ownerKind: "terminal-agent",
    ownerId: `${PENDING_CHILD_TERMINAL_AGENT_OWNER_PREFIX}${parentId}`,
  };
}

/**
 * Scratch slot for the fork-chat dialog, which configures a worktree for a chat
 * that does not exist yet (its id is minted on submit). Scoped by the epic the
 * fork lands in for the same cross-epic isolation reason as the launcher above.
 *
 * This is the one `owner` slot whose host segment is NOT redundant. The type's
 * own doc notes that an `ownerId` usually implies one host for life — true of
 * every other owner slot, and false here: the fork dialog lets the user retarget
 * another machine while it is open, so this slot's host is a live choice rather
 * than a property of its owner. The host coordinate is what keeps folders staged
 * against one machine out of a submit against another.
 */
export function pendingForkChatStagingKey(
  hostId: string | null,
  epicId: string,
): WorktreeStagingKey {
  return {
    surface: "owner",
    hostId,
    epicId,
    ownerKind: "chat",
    ownerId: PENDING_FORK_CHAT_OWNER_ID,
  };
}

/**
 * Every fork-chat scratch slot in this epic, whatever host each was staged
 * against — what a caller needs to start (or finish) a fork dialog clean
 * without knowing which hosts the last one visited.
 *
 * Because the dialog can retarget, "clear the fork scratch state" is not a
 * single key a caller can name: an opener that cleared only its own tab's host
 * would leave a previous dialog's other-machine folders staged for the next
 * open.
 *
 * `extraSerializedKeyIds` folds in the key space of a SIBLING store keyed by the
 * same `WorktreeStagingKey` (the seeded-workspace snapshot store), so a slot
 * holding a snapshot but no staged intent is still found. Key serialization
 * stays here rather than leaking to those callers.
 */
export function forkChatStagingKeysForEpic(
  epicId: string,
  extraSerializedKeyIds: readonly string[],
): readonly WorktreeStagingKey[] {
  const state = useWorktreeIntentStagingStore.getState();
  const serializedKeys = new Set([
    ...Object.keys(state.intentByKey),
    ...Object.keys(state.suspendedWorkspacePathsByKey),
    ...extraSerializedKeyIds,
  ]);
  const hostIds = new Set<string | null>();
  for (const serializedKey of serializedKeys) {
    // Parsed against `owner:<host>:<epic>:<ownerKind>:<ownerId>` - the same
    // segment layout the persistability filter and the purge count from, so a
    // new segment moves all three together.
    const parts = serializedKey.split(":");
    if (parts.length !== 5) continue;
    if (parts[0] !== "owner" || parts[2] !== epicId) continue;
    if (parts[3] !== "chat" || parts[4] !== PENDING_FORK_CHAT_OWNER_ID)
      continue;
    const hostSegment = parts[1] ?? "";
    if (hostSegment.length === 0) {
      hostIds.add(null);
      continue;
    }
    // The only decode in this file. Everywhere else compares in ENCODED form to
    // stay safe against a malformed escape in a hand-edited payload; here the
    // hostId has to come back out to rebuild a typed key. These slots are
    // transient and never persisted, so the only writer is
    // `worktreeStagingKeyString` itself and the round trip is lossless - but a
    // malformed segment is skipped rather than thrown, since a caller clearing
    // scratch state must not be taken down by one unparseable key.
    try {
      hostIds.add(decodeURIComponent(hostSegment));
    } catch {
      continue;
    }
  }
  return [...hostIds].map((hostId) =>
    pendingForkChatStagingKey(hostId, epicId),
  );
}

export function pendingForkTerminalAgentStagingKey(
  hostId: string | null,
  epicId: string,
): WorktreeStagingKey {
  return {
    surface: "owner",
    hostId,
    epicId,
    ownerKind: "terminal-agent",
    ownerId: PENDING_FORK_TERMINAL_AGENT_OWNER_ID,
  };
}

interface WorktreeIntentStagingStore {
  // Values are possibly-undefined: most keys have nothing staged, and indexing
  // a missing key must narrow to `undefined` at the call sites.
  readonly intentByKey: Readonly<Record<string, WorktreeIntent | undefined>>;
  readonly suspendedWorkspacePathsByKey: Readonly<
    Record<string, readonly string[] | undefined>
  >;
  /**
   * Monotonic local edit sequence for each staging slot. It is deliberately
   * not persisted: it only distinguishes edits made while an action is in
   * flight in this renderer session.
   */
  readonly revisionByKey: Readonly<Record<string, number | undefined>>;
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
   * Move `fromKey`'s staged intent (and its suspended-paths metadata) onto
   * `toKey`, for a slot whose identity changes out from under it - e.g. the
   * landing composer's `draftId` flipping `null` -> a minted uuid mid-setup,
   * which changes `{surface:"landing", draftId}`'s serialized key. Without
   * this the destination key reads as freshly empty until the seed effect
   * re-derives a default for it, and anything reading `resolved.kind` off
   * that gap (the Environment dialog's `key={seedKey}`) sees a transient
   * "nothing staged" and remounts. No-op when `fromKey` has nothing staged,
   * or when `toKey` already has its own staged intent (never clobber a real
   * pick the destination slot already made).
   *
   * Moves EVERY host's copy of the slot, each onto its own host's destination.
   * What changes here is the draft id, not the host: a landing page the user
   * staged on host A and then switched away from still owns A's slot, and
   * moving only the currently-active host's copy would both lose that pick and
   * strand it under the null-draft key - where the next brand-new landing page
   * on A would inherit it.
   */
  readonly migrateKeyForAllHosts: (
    fromKey: WorktreeStagingKey,
    toKey: WorktreeStagingKey,
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
  /**
   * Replaces the `name` of the staged `worktree` entry's `type: "new"`
   * branch selection for `workspacePath`, preserving everything else.
   * No-op when the folder has no staged `worktree` entry with a `"new"`
   * branch. Used by the Environment dialog's repository-defaults section to
   * offer regenerating one picker's proposed branch name after a repo
   * prefix save.
   */
  readonly stageBranchName: (
    key: WorktreeStagingKey,
    workspacePath: string,
    name: string,
  ) => void;
  /** Fail-closed metadata paths whose staged create/import cannot execute. */
  readonly setSuspendedWorkspacePaths: (
    key: WorktreeStagingKey,
    workspacePaths: readonly string[],
  ) => void;
  readonly clear: (key: WorktreeStagingKey) => void;
  /**
   * `clear` for every host's copy of one slot identity - what CONSUMING a slot
   * means on a surface whose host can change under it (the landing composer,
   * the new-conversation modal). A send/create consumes the whole session, not
   * just the host that happened to be selected at submit: leaving the other
   * hosts' copies alive lets a reopened surface apply a stale pick from an
   * already-consumed session over its fresh seed. Surfaces pinned to one host
   * for life, and scratch slots that already clear per key on a host switch
   * (the terminal-agent launcher), use plain `clear`.
   */
  readonly clearForAllHosts: (key: WorktreeStagingKey) => void;
  /**
   * Drops staged entries that reference just-removed worktrees across every
   * staging slot BELONGING TO `hostId`. Staged picks are deliberately never
   * re-validated by the seeding tiers ("a folder the user already touched is
   * never overwritten"), so without this a pick staged before a worktree was
   * swept keeps offering the deleted worktree verbatim. A slot left empty is
   * cleared like `setIntent(null)`.
   *
   * A removal happens on one machine. Another host's slot can name the same
   * path or branch and still materialize there, so it is left alone; the
   * unresolved-host bucket cannot be shown to belong elsewhere and is purged
   * with the swept host, matching `worktree-intent-memory-store`'s handling of
   * its host-unattributed legacy tier.
   */
  readonly purgeRemovedWorktreeIntents: (
    hostId: string,
    removed: RemovedWorktreeRefs,
  ) => void;
  readonly resetForTests: () => void;
}

function incrementStagingRevision(
  revisionByKey: Readonly<Record<string, number | undefined>>,
  id: string,
): Readonly<Record<string, number | undefined>> {
  return {
    ...revisionByKey,
    [id]: (revisionByKey[id] ?? 0) + 1,
  };
}

export const useWorktreeIntentStagingStore =
  create<WorktreeIntentStagingStore>()(
    persist(
      (set) => ({
        intentByKey: {},
        suspendedWorkspacePathsByKey: {},
        revisionByKey: {},
        stageEntry: (key, entry) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            const existing = state.intentByKey[id] ?? null;
            return {
              intentByKey: {
                ...state.intentByKey,
                [id]: mergeWorktreeIntentEntry(existing, entry),
              },
              revisionByKey: incrementStagingRevision(state.revisionByKey, id),
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
            return {
              intentByKey: { ...state.intentByKey, [id]: merged },
              revisionByKey: incrementStagingRevision(state.revisionByKey, id),
            };
          }),
        setIntent: (key, intent) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            const next = { ...state.intentByKey };
            if (intent === null || intent.entries.length === 0) {
              delete next[id];
              const suspendedWorkspacePathsByKey = {
                ...state.suspendedWorkspacePathsByKey,
              };
              delete suspendedWorkspacePathsByKey[id];
              return {
                intentByKey: next,
                suspendedWorkspacePathsByKey,
                revisionByKey: incrementStagingRevision(
                  state.revisionByKey,
                  id,
                ),
              };
            }
            next[id] = intent;

            return {
              intentByKey: next,
              revisionByKey: incrementStagingRevision(state.revisionByKey, id),
            };
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
            const suspendedWorkspacePathsByKey = {
              ...state.suspendedWorkspacePathsByKey,
            };
            if (next === null) {
              delete intentByKey[id];
              delete suspendedWorkspacePathsByKey[id];
            } else {
              intentByKey[id] = next;
              const suspended = suspendedWorkspacePathsByKey[id];
              if (suspended !== undefined) {
                const remaining = suspended.filter(
                  (path) => path !== workspacePath,
                );
                if (remaining.length === 0) {
                  delete suspendedWorkspacePathsByKey[id];
                } else {
                  suspendedWorkspacePathsByKey[id] = remaining;
                }
              }
            }
            return {
              intentByKey,
              suspendedWorkspacePathsByKey,
              revisionByKey: incrementStagingRevision(state.revisionByKey, id),
            };
          }),
        migrateKeyForAllHosts: (fromKey, toKey) =>
          set((state) => {
            const fromIdentity = hostAgnosticStagingId(
              worktreeStagingKeyString(fromKey),
            );
            const toTemplate = worktreeStagingKeyString(toKey);
            if (fromIdentity === hostAgnosticStagingId(toTemplate))
              return state;

            const intentByKey = { ...state.intentByKey };
            const suspendedWorkspacePathsByKey = {
              ...state.suspendedWorkspacePathsByKey,
            };
            let revisionByKey = state.revisionByKey;
            let changed = false;
            for (const [fromId, existing] of Object.entries(
              state.intentByKey,
            )) {
              if (existing === undefined) continue;
              if (hostAgnosticStagingId(fromId) !== fromIdentity) continue;
              // Each host's copy lands on ITS OWN host's destination slot.
              const toId = withStagingHostOf(toTemplate, fromId);
              // Never clobber a real pick the destination slot already made.
              if (state.intentByKey[toId] !== undefined) continue;

              delete intentByKey[fromId];
              intentByKey[toId] = existing;
              const suspended = suspendedWorkspacePathsByKey[fromId];
              if (suspended !== undefined) {
                delete suspendedWorkspacePathsByKey[fromId];
                suspendedWorkspacePathsByKey[toId] = suspended;
              }
              revisionByKey = incrementStagingRevision(revisionByKey, fromId);
              revisionByKey = incrementStagingRevision(revisionByKey, toId);
              changed = true;
            }
            return changed
              ? { intentByKey, suspendedWorkspacePathsByKey, revisionByKey }
              : state;
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
              revisionByKey: incrementStagingRevision(state.revisionByKey, id),
            };
          }),
        stageBranchName: (key, workspacePath, name) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            const existing = state.intentByKey[id] ?? null;
            const next = setWorktreeIntentEntryBranchName(
              existing,
              workspacePath,
              name,
            );
            if (next === existing) return state;
            return {
              intentByKey: { ...state.intentByKey, [id]: next ?? undefined },
              revisionByKey: incrementStagingRevision(state.revisionByKey, id),
            };
          }),
        setSuspendedWorkspacePaths: (key, workspacePaths) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            const nextPaths = [...new Set(workspacePaths)].sort();
            const current = state.suspendedWorkspacePathsByKey[id] ?? [];
            if (
              current.length === nextPaths.length &&
              current.every((path, index) => path === nextPaths[index])
            ) {
              return state;
            }
            const suspendedWorkspacePathsByKey = {
              ...state.suspendedWorkspacePathsByKey,
            };
            if (nextPaths.length === 0) {
              delete suspendedWorkspacePathsByKey[id];
            } else {
              suspendedWorkspacePathsByKey[id] = nextPaths;
            }
            return { suspendedWorkspacePathsByKey };
          }),
        clear: (key) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            const next = { ...state.intentByKey };
            delete next[id];
            const suspendedWorkspacePathsByKey = {
              ...state.suspendedWorkspacePathsByKey,
            };
            delete suspendedWorkspacePathsByKey[id];
            return {
              intentByKey: next,
              suspendedWorkspacePathsByKey,
              // An explicit clear after a send consumes the slot is still a
              // newer user choice. Record it so a rejected send cannot put the
              // old selection back.
              revisionByKey: incrementStagingRevision(state.revisionByKey, id),
            };
          }),
        clearForAllHosts: (key) =>
          set((state) => {
            const currentId = worktreeStagingKeyString(key);
            const identity = hostAgnosticStagingId(currentId);
            const ids = new Set(
              [
                ...Object.keys(state.intentByKey),
                ...Object.keys(state.suspendedWorkspacePathsByKey),
              ].filter((id) => hostAgnosticStagingId(id) === identity),
            );
            // The caller's own slot always clears, even holding nothing, so the
            // revision bump still records the consume (matching `clear`).
            ids.add(currentId);
            const intentByKey = { ...state.intentByKey };
            const suspendedWorkspacePathsByKey = {
              ...state.suspendedWorkspacePathsByKey,
            };
            let revisionByKey = state.revisionByKey;
            for (const id of ids) {
              delete intentByKey[id];
              delete suspendedWorkspacePathsByKey[id];
              revisionByKey = incrementStagingRevision(revisionByKey, id);
            }
            return { intentByKey, suspendedWorkspacePathsByKey, revisionByKey };
          }),
        purgeRemovedWorktreeIntents: (hostId, removed) =>
          set((state) => {
            let changed = false;
            const sweptSegment = stagingKeyHostSegment(hostId);
            const intentByKey = { ...state.intentByKey };
            const suspendedWorkspacePathsByKey = {
              ...state.suspendedWorkspacePathsByKey,
            };
            let revisionByKey = state.revisionByKey;
            for (const [id, intent] of Object.entries(intentByKey)) {
              if (intent === undefined) continue;
              const slotSegment = serializedStagingKeyHostSegment(id);
              if (slotSegment !== "" && slotSegment !== sweptSegment) continue;
              const entries = intent.entries.filter(
                (entry) =>
                  !worktreeFolderIntentReferencesRemoved(entry, removed),
              );
              if (entries.length === intent.entries.length) continue;
              changed = true;
              if (entries.length === 0) {
                delete intentByKey[id];
                delete suspendedWorkspacePathsByKey[id];
              } else {
                intentByKey[id] = { entries };
                // Drop suspended metadata for the entries that just went away,
                // exactly as `unstageEntry` does. Left behind, a stale
                // fail-closed path would block a later restage of the same
                // workspace.
                const suspended = suspendedWorkspacePathsByKey[id];
                if (suspended !== undefined) {
                  const surviving = new Set(
                    entries.map((entry) => entry.workspacePath),
                  );
                  const remaining = suspended.filter((path) =>
                    surviving.has(path),
                  );
                  if (remaining.length === 0) {
                    delete suspendedWorkspacePathsByKey[id];
                  } else if (remaining.length !== suspended.length) {
                    suspendedWorkspacePathsByKey[id] = remaining;
                  }
                }
              }
              // Bumped like every other slot write so a rejected in-flight
              // action can't restore the just-purged selection.
              revisionByKey = incrementStagingRevision(revisionByKey, id);
            }
            return changed
              ? { intentByKey, suspendedWorkspacePathsByKey, revisionByKey }
              : state;
          }),
        resetForTests: () =>
          set({
            intentByKey: {},
            suspendedWorkspacePathsByKey: {},
            revisionByKey: {},
          }),
      }),
      {
        ...basePersistOptions(worktreeIntentStagingKey(null)),
        version: 2,
        storage: createJSONStorage(() => window.localStorage),
        partialize: (state) => ({
          intentByKey: persistableStagingEntries(state.intentByKey),
        }),
        // v1 -> v2 added the host segment to every serialized key. A v1 key
        // cannot be attributed to a host (that is the defect), and keeping one
        // would leave a slot no live key can ever address while the purge read
        // its draft/epic id as a host. Dropped instead: these are pending,
        // not-yet-sent picks, so the cost is one mid-setup selection reverting
        // to the binding's mode on the upgrade, and the picker re-seeds a
        // default immediately.
        migrate: () => ({ intentByKey: {} }),
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

/**
 * Whether ANY host's copy of this slot holds a staged intent - the read that
 * matches `clearForAllHosts`'s reach.
 *
 * A caller that clears every bucket must ask about every bucket: the same slot
 * can hold an intent staged while the surface was pinned to another host, and
 * a check scoped to the currently resolved bucket would report "nothing
 * staged" while the clear deletes it. Pair the two by breadth - a single-bucket
 * `clear` goes with {@link readStagedWorktreeIntent}, and this goes with
 * `clearForAllHosts`.
 */
export function anyHostHasStagedWorktreeIntent(
  key: WorktreeStagingKey,
): boolean {
  const identity = hostAgnosticStagingId(worktreeStagingKeyString(key));
  const intentByKey = useWorktreeIntentStagingStore.getState().intentByKey;
  return Object.keys(intentByKey).some(
    (id) =>
      hostAgnosticStagingId(id) === identity && intentByKey[id] !== undefined,
  );
}

/**
 * Current in-memory edit sequence for a staging slot. Used to make rejected
 * action restoration conditional on no newer selection (including a clear).
 */
export function stagedWorktreeIntentRevision(key: WorktreeStagingKey): number {
  return (
    useWorktreeIntentStagingStore.getState().revisionByKey[
      worktreeStagingKeyString(key)
    ] ?? 0
  );
}

/** True when unresolved host metadata blocks a staged create/import action. */
export function stagedWorktreeIntentIsSuspended(
  key: WorktreeStagingKey,
): boolean {
  const state = useWorktreeIntentStagingStore.getState();
  const id = worktreeStagingKeyString(key);
  const intent = state.intentByKey[id];
  const suspendedPaths = state.suspendedWorkspacePathsByKey[id];
  if (intent === undefined || suspendedPaths === undefined) {
    return false;
  }
  const suspended = new Set(suspendedPaths);
  return intent.entries.some(
    (entry) => entry.kind !== "local" && suspended.has(entry.workspacePath),
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
  // `owner:<host>:<epicId>:<ownerKind>:<ownerId>`; the host segment is
  // percent-encoded and epicId (uuid) and ownerKind never contain ':', so the
  // owner id is everything after the fourth segment.
  const parts = serializedKey.split(":");
  if (parts[0] !== "owner") return true;
  return !isTransientStagingOwnerId(parts.slice(4).join(":"));
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
