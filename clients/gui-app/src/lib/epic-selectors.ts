/**
 * Canonical selector + hook surface over the per-Epic projected slices owned by `OpenEpicStore`.
 * This is the single import path for component code - there is no separate compatibility shim.
 */
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createSelector, lruMemoize } from "reselect";
import { v4 as uuidv4 } from "uuid";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { artifactFolderChain } from "@/lib/artifacts/artifact-folder-chain";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import type {
  GuiHarnessId,
  TuiHarnessId,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatRecordRemovalReason } from "@traycer/protocol/host/epic/chat-records";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { displayTitle } from "@/lib/display-title";
import { managedCommandTitle } from "@/lib/managed-commands/managed-command-copy";
import { useManagedCommandOnHost } from "@/stores/managed-commands/managed-commands-for-chat";
import {
  deriveEpicSyncPillState,
  deriveEpicWriteCommandAlert,
  summarizeEpicWriteCommands,
  type EpicHostDirtyState,
  type EpicSyncPillState,
  type EpicWriteCommandAlert,
  type EpicWriteCommandSummary,
} from "@/lib/epic-sync-pill-state";
import {
  agentActivityTiers,
  type AgentActivityTier,
} from "@/lib/agent-activity";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import { useEpicStore } from "@/hooks/use-epic-store";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useTerminalDisplayTitle } from "@/hooks/terminal/use-terminal-display-title";
import { useAgentRolesEnabled } from "@/hooks/runner/use-runner-feature-settings-query";
import {
  useMaybeOpenEpicHandle,
  useOpenEpicHandle,
} from "@/providers/use-open-epic-handle";
import {
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import {
  pendingTitleVisibleAutoPurge,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import {
  isOpenableEpicNodeKind,
  type EpicNodeRef,
} from "@/stores/epics/canvas/types";
import type {
  EpicMigrationSlice,
  OpenEpicState,
  OpenEpicStoreHandle,
  SnapshotFetchError,
} from "@/stores/epics/open-epic/store";
import type { OpenEpicSessionRegistry } from "@/stores/epics/open-epic/session-registry";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  ChatProjection,
  ChatsSlice,
  DeletedArtifactProjection,
  EpicArtifactRoomAvailability,
  EpicTreeNodeType,
  TuiAgentProjection,
  TreeNode,
  TreeSlice,
} from "@/stores/epics/open-epic/types";
import { EMPTY_ARRAY } from "@/stores/epics/open-epic/types";

// ─── Type re-exports ──────────────────────────────────────────────────────

export type EpicArtifactProjection = ArtifactProjection;
export type EpicDeletedArtifactProjection = DeletedArtifactProjection;
export type EpicChatProjection = ChatProjection;
export type EpicTuiAgentProjection = TuiAgentProjection;
export type EpicTreeIndex = TreeSlice;
export type EpicTreeNode = TreeNode;
export type { EpicTreeNodeType };

/**
 * Sidebar-friendly node row that merges artifacts + chats into one sequence.
 * `name` falls back to `Untitled <kind>` so the sidebar always has a label.
 */
export interface EpicTreeRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly type: EpicTreeNodeType;
  readonly status: number | null;
  readonly hostId: string;
}

const EMPTY_RECORDS: ReadonlyArray<EpicTreeRecord> = Object.freeze([]);
const EMPTY_NODES: ReadonlyArray<TreeNode> = Object.freeze([]);
const EMPTY_CHAT_PROJECTIONS: ReadonlyArray<ChatProjection> = Object.freeze([]);
const EMPTY_TERMINAL_AGENT_PROJECTIONS: ReadonlyArray<TuiAgentProjection> =
  Object.freeze([]);
const EMPTY_NODES_AS_ARTIFACTS: ReadonlyArray<ArtifactProjection> =
  Object.freeze([]);
const EMPTY_TREE_ID_ARRAY: readonly string[] = EMPTY_ARRAY;
const EMPTY_TREE_ID_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_ROLE_CLAIMS: readonly RoleClaim[] = Object.freeze([]);
const EMPTY_ROLE_CLAIMS_BY_AGENT_ID: Readonly<
  Record<string, readonly RoleClaim[]>
> = Object.freeze({});

export { EMPTY_TREE_ID_ARRAY, EMPTY_TREE_ID_SET };

// ─── Snapshot meta + connection state ─────────────────────────────────────

export function useEpicSnapshotMeta(): SnapshotMetaEpic | null {
  return useEpicStore((s) => s.snapshotMeta);
}

export function useEpicConnectionStatus(): StreamConnectionStatus {
  return useEpicStore((s) => s.connectionStatus);
}

/**
 * Input (i) of the sync pill on its own - the RAW GUI↔host transport, not the display blend above.
 * The pill's cloud-link grace reads it to tell a cloud-only drop (host reachable, edits durable on the host) apart from a host-link drop (edits exist only in this window), which derive the same `reconnecting` verdict and must not get the same grace.
 */
export function useEpicHostTransportStatus(): StreamConnectionStatus {
  return useEpicStore((s) => s.hostTransportStatus);
}

/**
 * Input (iii) of the sync pill: the control lane's aggregate dirty bit, known only after this open cycle's atomic dirty snapshot.
 * A clean-looking map before then (or on a legacy connection that cannot produce one) is unknown rather than evidence that the cloud has acknowledged everything.
 */
const selectHostDirtyState = createSelector(
  (s: OpenEpicState) => s.hasDirtySnapshotForOpenCycle,
  (s: OpenEpicState) => s.rootDirty,
  (s: OpenEpicState) => s.artifactRoomDirtyByArtifactRoomId,
  (
    hasDirtySnapshotForOpenCycle,
    rootDirty,
    dirtyByArtifactRoomId,
  ): EpicHostDirtyState => {
    if (!hasDirtySnapshotForOpenCycle || rootDirty === null) return "unknown";
    if (rootDirty) return "dirty";
    return Object.values(dirtyByArtifactRoomId).some((dirty) => dirty)
      ? "dirty"
      : "clean";
  },
);

/**
 * Inputs (iv) and (v) of the sync pill, counted per outcome off the projected command list.
 * Memoized at module scope so the two hooks below share one count per publication rather than walking the list twice.
 */
const selectWriteCommandSummary = createSelector(
  (s: OpenEpicState) => s.writeCommands,
  (writeCommands): EpicWriteCommandSummary =>
    summarizeEpicWriteCommands(writeCommands),
);

/**
 * The pill's link/durability claim, over the five inputs of wire-lane invariant 8 rather than the lossy blended `connectionStatus` the pill used to read on its own - see `@/lib/epic-sync-pill-state` for the ordering contract and why each input has to stay.
 */
