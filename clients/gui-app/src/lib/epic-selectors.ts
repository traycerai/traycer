/**
 * Canonical selector + hook surface over the per-Epic projected slices
 * owned by `OpenEpicStore`. This is the single import path for component
 * code - there is no separate compatibility shim.
 *
 * Patterns:
 *   - Plain scalar / single slot: prefer `useEpicStore(s => s.x.byId[id])`
 *     directly. Identity stability of projector slots gives `Object.is`
 *     skip-render automatically.
 *   - Object-shaped selects: wrap with `useShallow` from
 *     `zustand/react/shallow`.
 *   - Derived / cross-slice computations: define at module scope here via
 *     `createSelector(...)` so the cache survives across re-renders.
 *   - Per-id factory selectors: pair with `useMemo([id])` in the caller
 *     so the cache key is stable.
 *
 * Index access discipline: this codebase has `noUncheckedIndexedAccess`
 * off, so `Record<string, X>[key]` is typed as `X`. Use
 * `Object.hasOwn(byId, id) ? byId[id] : null` instead of `byId[id] ?? null`
 * to satisfy `@typescript-eslint/no-unnecessary-condition` while keeping
 * runtime safety.
 */
import { useMemo, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createSelector, lruMemoize } from "reselect";
import { v4 as uuidv4 } from "uuid";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { artifactFolderChain } from "@/lib/artifacts/artifact-folder-chain";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  AGENT_WORKING_AWARENESS_FIELD,
  AGENT_WORKING_TURN_AWARENESS_FIELD,
} from "@traycer/protocol/host/epic/subscribe";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { displayTitle, tuiAgentDisplayTitle } from "@/lib/display-title";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useTerminalDisplayTitle } from "@/hooks/terminal/use-terminal-display-title";
import {
  useMaybeOpenEpicHandle,
  useOpenEpicHandle,
} from "@/providers/use-open-epic-handle";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
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
 * Sidebar-friendly node row that merges artifacts + chats into one
 * sequence. `name` falls back to `Untitled <kind>` so the sidebar always
 * has a label. Identity-stable via `recordForArtifact` / `recordForChat`
 * caches keyed by source projection identity.
 *
 * `hostId` is the host hosting the artifact (per CLAUDE.md
 * tab-bound-to-host-for-life). Tui-agent rows pull it from the
 * `TuiAgentProjection` that already carries it; chat / artifact rows
 * inherit it from the host hosting the open-epic projection.
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

export { EMPTY_TREE_ID_ARRAY, EMPTY_TREE_ID_SET };

// ─── Snapshot meta + connection state ─────────────────────────────────────

export function useEpicSnapshotMeta(): SnapshotMetaEpic | null {
  return useEpicStore((s) => s.snapshotMeta);
}

export function useEpicConnectionStatus(): StreamConnectionStatus {
  return useEpicStore((s) => s.connectionStatus);
}

export function useEpicPermissionRole(): PermissionRole | null {
  return useEpicStore((s) => s.permissionRole);
}

export function useEpicSnapshotLoaded(): boolean {
  return useEpicStore((s) => s.snapshotLoaded);
}

export function useEpicSnapshotFetchError(): SnapshotFetchError | null {
  return useEpicStore((s) => s.snapshotFetchError);
}

export function useEpicRequestFreshSnapshot(): () => void {
  return useEpicStore((s) => s.requestFreshSnapshot);
}

/**
 * Reactive view of the per-epic major-migration slice. The modal subscribes
 * here to decide between idle (don't render), running (show step list), and
 * error (show retry/close) states. Identity-stable across snapshots that
 * leave the slice unchanged.
 */
export function useEpicMigrationState(): EpicMigrationSlice {
  return useEpicStore((s) => s.migration);
}

/**
 * Action hook for the migration modal's Retry button. Sends a
 * `retryMigration` client frame and snaps the slice back to running.
 */
