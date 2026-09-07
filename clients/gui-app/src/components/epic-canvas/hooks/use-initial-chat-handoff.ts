import { useEffect, useMemo, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import { displayTitle } from "@/lib/display-title";
import type {
  ExplicitTilePlacement,
  TileOpenIntent,
} from "@/lib/canvas/tile-open/intent";
import {
  useEpicChatRecords,
  useEpicConnectionStatus,
  useEpicPermissionRole,
  useEpicSnapshotLoaded,
} from "@/lib/epic-selectors";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import {
  selectInitialChatHandoff,
  useInitialChatHandoffStore,
  type InitialChatHandoff,
  type InitialChatHandoffScope,
} from "@/stores/epics/initial-chat-handoff-store";
import type { EpicChatProjection } from "@/lib/epic-selectors";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";

/**
 * How long a `pending` handoff may sit with no projected chat before the eager-opened tab is treated as an orphan.
 * Generous on purpose: the create is local-first (the chat normally projects in well under a second), so this only ever fires when nothing was created at all.
 */
const CHAT_PROJECTION_DEADLINE_MS = 60_000;

/**
 * Where the seeded chat LIVES: the host `epic.create` ran on, recorded on the handoff at registration by the landing composer (`hostId` is data on the record, not part of its key).
 * That is the truest binding for the tile - truer than the session host, which is where this canvas STREAMS the epic from and can differ from the creating host for a cloud-hydrated epic - so it comes first; the canvas (session) host is the fallback for a record that carries none.
 */
function handoffTileHost(
  handoff: InitialChatHandoff | null,
  canvasHostId: string | null,
): string | null {
  return handoff?.hostId ?? canvasHostId;
}

/**
 * The chat itself is created by `epic.create` (folded), not here - this hook only advances the handoff as the seeded chat projects, eager-opens the tab, and manages the pending-create mark.
 */
export function useInitialChatHandoff(epicId: string, tabId: string): void {
  // The key this scope is looked up under dropped its host segment (`initialChatHandoffKey`), so this value never decides WHETHER the handoff is found; it decides which host the seeded chat's TILE is stamped with, via `runCanvasHandoffTransition` below, and a tile carries that binding for life.
  const canvasHostId = useCanvasHostId();
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const scope = useMemo<InitialChatHandoffScope>(
    () => ({ hostId: canvasHostId, userId, epicId }),
    [canvasHostId, epicId, userId],
  );
  const handoff = useInitialChatHandoffStore((state) =>
    selectInitialChatHandoff(state, scope),
  );
  const handoffTileHostId = handoffTileHost(handoff, canvasHostId);
  const snapshotLoaded = useEpicSnapshotLoaded();
  const connectionStatus = useEpicConnectionStatus();
  const permissionRole = useEpicPermissionRole();
  // The authoritative "does this chat really exist yet" source - the projected epic chats.
  // The chat tab is eager-opened (canvas state) + marked pending-create so it survives until this projection catches up.
  const chatRecords = useEpicChatRecords();
  const { openTile } = useEpicTileNavigation();
  const markArtifactPendingCreate = useEpicCanvasStore(
    (s) => s.markArtifactPendingCreate,
  );
  const unmarkArtifactPendingCreate = useEpicCanvasStore(
    (s) => s.unmarkArtifactPendingCreate,
  );
  // Every placement kind (active-tile, target-group, split) opens exactly once per chat, even as the handoff effect re-runs across status/ projection transitions.
  // The tab label tracks the projected title live via `useEpicTabDisplayTitle`'s `liveArtifactTitle` fallback, so re-opening on each transition is unnecessary and would re-navigate / steal focus from whatever the user is looking at.
  const openedChatIdRef = useRef<string | null>(null);
  // A second in-epic create registers a new handoff under the same {host,user,epic} scope; this lets the next transition release the prior chat's mark instead of orphaning it.
  const markedChatIdRef = useRef<string | null>(null);

  const projectedChat = useMemo(
    () =>
      handoff === null || handoff.chatId === null
        ? null
        : (chatRecords.find((chat) => chat.id === handoff.chatId) ?? null),
    [chatRecords, handoff],
  );
  const adoptableChat = useMemo(
    () => resolveAdoptableChat(chatRecords, userId),
    [chatRecords, userId],
  );
  const handoffChatId = handoff?.chatId ?? null;
  const handoffStatus = handoff?.status ?? null;
  const handoffPlacement = handoff?.placement ?? null;
  const handoffCreatedAt = handoff?.createdAt ?? 0;
  const projectedChatId = projectedChat?.id ?? null;
  const projectedChatTitle = projectedChat?.title ?? null;
  const adoptableChatId = adoptableChat?.id ?? null;

  // Armed only for `pending`: every later status implies the chat already projected, except the `markInitialTurnStarted` jump to `sending`, where the host confirmed the chat exists.
  useEffect(() => {
    if (handoffChatId === null) return;
    if (handoffStatus !== "pending") return;
    if (projectedChatId !== null) return;
    if (!epicReady(snapshotLoaded, connectionStatus, permissionRole)) return;
    const timeoutId = window.setTimeout(
      () => {
        // `markFailed` is scope-keyed, and a second create can REPLACE the handoff under this same {host,user,epic} scope in the gap between the store write and this effect's cleanup (the timer is a macrotask; React's cleanup lands on commit) - so re-read the scope and fail only the exact still-pending handoff this timer was armed for, never a replacement's fresh one.
        const current = selectInitialChatHandoff(
          useInitialChatHandoffStore.getState(),
          scope,
        );
        if (
          current === null ||
          current.chatId !== handoffChatId ||
          current.createdAt !== handoffCreatedAt ||
          current.status !== "pending"
        ) {
          return;
        }
        useInitialChatHandoffStore
          .getState()
          .markFailed(scope, "The agent was never created.");
      },
      Math.max(
        CHAT_PROJECTION_DEADLINE_MS - (Date.now() - handoffCreatedAt),
        0,
      ),
    );
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    connectionStatus,
    handoffChatId,
    handoffCreatedAt,
    handoffStatus,
    permissionRole,
    projectedChatId,
    scope,
    snapshotLoaded,
  ]);

  // Advance the handoff out of `pending` once the folded chat projects (the common path) or a single user-owned root-level GUI chat exists (reload / legacy recovery).
  // `epic.create` seeds the chat, so this normally fires as soon as the first epic snapshot lands.
  useEffect(() => {
    runChatProjectionTransition({
      adoptableChatId,
      connectionStatus,
      handoffChatId,
      handoffStatus,
      permissionRole,
      projectedChatId,
      scope,
      snapshotLoaded,
    });
  }, [
    adoptableChatId,
    connectionStatus,
    handoffChatId,
    handoffStatus,
    permissionRole,
    projectedChatId,
    scope,
    snapshotLoaded,
  ]);

  // Single effect so the mark and its inverse can never race within the same commit.
  useEffect(() => {
    runCanvasHandoffTransition({
      tileHostId: handoffTileHostId,
      handoffChatId,
      handoffStatus,
      handoffPlacement,
      markArtifactPendingCreate,
      openTile,
      openedChatIdRef,
      markedChatIdRef,
      projectedChatId,
      projectedChatTitle,
      scope,
      tabId,
      unmarkArtifactPendingCreate,
    });
  }, [
    handoffTileHostId,
    handoffChatId,
    handoffStatus,
    handoffPlacement,
    markArtifactPendingCreate,
    openTile,
    projectedChatId,
    projectedChatTitle,
    scope,
    unmarkArtifactPendingCreate,
    tabId,
  ]);
}

interface ChatProjectionTransitionInput {
  readonly adoptableChatId: string | null;
  readonly connectionStatus: StreamConnectionStatus;
  readonly handoffChatId: string | null;
  readonly handoffStatus: InitialChatHandoff["status"] | null;
  readonly permissionRole: PermissionRole | null;
  readonly projectedChatId: string | null;
  readonly scope: InitialChatHandoffScope;
  readonly snapshotLoaded: boolean;
}

function runChatProjectionTransition(
  input: ChatProjectionTransitionInput,
): void {
  if (input.handoffChatId === null) return;
  if (input.handoffStatus !== "pending") return;
  if (
    !epicReady(
      input.snapshotLoaded,
      input.connectionStatus,
      input.permissionRole,
    )
  ) {
    return;
  }
  if (input.projectedChatId !== null) {
    useInitialChatHandoffStore
      .getState()
      .markChatCreated(input.scope, input.projectedChatId);
    return;
  }
  if (input.adoptableChatId === null) return;
  useInitialChatHandoffStore
    .getState()
    .markChatCreated(input.scope, input.adoptableChatId);
}

interface CanvasHandoffTransitionInput {
  /** The host the opened chat tile binds to for life - see the hook. */
  readonly tileHostId: string | null;
  readonly handoffChatId: string | null;
  readonly handoffStatus: InitialChatHandoff["status"] | null;
  readonly handoffPlacement: ExplicitTilePlacement | null;
  readonly markArtifactPendingCreate: (artifactId: string) => void;
  readonly openTile: (intent: TileOpenIntent) => void;
  readonly openedChatIdRef: { current: string | null };
  readonly markedChatIdRef: { current: string | null };
  readonly projectedChatId: string | null;
  readonly projectedChatTitle: string | null;
  readonly scope: InitialChatHandoffScope;
  readonly tabId: string;
  readonly unmarkArtifactPendingCreate: (artifactId: string) => void;
}

function runCanvasHandoffTransition(input: CanvasHandoffTransitionInput): void {
  // Clobber cleanup: a second in-epic create can register a fresh handoff under this same {host,user,epic} scope before the first chat projects.
  // Runs BEFORE the no-handoff bail: the handoff can also VANISH from this scope (consumed elsewhere, signed-out user, active-host swap moving the {host,user,epic} key out from under this hook), and bailing first left the mark set with nobody able to clear it - the exempt-from-the-sweep tab that outlives every other trace of the create.
  const previouslyMarked = input.markedChatIdRef.current;
  if (previouslyMarked !== null && previouslyMarked !== input.handoffChatId) {
    input.unmarkArtifactPendingCreate(previouslyMarked);
    input.markedChatIdRef.current = null;
  }
  if (input.handoffChatId === null) return;

  if (isHandoffTerminal(input.handoffStatus)) {
    input.unmarkArtifactPendingCreate(input.handoffChatId);
    if (input.markedChatIdRef.current === input.handoffChatId) {
      input.markedChatIdRef.current = null;
    }
    return;
  }

  // Eager-open the canvas tile so it mounts.
  // The tile gates its `chat.subscribe` on the chat record existing in the projection and shows its loading skeleton until the seeded chat lands (~0.5s, host is local-first).
  const node: EpicCanvasTileRef = {
    id: input.handoffChatId,
    instanceId: uuidv4(),
    type: "chat",
    // Never the "New chat" placeholder.
    name: displayTitle(input.projectedChatTitle ?? "", "agent"),
    hostId: input.tileHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  };
  const placement = input.handoffPlacement;
  // The ref guards re-fires within a session; `tabContainsTile` also guards a reload, where the canvas layout persists the tile but the ref does not (without it each reload would stack a duplicate).
  if (
    input.openedChatIdRef.current !== input.handoffChatId &&
    !tabContainsTile(input.tabId, input.handoffChatId)
  ) {
    input.openedChatIdRef.current = input.handoffChatId;
    // If the opener's target pane is gone (closed mid-compose, or a stale id rehydrated on reload), drop the explicit placement so the configured conversation placement decides and the chat always surfaces instead of vanishing.
    const effectivePlacement =
      placement === null || tabContainsPane(input.tabId, placement.paneId)
        ? placement
        : null;
    input.openTile({
      node,
      target: { tabId: input.tabId },
      gesture: "explicit",
      modifiers: null,
      placement: effectivePlacement,
      dedupe: true,
      source: "direct_ui",
    });
  }
  if (input.projectedChatId === null) {
    input.markArtifactPendingCreate(input.handoffChatId);
    input.markedChatIdRef.current = input.handoffChatId;
  } else {
    input.unmarkArtifactPendingCreate(input.handoffChatId);
    if (input.markedChatIdRef.current === input.handoffChatId) {
      input.markedChatIdRef.current = null;
    }
  }
  if (input.handoffStatus === "waitingProjection") {
    useInitialChatHandoffStore.getState().markWaitingChat(input.scope);
  }
}

function tabContainsPane(tabId: string, paneId: string): boolean {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return false;
  return findPaneById(canvas.root, paneId) !== null;
}

function tabContainsTile(tabId: string, contentId: string): boolean {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return false;
  return collectPanes(canvas.root).some((pane) =>
    paneTabRefs(canvas, pane).some((ref) => ref.id === contentId),
  );
}

function epicReady(
  snapshotLoaded: boolean,
  connectionStatus: StreamConnectionStatus,
  permissionRole: PermissionRole | null,
): boolean {
  return (
    snapshotLoaded &&
    connectionStatus === "open" &&
    permissionRole !== null &&
    permissionRole !== "viewer"
  );
}

/**
 * Inverse of "active": adding a new non-terminal status doesn't require
 * touching this predicate, only the terminal list.
 */
function isHandoffTerminal(
  status: InitialChatHandoff["status"] | null,
): boolean {
  return status === "failed";
}

function resolveAdoptableChat(
  chatRecords: ReadonlyArray<EpicChatProjection>,
  userId: string | null,
): EpicChatProjection | null {
  if (userId === null) return null;
  const candidates = chatRecords.filter(
    (chat) => chat.parentId === null && chat.userId === userId,
  );
  if (candidates.length !== 1) return null;
  return candidates[0];
}