export function useEpicSyncPillState(): EpicSyncPillState {
  return useEpicStore((s) =>
    deriveEpicSyncPillState({
      hostTransportStatus: s.hostTransportStatus,
      cloudSyncStatus: s.cloudSyncStatus,
      hasFreshCloudSyncStatus: s.hasFreshCloudSyncStatus,
      hostDirtyState: selectHostDirtyState(s),
      hasUnsyncedDocClassChanges: s.isDirty,
      writeCommands: selectWriteCommandSummary(s),
      hasConnectedOnce: s.hasConnectedOnce,
    }),
  );
}

/** The outstanding write commands themselves, for the surface that ACTS on them. */
export function useEpicWriteCommands(): readonly CommandRecord<EpicWriteCommandIntent>[] {
  return useEpicStore((s) => s.writeCommands);
}

/**
 * Input (v) of the sync pill - a refused or superseded write - plus the ambiguous arm of input (iv), as their own verdict.
 */
export function useEpicWriteCommandAlert(): EpicWriteCommandAlert | null {
  return useEpicStore((s) =>
    deriveEpicWriteCommandAlert(selectWriteCommandSummary(s)),
  );
}

/**
 * Input 3 of the sync-pill derivation on its own: `true` only after a genuine `cloudSyncStatus` frame in the CURRENT subscription cycle (reset atomically with the transport reaching `open`).
 */
export function useEpicHasFreshCloudSyncStatus(): boolean {
  return useEpicStore((s) => s.hasFreshCloudSyncStatus);
}

export function useEpicPermissionRole(): PermissionRole | null {
  return useEpicStore((s) => s.permissionRole);
}

export function useEpicSnapshotLoaded(): boolean {
  return useEpicStore((s) => s.snapshotLoaded);
}

export function useEpicChatRecordListAuthoritative(): boolean {
  return useEpicStore((s) => s.chatRecordListAuthoritative);
}

export function useEpicSnapshotFetchError(): SnapshotFetchError | null {
  return useEpicStore((s) => s.snapshotFetchError);
}

export function useEpicRequestFreshSnapshot(): () => void {
  return useEpicStore((s) => s.requestFreshSnapshot);
}

/**
 * Reactive view of the per-epic major-migration slice.
 * The modal subscribes here to decide between idle (don't render), running (show step list), and error (show retry/close) states.
 */
export function useEpicMigrationState(): EpicMigrationSlice {
  return useEpicStore((s) => s.migration);
}

/**
 * Action hook for the migration modal's Retry button.
 * Sends a `retryMigration` client frame and snaps the slice back to running.
 */
export function useEpicRetryMigration(): () => void {
  return useEpicStore((s) => s.retryMigration);
}

export function useEpicLastFocusedArtifactId(): string | null {
  return useEpicStore((s) => s.lastFocusedArtifactId);
}

/**
 * Stable epic id of the open-epic session (the value the surrounding `<EpicSessionProvider>` was mounted with).
 * Reads off the handle, not the store state, so consumers do not subscribe to unrelated store field changes.
 */
export function useOpenEpicId(): string {
  return useOpenEpicHandle().epicId;
}

// ─── Title ────────────────────────────────────────────────────────────────

export function useEpicTitle(): string {
  return useEpicStore((s) => {
    if (s.epic.title.length > 0) return s.epic.title;
    return s.snapshotMeta?.epicLight?.title ?? "";
  });
}

export function useRegisteredEpicTitle(epicId: string | null): string | null {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveEpicTitleFromHandle(handle),
    () => null,
  );
}

export function useRegisteredEpicPermissionRole(
  epicId: string | null,
): PermissionRole | null {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveEpicPermissionRoleFromHandle(handle),
    () => null,
  );
}

export function useRegisteredEpicTitleGenerating(
  epicId: string | null,
): boolean {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  const currentTitle = useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveEpicTitleFromHandle(handle),
    () => null,
  );
  const currentUpdatedAt = useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveEpicUpdatedAtFromHandle(handle),
    () => null,
  );
  return useEpicCanvasStore((s) => {
    if (epicId === null) return false;
    const entry = Object.hasOwn(s.pendingEpicTitles, epicId)
      ? s.pendingEpicTitles[epicId]
      : undefined;
    return pendingTitleVisibleAutoPurge(
      entry,
      currentTitle,
      currentUpdatedAt,
      () => s.clearEpicTitlePending(epicId),
    );
  });
}

function noopSubscribe(): () => void {
  return noopUnsubscribe;
}

function noopUnsubscribe(): void {}

/**
 * Best-available live title for an open-epic handle: the projected Y.Doc title, falling back to the snapshot-meta epicLight title, else `null`.
 * The single source of this precedence - reused by the header strip and the access coordinator so a title-source change can't drift between them.
 */
export function liveEpicTitleFromHandle(
  handle: OpenEpicStoreHandle | null,
): string | null {
  if (handle === null) return null;
  const state = handle.store.getState();
  const title =
    state.epic.title.length > 0
      ? state.epic.title
      : (state.snapshotMeta?.epicLight?.title ?? "");
  return title.length > 0 ? title : null;
}

function liveEpicPermissionRoleFromHandle(
  handle: OpenEpicStoreHandle | null,
): PermissionRole | null {
  return handle?.store.getState().permissionRole ?? null;
}

function liveEpicUpdatedAtFromHandle(
  handle: OpenEpicStoreHandle | null,
): number | null {
  return handle?.store.getState().epic.updatedAt ?? null;
}

// ─── Artifact tree ────────────────────────────────────────────────────────

const artifactRecordCache = new WeakMap<ArtifactProjection, EpicTreeRecord>();
const artifactRecordByIdCache = new Map<string, EpicTreeRecord>();
const chatRecordCache = new WeakMap<ChatProjection, EpicTreeRecord>();
const terminalAgentRecordCache = new WeakMap<
  TuiAgentProjection,
  EpicTreeRecord
>();

function recordForArtifact(
  a: ArtifactProjection,
  hostId: string,
): EpicTreeRecord {
  const cached = artifactRecordCache.get(a);
  if (cached !== undefined && cached.hostId === hostId) return cached;
  const name = displayTitle(a.title, a.kind);
  const cachedById = artifactRecordByIdCache.get(a.id);
  if (
    cachedById !== undefined &&
    cachedById.parentId === a.parentId &&
    cachedById.name === name &&
    cachedById.type === a.kind &&
    cachedById.status === a.status &&
    cachedById.hostId === hostId
  ) {
    artifactRecordCache.set(a, cachedById);
    return cachedById;
  }
  const record: EpicTreeRecord = {
    id: a.id,
    parentId: a.parentId,
    name,
    type: a.kind,
    status: a.status,
    hostId,
  };
  artifactRecordCache.set(a, record);
  artifactRecordByIdCache.set(a.id, record);
  return record;
}