export function useEpicRetryMigration(): () => void {
  return useEpicStore((s) => s.retryMigration);
}

export function useEpicLastFocusedArtifactId(): string | null {
  return useEpicStore((s) => s.lastFocusedArtifactId);
}

/**
 * Stable epic id of the open-epic session (the value the surrounding
 * `<EpicSessionProvider>` was mounted with). Reads off the handle, not
 * the store state, so consumers do not subscribe to unrelated store
 * field changes.
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
 * Best-available live title for an open-epic handle: the projected Y.Doc
 * title, falling back to the snapshot-meta epicLight title, else `null`. The
 * single source of this precedence - reused by the header strip and the
 * access coordinator so a title-source change can't drift between them.
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

function recordForChat(c: ChatProjection, hostId: string): EpicTreeRecord {
  const cached = chatRecordCache.get(c);
  if (cached !== undefined && cached.hostId === hostId) return cached;
  const record: EpicTreeRecord = {
    id: c.id,
    parentId: c.parentId,
    name: displayTitle(c.title, "chat"),
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
    name: tuiAgentDisplayTitle({ title: a.title, harnessId: a.harnessId }),
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
  // Chat / artifact projections do not yet carry a hostId (only
  // tui-agents do). The renderer's currently-active host is the
  // host hosting the open-epic projection, so it is the correct
  // binding source for those rows. Tui-agent rows override with their
  // projected hostId.
  const fallbackHostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
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
 * Projected chat records for the sidebar / tabs and the initial-chat-handoff
 * adoption check. Single source of truth: the epic Y.Doc projection.
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
 * Live artifact title for an epic session that may be mounted elsewhere in
 * the app. Global surfaces (for example, the resource monitor) live outside
 * an `EpicSessionProvider`, but must use the same Y.Doc-backed title that a
 * canvas tab uses instead of its persisted opening-name snapshot.
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
 * Canonical display title for a canvas tile / node. Live state is the single
 * source of truth - the Y.Doc title for record-backed nodes, the HOST's
 * `terminal.list` rows for terminal tabs (via `useTerminalDisplayTitle`,
 * keyed by the tab's bound host + session id). The tile's persisted `name`
 * snapshot is only a fallback for tiles that have no live title (workspace
 * files, git diff, pre-hydration, a terminal session the host no longer
 * knows). Every render site (visible tab strip, drag overlay, ...) MUST read
 * through this hook - never the raw `node.name` - so the resolve cannot be
 * forgotten in one place.
 *
 * `terminalHostClient` is the tab's bound-host client for terminal nodes
 * (`null` for every other node kind). The caller resolves it so one
 * `useHostClientForHostId` per tab serves both title resolution and the
 * rename mutation.
 */
