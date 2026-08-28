import { useEffect, useMemo, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import { displayTitle } from "@/lib/display-title";
import {
  ACTIVE_TILE_PLACEMENT,
  openChatNodeWithPlacement,
  type ConversationTilePlacement,
} from "@/lib/canvas/conversation-tile-placement";
import {
  useEpicChatRecords,
  useEpicConnectionStatus,
  useEpicPermissionRole,
  useEpicSnapshotLoaded,
} from "@/lib/epic-selectors";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
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
 * How long a `pending` handoff may sit with no projected chat before the
 * eager-opened tab is treated as an orphan. Generous on purpose: the create is
 * local-first (the chat normally projects in well under a second), so this only
 * ever fires when nothing was created at all.
 */
const CHAT_PROJECTION_DEADLINE_MS = 60_000;

/**
 * Where the seeded chat LIVES: the host `epic.create` ran on, recorded on the
 * handoff at registration by the landing composer (`hostId` is data on the
 * record, not part of its key). That is the truest binding for the tile -
 * truer than the session host, which is where this canvas STREAMS the epic
 * from and can differ from the creating host for a cloud-hydrated epic - so it
 * comes first; the canvas (session) host is the fallback for a record that
 * carries none. Never the app-wide pointer, which is what this used to be.
 */
function handoffTileHost(
  handoff: InitialChatHandoff | null,
  canvasHostId: string | null,
): string | null {
  return handoff?.hostId ?? canvasHostId;
}

/**
 * Drives the landing-page → epic-canvas chat-handoff lifecycle and is the
 * sole owner of the canvas-store `pendingCreateArtifactIds` mark for handoff
 * chats. The mark suppresses the deleted-body branch in
 * `tab-group-view.tsx::computeIsRemoteDeleted` while the host's create write +
 * Y projection are still landing.
 *
 * The chat itself is created by `epic.create` (folded), not here - this hook
 * only advances the handoff as the seeded chat projects, eager-opens the tab,
 * and manages the pending-create mark.
 */
export function useInitialChatHandoff(epicId: string, tabId: string): void {
  // The CANVAS's host - the Epic session's - not the app-wide pointer. The
  // key this scope is looked up under dropped its host segment
  // (`initialChatHandoffKey`), so this value never decides WHETHER the handoff
  // is found; it decides which host the seeded chat's TILE is stamped with,
  // via `runCanvasHandoffTransition` below, and a tile carries that binding
  // for life. Read app-wide, it stamped a chat created on the composer's
  // placement host B with whichever host the WINDOW had moved to.
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
  // The authoritative "does this chat really exist yet" source - the projected
  // epic chats. The chat tab is eager-opened (canvas state) + marked
  // pending-create so it survives until this projection catches up.
  const chatRecords = useEpicChatRecords();
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const prepareOpenTileInPaneFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInPaneFocusTarget,
  );
  const prepareSplitPaneWithNodeFocusTarget = useEpicCanvasStore(
    (s) => s.prepareSplitPaneWithNodeFocusTarget,
  );
  const markArtifactPendingCreate = useEpicCanvasStore(
    (s) => s.markArtifactPendingCreate,
  );
  const unmarkArtifactPendingCreate = useEpicCanvasStore(
    (s) => s.unmarkArtifactPendingCreate,
  );
  // Every placement kind (active-tile, target-group, split) opens exactly
  // once per chat, even as the handoff effect re-runs across status/
  // projection transitions. The tab label tracks the projected title live
  // via `useEpicTabDisplayTitle`'s `liveArtifactTitle` fallback, so
  // re-opening on each transition is unnecessary and would re-navigate /
  // steal focus from whatever the user is looking at.
  const openedChatIdRef = useRef<string | null>(null);
  // The chatId whose pending-create mark this hook currently owns. A second
  // in-epic create registers a new handoff under the same {host,user,epic}
  // scope; this lets the next transition release the prior chat's mark instead
  // of orphaning it.
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
  const handoffPlacement = handoff?.placement ?? ACTIVE_TILE_PLACEMENT;
  const handoffCreatedAt = handoff?.createdAt ?? 0;
  const projectedChatId = projectedChat?.id ?? null;
  const projectedChatTitle = projectedChat?.title ?? null;
  const adoptableChatId = adoptableChat?.id ?? null;

  // Bounded wait for the folded chat to exist at all. The tab is eager-opened
  // around the pre-minted chat id and `pendingCreateArtifactIds` exempts it
  // from the record-liveness sweep for as long as this handoff is non-terminal
  // - so a create that produced NO chat (a host that dropped the folded seed,
  // or a create that failed after this tab was opened) leaves a permanent
  // blank tab around an id that exists on no host and in no cloud row. A ready
  // epic (own snapshot, live connection, non-viewer) whose projection still has
  // no chat after the deadline is that case: give up, which releases the
  // pending-create mark below and lets the sweep close the tab. Armed only for
  // `pending`: every later status implies the chat already projected, except
  // the `markInitialTurnStarted` jump to `sending`, where the host confirmed
  // the chat exists. Measured from `createdAt` (persisted) so a reload does not
  // restart the clock. Sibling of `new-chat.ts`'s CHAT_PROJECTION_WAIT_MS,
  // which bounds the same question for the in-Epic create-then-open flow.
  useEffect(() => {
    if (handoffChatId === null) return;
    if (handoffStatus !== "pending") return;
    if (projectedChatId !== null) return;
    if (!epicReady(snapshotLoaded, connectionStatus, permissionRole)) return;
    const timeoutId = window.setTimeout(
      () => {
        // The deadline belongs to the handoff that ARMED it. `markFailed` is
        // scope-keyed, and a second create can REPLACE the handoff under this
        // same {host,user,epic} scope in the gap between the store write and
        // this effect's cleanup (the timer is a macrotask; React's cleanup
        // lands on commit) - so re-read the scope and fail only the exact
        // still-pending handoff this timer was armed for, never a
        // replacement's fresh one.
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

  // Advance the handoff out of `pending` once the folded chat projects (the
  // common path) or a single user-owned root-level GUI chat exists (reload /
  // legacy recovery). `epic.create` seeds the chat, so this normally fires as
  // soon as the first epic snapshot lands.
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

  // Eager-open + lifecycle mark: open the canvas tab as soon as the
  // handoff has a chatId, and mark/unmark `pendingCreateArtifactIds` based
  // on whether the projection has caught up. Single effect so the mark and
  // its inverse can never race within the same commit.
  useEffect(() => {
    runCanvasHandoffTransition({
      tileHostId: handoffTileHostId,
      handoffChatId,
      handoffStatus,
      handoffPlacement,
      markArtifactPendingCreate,
      openTileInTab: (targetTabId, node) => {
        navigateNested(epicId, targetTabId, () =>
          prepareOpenTileInTabFocusTarget(targetTabId, node),
        );
      },
      openTileInPane: (targetTabId, paneId, node) => {
        navigateNested(epicId, targetTabId, () =>
          prepareOpenTileInPaneFocusTarget(targetTabId, paneId, node),
        );
      },
      splitPaneWithNode: (targetTabId, targetPaneId, position, node) => {
        navigateNested(epicId, targetTabId, () =>
          prepareSplitPaneWithNodeFocusTarget(
            targetTabId,
            targetPaneId,
            position,
            node,
          ),
        );
      },
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
    epicId,
    navigateNested,
    prepareOpenTileInPaneFocusTarget,
    prepareOpenTileInTabFocusTarget,
    prepareSplitPaneWithNodeFocusTarget,
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
  readonly handoffPlacement: ConversationTilePlacement;
  readonly markArtifactPendingCreate: (artifactId: string) => void;
  readonly openTileInTab: (tabId: string, node: EpicCanvasTileRef) => void;
  readonly openTileInPane: (
    tabId: string,
    paneId: string,
    node: EpicCanvasTileRef,
  ) => void;
  readonly splitPaneWithNode: (
    tabId: string,
    targetPaneId: string,
    position: "right" | "bottom",
    node: EpicCanvasTileRef,
  ) => void;
  readonly openedChatIdRef: { current: string | null };
  readonly markedChatIdRef: { current: string | null };
  readonly projectedChatId: string | null;
  readonly projectedChatTitle: string | null;
  readonly scope: InitialChatHandoffScope;
  readonly tabId: string;
  readonly unmarkArtifactPendingCreate: (artifactId: string) => void;
}

function runCanvasHandoffTransition(input: CanvasHandoffTransitionInput): void {
  // Clobber cleanup: a second in-epic create can register a fresh handoff under
  // this same {host,user,epic} scope before the first chat projects. The chatId
  // we previously marked is then no longer this handoff's chat - release its
  // pending-create mark so a healthy abandoned chat doesn't keep a stale
  // "suppress remote-deleted" mark forever.
  //
  // Runs BEFORE the no-handoff bail: the handoff can also VANISH from this
  // scope (consumed elsewhere, signed-out user, active-host swap moving the
  // {host,user,epic} key out from under this hook), and bailing first left the
  // mark set with nobody able to clear it - the exempt-from-the-sweep tab that
  // outlives every other trace of the create.
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

  // Eager-open the canvas tile so it mounts. The tile gates its
  // `chat.subscribe` on the chat record existing in the projection and shows
  // its loading skeleton until the seeded chat lands (~0.5s, host is
  // local-first). `markArtifactPendingCreate` keeps the tab alive (suppresses
  // the remote-deleted branch) while the real chat projects; once projected,
  // the mark is cleared.
  const node: EpicCanvasTileRef = {
    id: input.handoffChatId,
    instanceId: uuidv4(),
    type: "chat",
    // Snapshot fallback label for the node: the projected title when present,
    // else the "Untitled agent" render fallback (this is a durable Agent tab,
    // addressed as an Agent regardless of its Chat interface). Never the
    // "New chat" placeholder.
    name: displayTitle(input.projectedChatTitle ?? "", "agent"),
    hostId: input.tileHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  };
  const placement = input.handoffPlacement;
  // Latch every placement kind once per handoffChatId. The ref guards
  // re-fires within a session; `tabContainsTile` also guards a reload, where
  // the canvas layout persists the tile but the ref does not (without it
  // each reload would stack a duplicate).
  if (
    input.openedChatIdRef.current !== input.handoffChatId &&
    !tabContainsTile(input.tabId, input.handoffChatId)
  ) {
    input.openedChatIdRef.current = input.handoffChatId;
    // Opener placements (target-group / split) bypass dedup. If the target
    // group is gone (closed mid-compose, or a stale id rehydrated on
    // reload), fall back to the active tile so the chat always surfaces
    // instead of vanishing.
    const effectivePlacement =
      placement.kind === "active-tile" ||
      tabContainsPane(input.tabId, placement.groupId)
        ? placement
        : ACTIVE_TILE_PLACEMENT;
    openChatNodeWithPlacement(
      {
        openTileInTab: input.openTileInTab,
        openTileInPane: input.openTileInPane,
        splitPaneWithNode: input.splitPaneWithNode,
      },
      input.tabId,
      node,
      effectivePlacement,
    );
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

/** Whether `tabId`'s canvas currently holds a pane with `paneId`. */
function tabContainsPane(tabId: string, paneId: string): boolean {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return false;
  return findPaneById(canvas.root, paneId) !== null;
}

/** Whether `tabId`'s canvas already holds a tile for content `contentId`. */
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