function recordForChat(
  c: ChatProjection,
  fallbackHostId: string,
): EpicTreeRecord {
  const hostId = c.hostId ?? fallbackHostId;
  const cached = chatRecordCache.get(c);
  if (cached !== undefined && cached.hostId === hostId) return cached;
  const record: EpicTreeRecord = {
    id: c.id,
    parentId: c.parentId,
    // Durable Agent tree row: an untitled Chat-interface Agent falls back to
    // "Untitled agent"; `type` stays the interface discriminator.
    name: displayTitle(c.title, "agent"),
    type: "chat",
    status: null,
    hostId,
  };
  chatRecordCache.set(c, record);
  return record;
}

function recordForTerminalAgent(a: TuiAgentProjection): EpicTreeRecord {
  const cached = terminalAgentRecordCache.get(a);
  if (cached !== undefined) return cached;
  const record: EpicTreeRecord = {
    id: a.id,
    parentId: a.parentId,
    // Durable Agent tree row: an untitled Terminal-interface Agent falls back to "Untitled agent" too (harness identity is separate interface metadata, not the title fallback); `type` stays the interface discriminator.
    name: displayTitle(a.title, "agent"),
    type: "terminal-agent",
    status: null,
    hostId: a.hostId,
  };
  terminalAgentRecordCache.set(a, record);
  return record;
}

export function epicTreeRecordForNodeId(
  state: OpenEpicState,
  nodeId: string,
  fallbackHostId: string,
): EpicTreeRecord | null {
  if (Object.hasOwn(state.chats.byId, nodeId)) {
    return recordForChat(state.chats.byId[nodeId], fallbackHostId);
  }
  if (Object.hasOwn(state.tuiAgents.byId, nodeId)) {
    return recordForTerminalAgent(state.tuiAgents.byId[nodeId]);
  }
  if (Object.hasOwn(state.artifacts.byId, nodeId)) {
    return recordForArtifact(state.artifacts.byId[nodeId], fallbackHostId);
  }
  return null;
}

export function epicNodeRefForNodeId(
  state: OpenEpicState,
  nodeId: string,
  fallbackHostId: string,
): EpicNodeRef | null {
  const record = epicTreeRecordForNodeId(state, nodeId, fallbackHostId);
  if (record === null || !isOpenableEpicNodeKind(record.type)) return null;
  return {
    id: record.id,
    instanceId: uuidv4(),
    type: record.type,
    name: record.name,
    hostId: record.hostId,
  };
}

export function useEpicArtifactRecords(): ReadonlyArray<EpicTreeRecord> {
  const handle = useOpenEpicHandle();
  // Artifacts and legacy / optimistic chats fall back to the host that SERVES this projection: the Epic session's, not the app-wide addressable host.
  // Persisted chats keep their own immutable owner host, just like tui-agents; consumers copy this field into tile refs that are bound for life.
  const fallbackHostId =
    getEpicSessionHandleHostId(handle) ?? UNKNOWN_HOST_PLACEHOLDER;
  return useStore(
    handle.store,
    useShallow((s): ReadonlyArray<EpicTreeRecord> => {
      if (
        s.chats.allIds.length === 0 &&
        s.artifacts.allIds.length === 0 &&
        s.tuiAgents.allIds.length === 0
      ) {
        return EMPTY_RECORDS;
      }
      const records: EpicTreeRecord[] = [];
      for (const id of s.chats.allIds) {
        records.push(recordForChat(s.chats.byId[id], fallbackHostId));
      }
      for (const id of s.tuiAgents.allIds) {
        records.push(recordForTerminalAgent(s.tuiAgents.byId[id]));
      }
      for (const id of s.artifacts.allIds) {
        records.push(recordForArtifact(s.artifacts.byId[id], fallbackHostId));
      }
      return records;
    }),
  );
}

export function useEpicHasArtifactRecords(): boolean {
  return useEpicStore(
    (s) =>
      s.chats.allIds.length > 0 ||
      s.artifacts.allIds.length > 0 ||
      s.tuiAgents.allIds.length > 0,
  );
}

export function useEpicTerminalAgent(
  tuiAgentId: string | null,
): TuiAgentProjection | null {
  return useEpicStore((s) => {
    if (tuiAgentId === null) return null;
    if (Object.hasOwn(s.tuiAgents.byId, tuiAgentId)) {
      return s.tuiAgents.byId[tuiAgentId];
    }
    return null;
  });
}

/**
 * Projected chat records for the sidebar / tabs and the initial-chat-handoff adoption check.
 * Single source of truth: the epic Y.Doc projection.
 */
export function useEpicChatRecords(): ReadonlyArray<ChatProjection> {
  const handle = useOpenEpicHandle();
  return useStore(
    handle.store,
    useShallow((s): ReadonlyArray<ChatProjection> => {
      if (s.chats.allIds.length === 0) return EMPTY_CHAT_PROJECTIONS;
      return s.chats.allIds.map((id) => s.chats.byId[id]);
    }),
  );
}

/** Ids of the chats + terminal-agents whose record carries `archivedAt !== null` */
export function useEpicArchivedNodeIds(): ReadonlyArray<string> {
  const handle = useOpenEpicHandle();
  return useStore(
    handle.store,
    useShallow((s): ReadonlyArray<string> => {
      const archived = [
        ...s.chats.allIds.filter((id) => s.chats.byId[id].archivedAt !== null),
        ...s.tuiAgents.allIds.filter(
          (id) => s.tuiAgents.byId[id].archivedAt !== null,
        ),
      ];
      if (archived.length === 0) return EMPTY_TREE_ID_ARRAY;
      return archived.sort();
    }),
  );
}

/** Every chat id this epic's projection holds, nested ones included. */
export function useEpicChatIds(): ReadonlyArray<string> {
  const handle = useOpenEpicHandle();
  return useStore(
    handle.store,
    useShallow((s): ReadonlyArray<string> => {
      if (s.chats.allIds.length === 0) return EMPTY_TREE_ID_ARRAY;
      return [...s.chats.allIds].sort();
    }),
  );
}

/** Ids of every chat + terminal agent this epic's projection currently holds. */
export function useEpicAgentNodeIds(): ReadonlyArray<string> {
  const handle = useOpenEpicHandle();
  const chatIds = useStore(handle.store, (s) => s.chats.allIds);
  const terminalAgentIds = useStore(handle.store, (s) => s.tuiAgents.allIds);
  return useMemo(() => {
    if (chatIds.length === 0 && terminalAgentIds.length === 0) {
      return EMPTY_TREE_ID_ARRAY;
    }
    return [...chatIds, ...terminalAgentIds];
  }, [chatIds, terminalAgentIds]);
}