type EpicTabDisplayTitleNode = {
  readonly id: string;
  readonly name: string;
  readonly type: string | undefined;
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
  return liveArtifactTitle ?? liveTerminalTitle ?? node.name;
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
 * Returns the live `Y.XmlFragment` backing an artifact's body. The fragment
 * resolves through the artifact's assigned artifact-room doc (`artifact-body:{id}`),
 * not the root Epic doc - see B6 in the artifact-room approach spec.
 *
 * Selects the resolved fragment itself so any store write that makes the
 * artifact-room replica available wakes the editor, even when the room id and
 * binding counter are unchanged.
 */
export function useEpicArtifactFragment(
  artifactId: string | null,
): Y.XmlFragment | null {
  const handle = useOpenEpicHandle();
  return useStore(handle.store, (s) => {
    if (artifactId === null) return null;
    return s.getArtifactFragment(artifactId);
  });
}

/**
 * Returns the artifact-room-scoped `Awareness` instance hosting `artifactId`'s body
 * presence channel, or `null` until the artifactRoom transitions to `ready`. Used
 * by `CollabTileBody` to feed CollaborationCaret an Awareness instance
 * paired with the artifact-room doc the editor is bound to.
 *
 * Selects the resolved Awareness instance directly for the same reason as
 * {@link useEpicArtifactFragment}: callers should update when a store write
 * makes the artifact-room binding available, regardless of which public
 * invalidation field changed.
 */
export function useEpicArtifactBodyAwareness(
  artifactId: string | null,
): Awareness | null {
  const handle = useOpenEpicHandle();
  return useStore(handle.store, (s) => {
    if (artifactId === null) return null;
    return s.getArtifactBodyAwareness(artifactId);
  });
}

/**
 * Reports the availability of the artifact-room hosting `artifactId`'s body.
 * Drives the editor's loading/unavailable placeholder when the artifactRoom is
 * still opening or has failed. Selects through the store helper so artifact
 * metadata and artifact-room state are resolved together.
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

// ─── Doc reference for editor binding ─────────────────────────────────────

/**
 * Returns the live Y.Doc + Y.Awareness owned by the current Epic session.
 * Tile editors bind these to `@tiptap/extension-collaboration` and
 * `@tiptap/extension-collaboration-caret` directly.
 */
export function useEpicDocBinding(): {
  readonly doc: Y.Doc;
  readonly awareness: OpenEpicStoreHandle["awareness"];
} {
  const handle = useOpenEpicHandle();
  useStore(handle.store, (s) => s.bindingVersion);
  return { doc: handle.doc, awareness: handle.awareness };
}

// ─── Agent activity (awareness-derived; NOT projected, per EPIC_PROJECTOR) ──

const EMPTY_ACTIVE_AGENT_IDS: ReadonlySet<string> = new Set<string>();

const activeAgentIdsCache = new WeakMap<
  Awareness,
  { readonly ids: ReadonlySet<string>; readonly key: string }
>();

/**
 * Live-activity tier of a working agent, as published by its host. See
 * {@link AGENT_WORKING_TURN_AWARENESS_FIELD}: hosts that do not publish the
 * turn field leave their agents' tier unknown, which reads as `"turn"`.
 */
export type AgentActivityTier = "turn" | "background";

const EMPTY_AGENT_ACTIVITY_TIERS: ReadonlyMap<string, AgentActivityTier> =
  new Map<string, AgentActivityTier>();

const agentActivityTiersCache = new WeakMap<
  Awareness,
  {
    readonly tiers: ReadonlyMap<string, AgentActivityTier>;
    readonly key: string;
  }
>();
const registeredLiveAgentIdsCache = new WeakMap<
  OpenEpicStoreHandle,
  { readonly ids: ReadonlySet<string>; readonly key: string }
>();

/**
 * Unions the `agentWorking` ids across every awareness entry (each host
 * publishes one). Returns the prior Set ref when membership is unchanged so
 * `useSyncExternalStore` sees a referentially-stable snapshot.
 */
function activeAgentIdsSnapshot(awareness: Awareness): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const state of awareness.getStates().values()) {
    const working: unknown = state[AGENT_WORKING_AWARENESS_FIELD];
    if (!Array.isArray(working)) continue;
    for (const id of working as readonly unknown[]) {
      if (typeof id === "string") ids.add(id);
    }
  }
  const key = [...ids].sort().join(" ");
  const cached = activeAgentIdsCache.get(awareness);
  if (cached !== undefined && cached.key === key) return cached.ids;
  const entry = { ids, key };
  activeAgentIdsCache.set(awareness, entry);
  return entry.ids;
}

/**
 * Same union as {@link activeAgentIdsSnapshot}, but resolving each working
 * agent to its {@link AgentActivityTier}.
 *
 * The turn field is read PER AWARENESS ENTRY (one entry per host) because its
 * presence is per-host, and mixed shapes are the steady state rather than a
 * rollout window - see `AGENT_WORKING_TURN_AWARENESS_FIELD`. A host that omits
 * it has not classified its agents, so they stay `"turn"` (the conservative
 * pre-existing reading); a host that publishes it is authoritative, so its
 * working ids absent from that list are genuinely background-only.
 *
 * `"turn"` wins when the same agent appears under two hosts. Returns the prior
 * Map ref while membership AND tiers are unchanged so `useSyncExternalStore`
 * sees a referentially-stable snapshot.
 */
