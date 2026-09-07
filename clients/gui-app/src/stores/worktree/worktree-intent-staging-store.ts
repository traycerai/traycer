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
 * The *current, not-yet-created* worktree intent for a surface - the pending layer that sits above
 * the host binding (`stagedEntry ??
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
      // `null` for a top-level conversation; the parent conversation id when the modal is adding a
      // CHILD.
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
// Per-parent child-launcher owner-id prefix.
const PENDING_CHILD_TERMINAL_AGENT_OWNER_PREFIX =
  "__pending_child_terminal_agent__:";
const PENDING_FORK_TERMINAL_AGENT_OWNER_ID = "__pending_fork_terminal_agent__";

// The host segment sits right after the surface tag and is percent-encoded, so a `:` inside a host
// id can never split the key (the rule `lib/persist/keys.ts` applies to its own id segments).
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

// One slot's identity with the host stripped, so every host's copy of the same landing draft /
// modal / owner slot compares equal.
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

// Compared in ENCODED form so no serialized key is ever decoded - a hand-edited payload could
// carry a malformed escape, and `decodeURIComponent` throws on one.
function serializedStagingKeyHostSegment(serializedKey: string): string {
  return serializedKey.split(":")[1] ?? "";
}

/** Scratch slot for the in-epic new conversation modal. */
export function newConversationModalStagingKey(
  hostId: string | null,
  epicId: string,
  parentId: string | null,
): WorktreeStagingKey {
  return { surface: "new-conversation", hostId, epicId, parentId };
}

/** Scratch slot for the pre-create terminal-agent launcher dropdown. */
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
 * Scratch slot for a chat / terminal-agent ROW's "+" terminal-agent submenu, scoped to the
 * spawning PARENT (`parentId`) on top of the epic.
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
 * Scratch slot for the fork-chat dialog, which configures a worktree for a chat that does not
 * exist yet (its id is minted on submit).
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
 * Every fork-chat scratch slot in this epic, whatever host each was staged against - what a caller
 * needs to start (or finish) a fork dialog clean without knowing which hosts the last one visited.
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
    // Parsed against `owner:<host>:<epic>:<ownerKind>:<ownerId>` - the same segment layout the
    // persistability filter and the purge count from, so a new segment moves all three together.
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
    // The only decode in this file.
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
   * Monotonic local edit sequence for each staging slot. It is deliberately not persisted: it only
   * distinguishes edits made while an action is in flight in this renderer session.
   */
  readonly revisionByKey: Readonly<Record<string, number | undefined>>;
  /** Whether this slot is empty *because a dispatch consumed it*, with nothing touching it since. */
  readonly consumedForDispatchByKey: Readonly<
    Record<string, DispatchConsumptionMark | undefined>
  >;
  /** Worktree refs swept while a consumption was outstanding, accumulated per slot. */
  readonly sweptRefsByKey: Readonly<
    Record<string, RemovedWorktreeRefs | undefined>
  >;
  /** Take the staged intent for a dispatch, marking the slot as consumed. */
  readonly consumeForDispatch: (
    key: WorktreeStagingKey,
    clientActionId: string,
  ) => void;
  /**
   * Put this slot back exactly as a dispatch that never left the client found it: its pick, and
   * everything its consume DISPLACED.
   */
  readonly rollBackDispatch: (
    key: WorktreeStagingKey,
    restore: {
      readonly intent: WorktreeIntent | null;
      readonly displaced: DisplacedDispatchState;
    },
  ) => void;
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
  /** Stage a pick handed back by a dead dispatch rather than chosen by the user; the difference is what it may clear. */
  /** Take back a pick this dispatch's hand-back staged, when its prompt could not reach the composer. */
  readonly releaseIntentForDispatch: (
    key: WorktreeStagingKey,
    expectedRevision: number,
  ) => void;
  readonly restoreIntentForDispatch: (
    key: WorktreeStagingKey,
    intent: WorktreeIntent,
    clientActionId: string,
  ) => void;
  /** Drop a single workspace's staged entry; clears the key once empty. */
  readonly unstageEntry: (
    key: WorktreeStagingKey,
    workspacePath: string,
  ) => void;
  /**
   * Move `fromKey`'s staged intent (and its suspended-paths metadata) onto `toKey`, for a slot whose
   * identity changes out from under it - e.g.
   */
  readonly migrateKeyForAllHosts: (
    fromKey: WorktreeStagingKey,
    toKey: WorktreeStagingKey,
  ) => void;
  /**
   * Set the `scripts` override on the staged `worktree` entry for `workspacePath`, preserving its
   * branch.
   */
  readonly stageScripts: (
    key: WorktreeStagingKey,
    workspacePath: string,
    scripts: WorktreeEntryScripts | null,
  ) => void;
  /**
   * Replaces the `name` of the staged `worktree` entry's `type: "new"` branch selection for
   * `workspacePath`, preserving everything else.
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
   * `clear` for every host's copy of one slot identity - what CONSUMING a slot means on a surface
   * whose host can change under it (the landing composer, the new-conversation modal).
   */
  readonly clearForAllHosts: (key: WorktreeStagingKey) => void;
  /**
   * Drops staged entries that reference just-removed worktrees across every staging slot BELONGING
   * TO `hostId`.
   */
  readonly purgeRemovedWorktreeIntents: (
    hostId: string,
    removed: RemovedWorktreeRefs,
  ) => void;
  readonly resetForTests: () => void;
}

/** Why a consumed slot is in the state it is in. `"awaiting"` means a dispatch took the pick and may hand it back. */
/** The one outstanding dispatch for a slot: which action took it. */
export interface DispatchConsumptionMark {
  readonly clientActionId: string;
}

/** Record WHAT a sweep removed, per consumed slot, for the hand-backs that have not happened yet. */
function accumulateSweptRefs(
  swept: Readonly<Record<string, RemovedWorktreeRefs | undefined>>,
  marks: Readonly<Record<string, DispatchConsumptionMark | undefined>>,
  sweptSegment: string,
  removed: RemovedWorktreeRefs,
): Readonly<Record<string, RemovedWorktreeRefs | undefined>> {
  const next: Record<string, RemovedWorktreeRefs | undefined> = { ...swept };
  let changed = false;
  for (const id of Object.keys(marks)) {
    if (marks[id] === undefined) continue;
    const slotSegment = serializedStagingKeyHostSegment(id);
    if (slotSegment !== "" && slotSegment !== sweptSegment) continue;
    const prior = next[id];
    next[id] = {
      worktreePaths: new Set([
        ...(prior?.worktreePaths ?? []),
        ...removed.worktreePaths,
      ]),
      branches: [...(prior?.branches ?? []), ...removed.branches],
    };
    changed = true;
  }
  return changed ? next : swept;
}

/** Split a hand-back into what a mid-dispatch sweep took and what it left. */
export interface SweptIntentPartition {
  readonly survivors: WorktreeIntent | null;
  readonly swept: WorktreeIntent | null;
}

export function partitionSweptIntent(
  key: WorktreeStagingKey,
  intent: WorktreeIntent,
): SweptIntentPartition {
  const swept =
    useWorktreeIntentStagingStore.getState().sweptRefsByKey[
      worktreeStagingKeyString(key)
    ];
  if (swept === undefined) return { survivors: intent, swept: null };
  const gone = intent.entries.filter((entry) =>
    worktreeFolderIntentReferencesRemoved(entry, swept),
  );
  if (gone.length === 0) return { survivors: intent, swept: null };
  const kept = intent.entries.filter(
    (entry) => !worktreeFolderIntentReferencesRemoved(entry, swept),
  );
  return {
    survivors: kept.length === 0 ? null : { entries: kept },
    swept: { entries: gone },
  };
}

/** Shared by the mark and its swept-refs companion - one lifetime, one drop. */
function withoutDispatchMark<T>(
  marks: Readonly<Record<string, T | undefined>>,
  id: string,
): Readonly<Record<string, T | undefined>> {
  if (marks[id] === undefined) return marks;
  const next = { ...marks };
  delete next[id];
  return next;
}

/**
 * Whether the slot is empty because THIS action's dispatch took it and nothing has touched it
 * since - the only state in which it may hand its pick back.
 */
export function stagedWorktreeIntentAwaitsDispatchOutcome(
  key: WorktreeStagingKey,
): boolean {
  const id = worktreeStagingKeyString(key);
  const state = useWorktreeIntentStagingStore.getState();
  return (
    state.intentByKey[id] === undefined &&
    state.consumedForDispatchByKey[id] !== undefined
  );
}

/** True when a hand-back is refused because a sweep removed worktrees in flight, not because the user made a newer choice. */
/** Slot state a consume displaces rather than reads - everything {@link WorktreeIntentStagingState.consumeForDispatch} drops that the pick itself does not carry. */
export interface DisplacedDispatchState {
  readonly mark: DispatchConsumptionMark | undefined;
  readonly suspendedWorkspacePaths: readonly string[] | undefined;
}

/**
 * What a dispatch is about to displace, captured so a dispatch that never leaves the client can
 * put it back. See {@link WorktreeIntentStagingState.rollBackDispatch}.
 */
export function stagedDispatchDisplacement(
  key: WorktreeStagingKey,
): DisplacedDispatchState {
  const state = useWorktreeIntentStagingStore.getState();
  const id = worktreeStagingKeyString(key);
  return {
    mark: state.consumedForDispatchByKey[id],
    suspendedWorkspacePaths: state.suspendedWorkspacePathsByKey[id],
  };
}

/**
 * Whether the slot is awaiting THIS action's outcome specifically - the bar a
 * hand-back of the PICK has to clear. See {@link DispatchConsumptionMark}.
 */
export function stagedWorktreeIntentAwaitsDispatchFrom(
  key: WorktreeStagingKey,
  clientActionId: string,
): boolean {
  const mark =
    useWorktreeIntentStagingStore.getState().consumedForDispatchByKey[
      worktreeStagingKeyString(key)
    ];
  return (
    stagedWorktreeIntentAwaitsDispatchOutcome(key) &&
    mark?.clientActionId === clientActionId
  );
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
        consumedForDispatchByKey: {},
        sweptRefsByKey: {},
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
              consumedForDispatchByKey: withoutDispatchMark(
                state.consumedForDispatchByKey,
                id,
              ),
              sweptRefsByKey: withoutDispatchMark(state.sweptRefsByKey, id),
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
              consumedForDispatchByKey: withoutDispatchMark(
                state.consumedForDispatchByKey,
                id,
              ),
              sweptRefsByKey: withoutDispatchMark(state.sweptRefsByKey, id),
            };
          }),
        releaseIntentForDispatch: (key, expectedRevision) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            if ((state.revisionByKey[id] ?? 0) !== expectedRevision) {
              return state;
            }
            const intentByKey = { ...state.intentByKey };
            delete intentByKey[id];
            return {
              intentByKey,
              revisionByKey: incrementStagingRevision(state.revisionByKey, id),
            };
          }),
        restoreIntentForDispatch: (key, intent, clientActionId) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            // Only this dispatch's own records go with the write. Another dispatch's mark - and, critically,
            // its accumulated swept refs - outlive a hand-back that was never about it.
            const ownsMark =
              state.consumedForDispatchByKey[id]?.clientActionId ===
              clientActionId;
            return {
              intentByKey: { ...state.intentByKey, [id]: intent },
              revisionByKey: incrementStagingRevision(state.revisionByKey, id),
              consumedForDispatchByKey: ownsMark
                ? withoutDispatchMark(state.consumedForDispatchByKey, id)
                : state.consumedForDispatchByKey,
              sweptRefsByKey: ownsMark
                ? withoutDispatchMark(state.sweptRefsByKey, id)
                : state.sweptRefsByKey,
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
              consumedForDispatchByKey: withoutDispatchMark(
                state.consumedForDispatchByKey,
                id,
              ),
              sweptRefsByKey: withoutDispatchMark(state.sweptRefsByKey, id),
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
              consumedForDispatchByKey: withoutDispatchMark(
                state.consumedForDispatchByKey,
                id,
              ),
              sweptRefsByKey: withoutDispatchMark(state.sweptRefsByKey, id),
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
              consumedForDispatchByKey: withoutDispatchMark(
                state.consumedForDispatchByKey,
                id,
              ),
              sweptRefsByKey: withoutDispatchMark(state.sweptRefsByKey, id),
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
              consumedForDispatchByKey: withoutDispatchMark(
                state.consumedForDispatchByKey,
                id,
              ),
              sweptRefsByKey: withoutDispatchMark(state.sweptRefsByKey, id),
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
              // An explicit clear after a send consumes the slot is still a newer user choice.
              revisionByKey: incrementStagingRevision(state.revisionByKey, id),
              consumedForDispatchByKey: withoutDispatchMark(
                state.consumedForDispatchByKey,
                id,
              ),
              sweptRefsByKey: withoutDispatchMark(state.sweptRefsByKey, id),
            };
          }),
        consumeForDispatch: (key, clientActionId) =>
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
              revisionByKey: incrementStagingRevision(state.revisionByKey, id),
              // NOT a user choice - the send took it, and may hand it back.
              consumedForDispatchByKey: {
                ...state.consumedForDispatchByKey,
                [id]: { clientActionId },
              },
            };
          }),
        rollBackDispatch: (key, restore) =>
          set((state) => {
            const id = worktreeStagingKeyString(key);
            const intentByKey = { ...state.intentByKey };
            if (
              restore.intent === null ||
              restore.intent.entries.length === 0
            ) {
              delete intentByKey[id];
            } else {
              intentByKey[id] = restore.intent;
            }
            const consumedForDispatchByKey = {
              ...state.consumedForDispatchByKey,
            };
            if (restore.displaced.mark === undefined) {
              delete consumedForDispatchByKey[id];
            } else {
              consumedForDispatchByKey[id] = restore.displaced.mark;
            }
            const suspendedWorkspacePathsByKey = {
              ...state.suspendedWorkspacePathsByKey,
            };
            if (restore.displaced.suspendedWorkspacePaths === undefined) {
              delete suspendedWorkspacePathsByKey[id];
            } else {
              suspendedWorkspacePathsByKey[id] =
                restore.displaced.suspendedWorkspacePaths;
            }
            return {
              intentByKey,
              consumedForDispatchByKey,
              suspendedWorkspacePathsByKey,
              // The dispatch is undone, but the counter is monotonic by construction and nothing compares it -
              // the mark is the only discriminator.
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
                // Drop suspended metadata for the entries that just went away, exactly as `unstageEntry` does.
                // Left behind, a stale fail-closed path would block a later restage of the same workspace.
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
            // Slots CONSUMED by an in-flight dispatch are invisible to the loop above - they hold no intent to
            // filter, because the dispatch took it.
            const sweptRefsByKey = accumulateSweptRefs(
              state.sweptRefsByKey,
              state.consumedForDispatchByKey,
              sweptSegment,
              removed,
            );
            if (sweptRefsByKey !== state.sweptRefsByKey) changed = true;
            return changed
              ? {
                  intentByKey,
                  suspendedWorkspacePathsByKey,
                  revisionByKey,
                  sweptRefsByKey,
                }
              : state;
          }),
        resetForTests: () =>
          set({
            intentByKey: {},
            suspendedWorkspacePathsByKey: {},
            revisionByKey: {},
            consumedForDispatchByKey: {},
            sweptRefsByKey: {},
          }),
      }),
      {
        ...basePersistOptions(worktreeIntentStagingKey(null)),
        version: 2,
        storage: createJSONStorage(() => window.localStorage),
        partialize: (state) => ({
          intentByKey: persistableStagingEntries(state.intentByKey),
        }),
        // v1 -> v2 added the host segment to every serialized key.
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
 * Whether ANY host's copy of this slot holds a staged intent - the read that matches
 * `clearForAllHosts`'s reach.
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

// Single source of truth for "this owner id backs a one-shot scratch dialog and must never
// persist": the two fixed launcher/fork ids (exact) plus any per-parent child slot (prefix).
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