export function useEpicTerminalAgentRecords(): ReadonlyArray<TuiAgentProjection> {
  const handle = useOpenEpicHandle();
  return useStore(
    handle.store,
    useShallow((s): ReadonlyArray<TuiAgentProjection> => {
      if (s.tuiAgents.allIds.length === 0) {
        return EMPTY_TERMINAL_AGENT_PROJECTIONS;
      }
      return s.tuiAgents.allIds.map((id: string) => s.tuiAgents.byId[id]);
    }),
  );
}

export function useEpicArtifact(
  artifactId: string | null,
): ArtifactProjection | ChatProjection | TuiAgentProjection | null {
  return useEpicStore((s) => {
    if (artifactId === null) return null;
    if (Object.hasOwn(s.artifacts.byId, artifactId)) {
      return s.artifacts.byId[artifactId];
    }
    if (Object.hasOwn(s.chats.byId, artifactId)) {
      return s.chats.byId[artifactId];
    }
    if (Object.hasOwn(s.tuiAgents.byId, artifactId)) {
      return s.tuiAgents.byId[artifactId];
    }
    return null;
  });
}

type EpicAgentProjection = ChatProjection | TuiAgentProjection;

const MIN_AGENT_REFERENCE_PREFIX_LENGTH = 4;

function exactEpicAgent(
  state: Pick<OpenEpicState, "chats" | "tuiAgents">,
  agentId: string,
): EpicAgentProjection | null {
  if (Object.hasOwn(state.chats.byId, agentId)) {
    return state.chats.byId[agentId];
  }
  if (Object.hasOwn(state.tuiAgents.byId, agentId)) {
    return state.tuiAgents.byId[agentId];
  }
  return null;
}

/**
 * Resolves the agent-id syntax accepted by the host: exact id first, then a unique case-sensitive prefix of at least four characters.
 * Role-claim ids and artifact ids are deliberately outside this candidate set.
 */
function resolveEpicAgentReference(
  state: Pick<OpenEpicState, "chats" | "tuiAgents">,
  referenceId: string,
): EpicAgentProjection | null {
  const exact = exactEpicAgent(state, referenceId);
  if (exact !== null) return exact;
  if (referenceId.length < MIN_AGENT_REFERENCE_PREFIX_LENGTH) return null;

  let matchedId: string | null = null;
  for (const candidateId of [
    ...state.chats.allIds,
    ...state.tuiAgents.allIds,
  ]) {
    if (!candidateId.startsWith(referenceId)) continue;
    if (matchedId !== null && matchedId !== candidateId) return null;
    matchedId = candidateId;
  }
  return matchedId === null ? null : exactEpicAgent(state, matchedId);
}

export function useEpicAgentReference(
  referenceId: string,
): EpicAgentProjection | null {
  return useEpicStore((state) => resolveEpicAgentReference(state, referenceId));
}

export function useEpicLiveArtifactTitle(
  artifactId: string | null,
): string | null {
  return useEpicStore((s) => {
    if (artifactId === null) return null;
    if (Object.hasOwn(s.artifacts.byId, artifactId)) {
      const title = s.artifacts.byId[artifactId].title;
      return title.length > 0 ? title : null;
    }
    if (Object.hasOwn(s.chats.byId, artifactId)) {
      const title = s.chats.byId[artifactId].title;
      return title.length > 0 ? title : null;
    }
    if (Object.hasOwn(s.tuiAgents.byId, artifactId)) {
      const title = s.tuiAgents.byId[artifactId].title;
      return title.length > 0 ? title : null;
    }
    return null;
  });
}

/**
 * Live artifact title for an epic session that may be mounted elsewhere in the app.
 * Global surfaces (for example, the resource monitor) live outside an `EpicSessionProvider`, but must use the same Y.Doc-backed title that a canvas tab uses instead of its persisted opening-name snapshot.
 */
export function useRegisteredEpicLiveArtifactTitle(
  epicId: string,
  artifactId: string | null,
): string | null {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.peek(epicId),
    () => null,
  );
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveArtifactTitleFromHandle(handle, artifactId),
    () => null,
  );
}

export interface RegisteredEpicAgentRef {
  readonly epicId: string;
  /** Chat or terminal-agent id; `null` for a ref with no agent to resolve. */
  readonly agentId: string | null;
}

/**
 * What an epic's live projection knows about one agent: which slice it lives in (`chats` → `chat`, `tuiAgents` → `terminal-agent`), its Y.Doc title (`null` while untitled) and its recorded host (`null` for a legacy chat that predates the field).
 */
export interface RegisteredEpicLiveAgent {
  readonly kind: "chat" | "terminal-agent";
  readonly title: string | null;
  readonly hostId: string | null;
}

/**
 * Reactive live agent projections for a dynamic collection of agent refs.
 * Global list surfaces (the resource monitor) live outside any `EpicSessionProvider` and cannot call a per-agent hook in a data-dependent loop, so this subscribes once to the registry and every currently referenced epic.
 */
export function useRegisteredEpicLiveAgents(
  refs: readonly RegisteredEpicAgentRef[],
): readonly (RegisteredEpicLiveAgent | null)[] {
  const registry = getOpenEpicRegistry();
  const encodedAgents = useSyncExternalStore(
    (listener) => {
      const unsubscribeByHandle = new Map<object, () => void>();
      const reconcileHandleSubscriptions = () => {
        const currentHandles = new Set<object>();
        for (const ref of refs) {
          const handle = registry.peek(ref.epicId);
          if (handle === null || currentHandles.has(handle)) continue;
          currentHandles.add(handle);
          if (!unsubscribeByHandle.has(handle)) {
            unsubscribeByHandle.set(handle, handle.store.subscribe(listener));
          }
        }
        for (const [handle, unsubscribe] of unsubscribeByHandle) {
          if (currentHandles.has(handle)) continue;
          unsubscribe();
          unsubscribeByHandle.delete(handle);
        }
      };
      reconcileHandleSubscriptions();
      const unsubscribeRegistry = registry.subscribe(() => {
        reconcileHandleSubscriptions();
        listener();
      });
      return () => {
        unsubscribeRegistry();
        for (const unsubscribe of unsubscribeByHandle.values()) unsubscribe();
      };
    },
    () => registeredAgentsSnapshot(registry, refs),
    () => JSON.stringify(refs.map(() => null)),
  );
  return useMemo(() => decodeRegisteredAgents(encodedAgents), [encodedAgents]);
}

/**
 * Encoded per-ref tuples (`[kind, title, hostId]`, or `null`) so `useSyncExternalStore` compares by value: the registry and every store notify on unrelated changes, and a fresh array per notification would re-render the whole list surface each time.
 */