function agentActivityTiersSnapshot(
  awareness: Awareness,
): ReadonlyMap<string, AgentActivityTier> {
  const tiers = new Map<string, AgentActivityTier>();
  for (const state of awareness.getStates().values()) {
    const working: unknown = state[AGENT_WORKING_AWARENESS_FIELD];
    if (!Array.isArray(working)) continue;
    const turnField: unknown = state[AGENT_WORKING_TURN_AWARENESS_FIELD];
    const turnIds = Array.isArray(turnField)
      ? new Set(
          (turnField as readonly unknown[]).filter(
            (id): id is string => typeof id === "string",
          ),
        )
      : null;
    for (const id of working as readonly unknown[]) {
      if (typeof id !== "string") continue;
      const tier: AgentActivityTier =
        turnIds === null || turnIds.has(id) ? "turn" : "background";
      if (tier === "turn" || !tiers.has(id)) tiers.set(id, tier);
    }
  }
  const key = [...tiers.entries()]
    .map(([id, tier]) => `${id}:${tier}`)
    .sort()
    .join(" ");
  const cached = agentActivityTiersCache.get(awareness);
  if (cached !== undefined && cached.key === key) return cached.tiers;
  const entry = { tiers, key };
  agentActivityTiersCache.set(awareness, entry);
  return entry.tiers;
}

/**
 * The set of agents currently "working" (executing right now) anywhere in the
 * epic, unioned across every host's awareness `agentWorking` entry - so it is
 * cross-host and reactive (re-renders when any host's working set changes).
 * Replaces the `agent.list` 2s poll for the Active Agents / stop panels.
 */
export function useEpicActiveAgentIds(): ReadonlySet<string> {
  const handle = useOpenEpicHandle();
  useStore(handle.store, (s) => s.bindingVersion); // re-resolve on replica swap
  const awareness = handle.awareness;
  const subscribe = useMemo(
    () => (onChange: () => void) => {
      awareness.on("change", onChange);
      return () => {
        awareness.off("change", onChange);
      };
    },
    [awareness],
  );
  const getSnapshot = useMemo(
    () => () => activeAgentIdsSnapshot(awareness),
    [awareness],
  );
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_ACTIVE_AGENT_IDS,
  );
}

/**
 * {@link useEpicActiveAgentIds} with each working agent resolved to its
 * {@link AgentActivityTier}. Prefer this when the caller distinguishes an
 * active turn from background-only work; the id set alone cannot.
 */
export function useEpicAgentActivityTiers(): ReadonlyMap<
  string,
  AgentActivityTier
> {
  const handle = useOpenEpicHandle();
  useStore(handle.store, (s) => s.bindingVersion); // re-resolve on replica swap
  const awareness = handle.awareness;
  const subscribe = useMemo(
    () => (onChange: () => void) => {
      awareness.on("change", onChange);
      return () => {
        awareness.off("change", onChange);
      };
    },
    [awareness],
  );
  const getSnapshot = useMemo(
    () => () => agentActivityTiersSnapshot(awareness),
    [awareness],
  );
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_AGENT_ACTIVITY_TIERS,
  );
}