function registeredAgentsSnapshot(
  registry: OpenEpicSessionRegistry,
  refs: readonly RegisteredEpicAgentRef[],
): string {
  return JSON.stringify(
    refs.map((ref) => {
      const agent = liveAgentFromHandle(registry.peek(ref.epicId), ref.agentId);
      return agent === null ? null : [agent.kind, agent.title, agent.hostId];
    }),
  );
}

function decodeRegisteredAgents(
  encodedAgents: string,
): readonly (RegisteredEpicLiveAgent | null)[] {
  const decoded: unknown = JSON.parse(encodedAgents);
  if (!Array.isArray(decoded)) return [];
  return decoded.map((entry): RegisteredEpicLiveAgent | null => {
    if (!Array.isArray(entry)) return null;
    const kind: unknown = entry[0];
    const title: unknown = entry[1];
    const hostId: unknown = entry[2];
    if (kind !== "chat" && kind !== "terminal-agent") return null;
    return {
      kind,
      title: typeof title === "string" ? title : null,
      hostId: typeof hostId === "string" ? hostId : null,
    };
  });
}

function liveAgentFromHandle(
  handle: OpenEpicStoreHandle | null,
  agentId: string | null,
): RegisteredEpicLiveAgent | null {
  if (handle === null || agentId === null) return null;
  const state = handle.store.getState();
  if (Object.hasOwn(state.chats.byId, agentId)) {
    const chat = state.chats.byId[agentId];
    return {
      kind: "chat",
      title: chat.title.length > 0 ? chat.title : null,
      hostId: chat.hostId,
    };
  }
  if (Object.hasOwn(state.tuiAgents.byId, agentId)) {
    const agent = state.tuiAgents.byId[agentId];
    return {
      kind: "terminal-agent",
      title: agent.title.length > 0 ? agent.title : null,
      hostId: agent.hostId,
    };
  }
  return null;
}

function liveArtifactTitleFromHandle(
  handle: OpenEpicStoreHandle | null,
  artifactId: string | null,
): string | null {
  if (handle === null || artifactId === null) return null;
  const state = handle.store.getState();
  if (Object.hasOwn(state.artifacts.byId, artifactId)) {
    const title = state.artifacts.byId[artifactId].title;
    return title.length > 0 ? title : null;
  }
  if (Object.hasOwn(state.chats.byId, artifactId)) {
    const title = state.chats.byId[artifactId].title;
    return title.length > 0 ? title : null;
  }
  if (Object.hasOwn(state.tuiAgents.byId, artifactId)) {
    const title = state.tuiAgents.byId[artifactId].title;
    return title.length > 0 ? title : null;
  }
  return null;
}

/**
 * Canonical display title for a canvas tile / node.
 * Live state is the single source of truth - the Y.Doc title for record-backed nodes, the HOST's `terminal.list` rows for terminal tabs (via `useTerminalDisplayTitle`, keyed by the tab's bound host + session id).
 */
type EpicTabDisplayTitleNode = {
  readonly id: string;
  readonly name: string;
  readonly type: string | undefined;
  /** The tab's bound host, for the node kinds that have one. */
  readonly hostId: string | null;
};

export function useEpicTabDisplayTitle(
  node: EpicTabDisplayTitleNode,
  epicId: string,
  terminalHostClient: HostClient<HostRpcRegistry> | null,
): string {
  const liveArtifactTitle = useEpicLiveArtifactTitle(node.id);
  const isTerminal = node.type === "terminal";
  const liveTerminalTitle = useTerminalDisplayTitle({
    client: isTerminal ? terminalHostClient : null,
    epicId: isTerminal ? epicId : null,
    sessionId: isTerminal ? node.id : null,
  });
  // An output window's tile carries no label at all (its persisted shape is just the command pointer), so the kind-explicit title comes from the owning chat's live set - and follows a rename the agent makes.
  const isManagedCommandOutput = node.type === "managed-command-output";
  const managedCommand = useManagedCommandOnHost({
    epicId,
    // The tab's own host, never the epic at large: a clone carries the source transcript's command ids, and a title read across hosts would name a shell this tab cannot open.
    hostId: isManagedCommandOutput ? (node.hostId ?? "") : "",
    commandId: isManagedCommandOutput ? node.id : "",
  });
  const liveManagedCommandTitle =
    managedCommand === null ? null : managedCommandTitle(managedCommand);
  return (
    liveArtifactTitle ??
    liveTerminalTitle ??
    liveManagedCommandTitle ??
    node.name
  );
}

export function useEpicLiveArtifactTitleGenerating(
  artifactId: string | null,
): boolean {
  const currentTitle = useEpicStore((s) => {
    if (artifactId === null) return null;
    if (Object.hasOwn(s.chats.byId, artifactId)) {
      const chat = s.chats.byId[artifactId];
      return chat.title.length > 0 ? chat.title : null;
    }
    return null;
  });
  const currentUpdatedAt = useEpicStore((s) => {
    if (artifactId === null) return null;
    if (Object.hasOwn(s.chats.byId, artifactId)) {
      return s.chats.byId[artifactId].updatedAt;
    }
    return null;
  });
  return useEpicCanvasStore((s) => {
    if (artifactId === null) return false;
    const entry = Object.hasOwn(s.pendingChatTitles, artifactId)
      ? s.pendingChatTitles[artifactId]
      : undefined;
    return pendingTitleVisibleAutoPurge(
      entry,
      currentTitle,
      currentUpdatedAt,
      () => s.clearChatTitlePending(artifactId),
    );
  });
}

/**
 * Returns the live `Y.XmlFragment` backing an artifact's body.
 * The fragment resolves through the artifact's assigned artifact-room doc (`artifact-body:{id}`), not the root Epic doc - see B6 in the artifact-room approach spec.
 */
export function useEpicArtifactFragment(
  artifactId: string | null,
): Y.XmlFragment | null {
  const handle = useOpenEpicHandle();
  // Takes the lease itself.
  // The store's accessor is a pure read - it cannot materialize a cold room, because it runs inside a selector - so a caller that read without pinning would sit in a loading state forever.
  useEpicArtifactBodyLease(artifactId);
  return useStore(handle.store, (s) => {
    if (artifactId === null) return null;
    return s.getArtifactFragment(artifactId);
  });
}

/**
 * Returns the artifact-room-scoped `Awareness` instance hosting `artifactId`'s body presence channel, or `null` until the artifactRoom transitions to `ready`.
 * Used by `CollabTileBody` to feed CollaborationCaret an Awareness instance paired with the artifact-room doc the editor is bound to.
 */
export function useEpicArtifactBodyAwareness(
  artifactId: string | null,
): Awareness | null {
  const handle = useOpenEpicHandle();
  // Same reasoning as `useEpicArtifactFragment`; lease counts are refcounted,
  // so a component using both hooks simply holds two.
  useEpicArtifactBodyLease(artifactId);
  return useStore(handle.store, (s) => {
    if (artifactId === null) return null;
    return s.getArtifactBodyAwareness(artifactId);
  });
}

/**
 * Reports the availability of the artifact-room hosting `artifactId`'s body.
 * Drives the editor's loading/unavailable placeholder when the artifactRoom is still opening or has failed.
 */
export function useEpicArtifactBodyAvailability(
  artifactId: string | null,
): EpicArtifactRoomAvailability {
  const handle = useOpenEpicHandle();
  return useStore(handle.store, (s) => {
    if (artifactId === null) return "unavailable";
    return s.getArtifactBodyAvailability(artifactId);
  });
}

/** Whether the body plane has said ANYTHING about `artifactId` yet. */
export function useEpicArtifactBodySubscribeAnswered(
  artifactId: string | null,
): boolean {
  const handle = useOpenEpicHandle();
  return useStore(handle.store, (s) => {
    if (artifactId === null) return false;
    return Object.hasOwn(s.artifactRooms.stateByArtifactId, artifactId);
  });
}

/**
 * Materializes `artifactId`'s artifact-room and holds it materialized for as long as the calling component is mounted.
 */
export function useEpicArtifactBodyLease(artifactId: string | null): void {
  const handle = useOpenEpicHandle();
  const bodyDocKey = useStore(handle.store, (s) =>
    artifactId === null ? null : s.getArtifactBodyDocKey(artifactId),
  );
  // Layout, not passive: this is what materializes the room, and a passive effect runs after paint - the tile would show its skeleton for a frame before the fragment resolved.
  // A layout effect lands the lease, and the resulting store update, before the browser paints.
  useLayoutEffect(() => {
    if (artifactId === null || bodyDocKey === null) return;
    return handle.store.getState().acquireArtifactBodyLease(artifactId);
  }, [handle, artifactId, bodyDocKey]);
}

// ─── Agent activity (per-user notification-room presence) ─────────────────

export type { AgentActivityTier };

const registeredLiveAgentIdsCache = new WeakMap<
  OpenEpicStoreHandle,
  { readonly ids: ReadonlySet<string>; readonly key: string }
>();

/**
 * The set of agents currently "working" (executing right now) anywhere in the epic, unioned across every host publishing into the user's notification room
 */
export function useEpicActiveAgentIds(): ReadonlySet<string> {
  const epicId = useOpenEpicHandle().epicId;
  return useEpicAgentActivity(epicId).working;
}

/**
 * {@link useEpicActiveAgentIds} with each working agent resolved to its {@link AgentActivityTier}.
 * Prefer this when the caller distinguishes an active turn from background-only work; the id set alone cannot.
 */
export function useEpicAgentActivityTiers(): ReadonlyMap<
  string,
  AgentActivityTier
> {
  const epicId = useOpenEpicHandle().epicId;
  return agentActivityTiers(useEpicAgentActivity(epicId));
}

/**
 * {@link useEpicActiveAgentIds} for surfaces that render outside the open-epic provider (epic tabs, the epics panel, the task list).
 * It no longer resolves a registered session handle - presence for an epic no longer depends on this window having a session for it - but the name is kept so these call sites still read as a set with their `useRegisteredEpic*` neighbours.
 */
export function useRegisteredEpicActiveAgentIds(
  epicId: string | null,
): ReadonlySet<string> {
  return useEpicAgentActivity(epicId).working;
}

/** {@link useRegisteredEpicActiveAgentIds} with each working agent resolved to its {@link AgentActivityTier}. */
export function useRegisteredEpicAgentActivityTiers(
  epicId: string | null,
): ReadonlyMap<string, AgentActivityTier> {
  return agentActivityTiers(useEpicAgentActivity(epicId));
}

/**
 * The agent ids this epic's live projection currently holds, or `null` when this window has no session for the epic at all.
 */
export function useRegisteredEpicLiveAgentIds(
  epicId: string | null,
): ReadonlySet<string> | null {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveAgentIdsSnapshot(handle),
    () => null,
  );
}

function liveAgentIdsSnapshot(
  handle: OpenEpicStoreHandle | null,
): ReadonlySet<string> | null {
  if (handle === null) return null;
  const state = handle.store.getState();
  const key = [...state.chats.allIds, ...state.tuiAgents.allIds]
    .sort()
    .join("\x00");
  const cached = registeredLiveAgentIdsCache.get(handle);
  if (cached !== undefined && cached.key === key) return cached.ids;
  const ids = new Set<string>([
    ...state.chats.allIds,
    ...state.tuiAgents.allIds,
  ]);
  const entry = { ids, key };
  registeredLiveAgentIdsCache.set(handle, entry);
  return entry.ids;
}

// ─── Tree slice hooks ─────────────────────────────────────────────────────

export function useEpicTreeIndex(): TreeSlice {
  return useEpicStore((s) => s.tree);
}

export function useRootIds(): readonly string[] {
  return useEpicStore((s) => s.tree.rootIds);
}

export function useChildIds(parentId: string): readonly string[] {
  return useEpicStore((s) =>
    Object.hasOwn(s.tree.childrenByParent, parentId)
      ? s.tree.childrenByParent[parentId]
      : EMPTY_TREE_ID_ARRAY,
  );
}

export function useEpicTreeNode(id: string): TreeNode | null {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.tree.nodeById, id)) return s.tree.nodeById[id];
    return null;
  });
}

export function useEpicAgentRoleClaims(agentId: string): readonly RoleClaim[] {
  const enabled = useAgentRolesEnabled();
  const claims = useEpicStore((s) =>
    Object.hasOwn(s.agentRoles.byAgentId, agentId)
      ? s.agentRoles.byAgentId[agentId]
      : EMPTY_ROLE_CLAIMS,
  );
  return enabled ? claims : EMPTY_ROLE_CLAIMS;
}

export function useEpicAgentRoleClaimsByAgentId(): Readonly<
  Record<string, readonly RoleClaim[]>
> {
  const enabled = useAgentRolesEnabled();
  const claims = useEpicStore((s) => s.agentRoles.byAgentId);
  return enabled ? claims : EMPTY_ROLE_CLAIMS_BY_AGENT_ID;
}

/**
 * Just this artifact's `status` scalar.
 * Sidebar nodes need it for the status dot on every render; selecting the scalar (instead of `find`-ing it out of the full `useEpicArtifactRecords()` array) keeps the value reference-stable while OTHER records churn - e.g. the active chat streaming - so the.
 */