export function useRegisteredEpicActiveAgentIds(
  epicId: string | null,
): ReadonlySet<string> {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  useSyncExternalStore(
    (listener) =>
      handle?.store.subscribe((state, prev) => {
        if (state.bindingVersion === prev.bindingVersion) return;
        listener();
      }) ?? noopSubscribe,
    () => handle?.store.getState().bindingVersion ?? 0,
    () => 0,
  );
  const awareness = handle?.awareness ?? null;
  const subscribe = useMemo(
    () => (onChange: () => void) => {
      if (awareness === null) return noopUnsubscribe;
      awareness.on("change", onChange);
      return () => {
        awareness.off("change", onChange);
      };
    },
    [awareness],
  );
  const getSnapshot = useMemo(
    () => () =>
      awareness === null
        ? EMPTY_ACTIVE_AGENT_IDS
        : activeAgentIdsSnapshot(awareness),
    [awareness],
  );
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_ACTIVE_AGENT_IDS,
  );
}

/**
 * {@link useRegisteredEpicActiveAgentIds} with each working agent resolved to
 * its {@link AgentActivityTier}, for surfaces that run outside the open-epic
 * provider (epic tabs, the epic list).
 */
export function useRegisteredEpicAgentActivityTiers(
  epicId: string | null,
): ReadonlyMap<string, AgentActivityTier> {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  useSyncExternalStore(
    (listener) =>
      handle?.store.subscribe((state, prev) => {
        if (state.bindingVersion === prev.bindingVersion) return;
        listener();
      }) ?? noopSubscribe,
    () => handle?.store.getState().bindingVersion ?? 0,
    () => 0,
  );
  const awareness = handle?.awareness ?? null;
  const subscribe = useMemo(
    () => (onChange: () => void) => {
      if (awareness === null) return noopUnsubscribe;
      awareness.on("change", onChange);
      return () => {
        awareness.off("change", onChange);
      };
    },
    [awareness],
  );
  const getSnapshot = useMemo(
    () => () =>
      awareness === null
        ? EMPTY_AGENT_ACTIVITY_TIERS
        : agentActivityTiersSnapshot(awareness),
    [awareness],
  );
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_AGENT_ACTIVITY_TIERS,
  );
}

export function useRegisteredEpicLiveAgentIds(
  epicId: string | null,
): ReadonlySet<string> {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  return useSyncExternalStore(
    (listener) => handle?.store.subscribe(listener) ?? noopSubscribe,
    () => liveAgentIdsSnapshot(handle),
    () => EMPTY_ACTIVE_AGENT_IDS,
  );
}

function liveAgentIdsSnapshot(
  handle: OpenEpicStoreHandle | null,
): ReadonlySet<string> {
  if (handle === null) return EMPTY_ACTIVE_AGENT_IDS;
  const state = handle.store.getState();
  const key = [...state.chats.allIds, ...state.tuiAgents.allIds]
    .sort()
    .join(" ");
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

/**
 * Just this artifact's `status` scalar. Sidebar nodes need it for the status
 * dot on every render; selecting the scalar (instead of `find`-ing it out of
 * the full `useEpicArtifactRecords()` array) keeps the value reference-stable
 * while OTHER records churn - e.g. the active chat streaming - so the memoized
 * node bails. See RENDER_PERF_FINDINGS.md (T1 follow-up).
 */
export function useEpicArtifactStatus(id: string): number | null {
  return useEpicStore((s) =>
    Object.hasOwn(s.artifacts.byId, id) ? s.artifacts.byId[id].status : null,
  );
}

export function useAncestorIds(nodeId: string | null): ReadonlySet<string> {
  const index = useEpicTreeIndex();
  return useMemo(() => {
    if (nodeId === null) return EMPTY_TREE_ID_SET;
    if (!Object.hasOwn(index.nodeById, nodeId)) return EMPTY_TREE_ID_SET;
    const ancestors = new Set<string>();
    let current: string | null = index.nodeById[nodeId].parentId;
    while (current !== null && !ancestors.has(current)) {
      ancestors.add(current);
      if (!Object.hasOwn(index.nodeById, current)) break;
      current = index.nodeById[current].parentId;
    }
    return ancestors.size === 0 ? EMPTY_TREE_ID_SET : ancestors;
  }, [index, nodeId]);
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
 * This artifact's own root-to-leaf on-disk folder-name chain (ending with
 * its own `folderName`), or `null` when it can't be reconstructed (unknown
 * id, a tree cycle, a non-artifact ancestor, or an empty folder name
 * somewhere in the chain). Feeds `resolveArtifactRelativeLinkPath` so a
 * relative markdown link authored inside this artifact can be rewritten into
 * the same artifact-shaped path the absolute-link flow already resolves.
 *
 * Selected via `useShallow` (a plain array of primitive strings) rather than
 * subscribing to the raw `tree`/`artifacts` slices directly: those slices get
 * a fresh top-level identity on ANY artifact edit anywhere in the epic, which
 * would otherwise re-render every link consumer even when THIS artifact's own
 * chain is unchanged.
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
 * All artifacts of a given kind, sorted by `createdAt`. Memoized on
 * `(byId, allIds, kind)` so identity-stable sibling updates skip the
 * recomputation.
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
 * Top-level tree nodes. Identity stable while `tree.rootIds` and
 * `tree.nodeById` don't change reference.
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
 * Per-artifact composite view: artifact + tree node. Useful when a
 * component needs both shapes and otherwise would call two selectors.
 * Cached per id via `lruMemoize` so multiple components subscribing to
 * the same id share the result.
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
 * Reactive tombstone lookup for a deleted artifact. Returns the projected
 * `deletedArtifacts` entry, or null when the id is not (yet) a tombstone. The
 * chat's `artifact_operation` delete card subscribes here so it resolves the
 * strikethrough title + deletion info as soon as the tombstone syncs in, rather
 * than reading once.
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