export function useEpicArtifactStatus(id: string): number | null {
  return useEpicStore((s) =>
    Object.hasOwn(s.artifacts.byId, id) ? s.artifacts.byId[id].status : null,
  );
}

/**
 * Ancestor ids of `nodeId`, nearest first, cycle-guarded.
 * Empty for a root, a null id, or an id the tree does not hold.
 */
export function useAncestorIds(nodeId: string | null): ReadonlySet<string> {
  return useEpicStore(
    useShallow((state: OpenEpicState): ReadonlySet<string> => {
      const nodeById = state.tree.nodeById;
      if (nodeId === null) return EMPTY_TREE_ID_SET;
      if (!Object.hasOwn(nodeById, nodeId)) return EMPTY_TREE_ID_SET;
      const ancestors = new Set<string>();
      let current: string | null = nodeById[nodeId].parentId;
      while (current !== null && !ancestors.has(current)) {
        ancestors.add(current);
        if (!Object.hasOwn(nodeById, current)) break;
        current = nodeById[current].parentId;
      }
      return ancestors.size === 0 ? EMPTY_TREE_ID_SET : ancestors;
    }),
  );
}

export function useDescendantIds(nodeId: string): readonly string[] {
  const index = useEpicTreeIndex();
  return useMemo(() => {
    if (!Object.hasOwn(index.nodeById, nodeId)) return EMPTY_TREE_ID_ARRAY;
    const out: string[] = [];
    const visited = new Set<string>();
    const stack: string[] = [];
    if (Object.hasOwn(index.childrenByParent, nodeId)) {
      const seed = index.childrenByParent[nodeId];
      for (let i = seed.length - 1; i >= 0; i -= 1) {
        stack.push(seed[i]);
      }
    }
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (visited.has(current)) continue;
      visited.add(current);
      out.push(current);
      if (!Object.hasOwn(index.childrenByParent, current)) continue;
      const children = index.childrenByParent[current];
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push(children[i]);
      }
    }
    return out.length === 0 ? EMPTY_TREE_ID_ARRAY : out;
  }, [index, nodeId]);
}

/**
 * This artifact's own root-to-leaf on-disk folder-name chain (ending with its own `folderName`), or `null` when it can't be reconstructed (unknown id, a tree cycle, a non-artifact ancestor, or an empty folder name somewhere in the chain).
 */
export function useArtifactFolderChain(
  artifactId: string,
): readonly string[] | null {
  return useEpicStore(
    useShallow((s) => artifactFolderChain(s.tree, s.artifacts, artifactId)),
  );
}

// ─── Reselect derived views (cross-slice / sorted / filtered) ─────────────

const selectArtifacts = (s: OpenEpicState): ArtifactsSlice => s.artifacts;
const selectChats = (s: OpenEpicState): ChatsSlice => s.chats;
const selectTree = (s: OpenEpicState): TreeSlice => s.tree;

/**
 * All artifacts of a given kind, sorted by `createdAt`.
 * Memoized on `(byId, allIds, kind)` so identity-stable sibling updates skip the recomputation.
 */
export const makeSelectArtifactsByKind = (kind: ArtifactProjection["kind"]) =>
  createSelector(
    [selectArtifacts],
    (artifacts): ReadonlyArray<ArtifactProjection> => {
      const out: ArtifactProjection[] = [];
      for (const id of artifacts.allIds) {
        if (!Object.hasOwn(artifacts.byId, id)) continue;
        const a = artifacts.byId[id];
        if (a.kind === kind) out.push(a);
      }
      out.sort((a, b) => a.createdAt - b.createdAt);
      return out.length === 0 ? EMPTY_NODES_AS_ARTIFACTS : out;
    },
  );

/**
 * Top-level tree nodes.
 * Identity stable while `tree.rootIds` and `tree.nodeById` don't change reference.
 */
export const selectRootNodes = createSelector(
  [selectTree],
  (tree): ReadonlyArray<TreeNode> => {
    if (tree.rootIds.length === 0) return EMPTY_NODES;
    const out: TreeNode[] = [];
    for (const id of tree.rootIds) {
      if (Object.hasOwn(tree.nodeById, id)) out.push(tree.nodeById[id]);
    }
    return out;
  },
);

/**
 * Per-artifact composite view: artifact + tree node.
 * Useful when a component needs both shapes and otherwise would call two selectors.
 */
export const makeSelectArtifactWithNode = (id: string) =>
  createSelector(
    [
      (s: OpenEpicState): ArtifactProjection | null =>
        Object.hasOwn(s.artifacts.byId, id) ? s.artifacts.byId[id] : null,
      (s: OpenEpicState): TreeNode | null =>
        Object.hasOwn(s.tree.nodeById, id) ? s.tree.nodeById[id] : null,
    ],
    (
      artifact,
      node,
    ): {
      readonly artifact: ArtifactProjection | null;
      readonly node: TreeNode | null;
    } => ({ artifact, node }),
    { memoize: lruMemoize },
  );

export function useArtifactWithNode(id: string): {
  readonly artifact: ArtifactProjection | null;
  readonly node: TreeNode | null;
} {
  const selector = useMemo(() => makeSelectArtifactWithNode(id), [id]);
  return useEpicStore(selector);
}

// ─── Convenience scalar reads (component-local one-liners) ────────────────

export function useArtifactById(id: string | null): ArtifactProjection | null {
  return useEpicStore((s) => {
    if (id === null) return null;
    if (Object.hasOwn(s.artifacts.byId, id)) return s.artifacts.byId[id];
    return null;
  });
}

/**
 * Reactive tombstone lookup for a deleted artifact.
 * Returns the projected `deletedArtifacts` entry, or null when the id is not (yet) a tombstone.
 */
export function useEpicDeletedArtifact(
  id: string | null,
): DeletedArtifactProjection | null {
  return useEpicStore((s) => {
    if (id === null) return null;
    if (Object.hasOwn(s.deletedArtifacts.byId, id)) {
      return s.deletedArtifacts.byId[id];
    }
    return null;
  });
}

export function useChatById(id: string | null): ChatProjection | null {
  return useEpicStore((s) => {
    if (id === null) return null;
    if (Object.hasOwn(s.chats.byId, id)) return s.chats.byId[id];
    return null;
  });
}

/** WHY a chat's record was retracted from this session, or `null` if it was not. */
export function useEpicChatRetraction(
  chatId: string | null,
): ChatRecordRemovalReason | null {
  return useEpicStore((s) => {
    if (chatId === null) return null;
    if (Object.hasOwn(s.chatRetractions, chatId)) {
      return s.chatRetractions[chatId];
    }
    return null;
  });
}