/**
 * The host hosting a chat / terminal-agent row, read narrowly off the
 * `chats.byId` / `tuiAgents.byId` projection so a row "+" can inherit ITS OWN
 * host when spawning a child (Decision E). Returns `null` for artifact rows
 * (they carry no `hostId`), for legacy chats predating the field, and for
 * ids that resolve to nothing.
 *
 * Reads a single per-id scalar - NOT `TreeNode` (which has no `hostId`) and
 * NOT `useEpicArtifactRecords()` (whose array churns every token while a chat
 * streams). The selected string is reference-stable while unrelated rows
 * change, so the consuming row bails the render. See RENDER_PERF_INVARIANTS.md.
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
 * A terminal-agent row's harness id, read narrowly off `tuiAgents.byId` so a
 * tab / sidebar row can render the harness's brand icon (Claude, Codex, …) in
 * place of the generic bot glyph. Returns `null` for chat / artifact rows, for
 * ids that resolve to nothing, AND when called outside an open-epic session
 * (e.g. the drag overlay, which mounts at the app shell with no provider). In
 * every null case the caller falls back to the bot icon.
 *
 * Resolves through `useMaybeOpenEpicHandle` + `useSyncExternalStore` (the same
 * provider-optional pattern as the `useRegistered*` hooks above) so the single
 * `EpicNodeTabIcon` source can render it both inside the canvas tab strip and in
 * the provider-less overlay without a conditional hook call. The selected
 * harness id is a reference-stable primitive, so unrelated store churn does not
 * re-render the consuming row. See RENDER_PERF_INVARIANTS.md.
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
 * A terminal-agent row's persisted `workspaceFolders` (the local paths it was
 * launched against), read narrowly off `tuiAgents.byId` so a row "+" can prefill
 * a nested terminal-agent's workspace from its PARENT (decision 16). Returns a
 * shared empty array for chat rows (`ChatProjection` carries no folders - prefill
 * gracefully falls back to the default workspace) and for ids that resolve to
 * nothing.
 *
 * The projection's `workspaceFolders` array is reference-stable until the agent's
 * folders actually change, so returning it directly does not churn the consuming
 * row's render; the empty fallback is the shared `EMPTY_ARRAY` for the same
 * reason. See RENDER_PERF_INVARIANTS.md.
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