/**
 * The host hosting a chat / terminal-agent row, read narrowly off the `chats.byId` / `tuiAgents.byId` projection so a row "+" can inherit ITS OWN host when spawning a child (Decision E).
 */
export function useEpicNodeHostId(nodeId: string): string | null {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.chats.byId, nodeId)) {
      return s.chats.byId[nodeId].hostId;
    }
    if (Object.hasOwn(s.tuiAgents.byId, nodeId)) {
      return s.tuiAgents.byId[nodeId].hostId;
    }
    return null;
  });
}

/**
 * Batched counterpart to {@link useEpicNodeHostId} for surfaces that must group notification reads by each row's owning host.
 * The shallow array keeps the caller stable through unrelated projection churn while preserving the input order for a direct `nodeIds[index]` pairing.
 */
export function useEpicNodeHostIds(
  nodeIds: ReadonlyArray<string>,
): ReadonlyArray<string | null> {
  return useEpicStore(
    useShallow((s) =>
      nodeIds.map((nodeId) => {
        if (Object.hasOwn(s.chats.byId, nodeId)) {
          return s.chats.byId[nodeId].hostId;
        }
        if (Object.hasOwn(s.tuiAgents.byId, nodeId)) {
          return s.tuiAgents.byId[nodeId].hostId;
        }
        return null;
      }),
    ),
  );
}

/**
 * The owning USER of a chat row, as a primitive for the same churn-isolation reason as {@link useEpicNodeHostId}.
 * Chat rows only: the one consumer (the sidebar's unreachable-owner published-copy routing) needs the cloud identity triple, which only chats have.
 */
export function useEpicNodeOwnerUserId(nodeId: string): string | null {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.chats.byId, nodeId)) {
      return s.chats.byId[nodeId].userId;
    }
    return null;
  });
}

/**
 * Whether this node's record is archived, as a primitive so unrelated projection churn cannot re-render the row.
 * Covers both record kinds - one `epic.setChatArchived` RPC keyed by id serves chats and terminal-agents alike.
 */
export function useEpicNodeArchived(nodeId: string): boolean {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.chats.byId, nodeId)) {
      return s.chats.byId[nodeId].archivedAt !== null;
    }
    if (Object.hasOwn(s.tuiAgents.byId, nodeId)) {
      return s.tuiAgents.byId[nodeId].archivedAt !== null;
    }
    return false;
  });
}

/**
 * Provider-optional counterpart to {@link useEpicNodeArchived} for canvas tab icons.
 * The shared tab icon also renders in provider-less drag previews and graph surfaces, so it resolves the epic through the session registry and degrades to active when that epic has no mounted session.
 */
export function useRegisteredEpicNodeArchived(
  epicId: string,
  nodeId: string,
): boolean {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.peek(epicId),
    () => null,
  );
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveEpicNodeArchivedFromHandle(handle, nodeId),
    () => false,
  );
}

function liveEpicNodeArchivedFromHandle(
  handle: OpenEpicStoreHandle | null,
  nodeId: string,
): boolean {
  if (handle === null) return false;
  const state = handle.store.getState();
  if (Object.hasOwn(state.chats.byId, nodeId)) {
    return state.chats.byId[nodeId].archivedAt !== null;
  }
  if (Object.hasOwn(state.tuiAgents.byId, nodeId)) {
    return state.tuiAgents.byId[nodeId].archivedAt !== null;
  }
  return false;
}

/** A row's last-activity time, read from the CHAT / TERMINAL-AGENT PROJECTION rather than from its `TreeNode`. */
export function useEpicNodeUpdatedAt(nodeId: string): number {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.chats.byId, nodeId)) {
      return s.chats.byId[nodeId].updatedAt;
    }
    if (Object.hasOwn(s.tuiAgents.byId, nodeId)) {
      return s.tuiAgents.byId[nodeId].updatedAt;
    }
    return 0;
  });
}

/**
 * A GUI chat row's persisted harness id, selected as a primitive so unrelated chat projection churn cannot re-render the sidebar icon.
 * New chats normally persist settings at creation; legacy or optimistic records can still have no settings, in which case the caller keeps the generic chat glyph.
 */
export function useEpicChatHarnessId(nodeId: string): GuiHarnessId | null {
  return useEpicStore((s) => {
    if (!Object.hasOwn(s.chats.byId, nodeId)) return null;
    return s.chats.byId[nodeId].settings?.harnessId ?? null;
  });
}

/**
 * A terminal-agent row's harness id, read narrowly off `tuiAgents.byId` so a tab / sidebar row can render the harness's brand icon (Claude, Codex, …) in place of the generic bot glyph.
 */
export function useMaybeEpicTuiAgentHarnessId(
  nodeId: string,
): TuiHarnessId | null {
  const handle = useMaybeOpenEpicHandle();
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => {
      if (handle === null) return null;
      const s = handle.store.getState();
      return Object.hasOwn(s.tuiAgents.byId, nodeId)
        ? s.tuiAgents.byId[nodeId].harnessId
        : null;
    },
    () => null,
  );
}

export function useEpicNodeOwnerKind(
  nodeId: string,
): WorktreeBindingOwnerKind | null {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.chats.byId, nodeId)) return "chat";
    if (Object.hasOwn(s.tuiAgents.byId, nodeId)) return "terminal-agent";
    return null;
  });
}

/**
 * A terminal-agent row's persisted `workspaceFolders` (the local paths it was launched against), read narrowly off `tuiAgents.byId` so a row "+" can prefill a nested terminal-agent's workspace from its PARENT (decision 16).
 */
export function useEpicNodeWorkspaceFolders(nodeId: string): readonly string[] {
  return useEpicStore((s) => {
    if (Object.hasOwn(s.tuiAgents.byId, nodeId)) {
      return s.tuiAgents.byId[nodeId].workspaceFolders;
    }
    return EMPTY_ARRAY;
  });
}

export function useTreeNodeById(id: string | null): TreeNode | null {
  return useEpicStore((s) => {
    if (id === null) return null;
    if (Object.hasOwn(s.tree.nodeById, id)) return s.tree.nodeById[id];
    return null;
  });
}

export function useChildIdsOf(parentId: string): readonly string[] {
  return useEpicStore((s) =>
    Object.hasOwn(s.tree.childrenByParent, parentId)
      ? s.tree.childrenByParent[parentId]
      : EMPTY_ARRAY,
  );
}

export function useRootIdsAll(): readonly string[] {
  return useEpicStore((s) => s.tree.rootIds);
}

export function useEpicHeaderTitle(): string {
  return useEpicStore((s) => s.epic.title);
}

export { selectArtifacts, selectChats, selectTree };
