import { useCallback, useMemo, useSyncExternalStore } from "react";
import { create, useStore } from "zustand";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  getChatSessionRegistry,
  useExistingChatSessionHandle,
} from "@/lib/registries/chat-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";

/**
 * The read side of the Shells surface for one chat.
 *
 * The set rides that chat's own `chat.subscribe` stream, so these hooks are
 * projections of the chat session store rather than a stream of their own.
 * Every surface that reads them is chat-scoped - the chat tile's menu and the
 * chat's Background panel - and reading through the chat session binds them to
 * the tab's host the way every other chat surface is bound. That binding is
 * now EXPLICIT: each hook takes the `hostId` its caller is bound to, since a
 * host-minted `chatId` alone does not name a session.
 *
 * Empty means empty: a host too old to serve the field has no managed-command
 * subsystem, so it owns no commands. There is no "unavailable" state to
 * distinguish, and these hooks never return `null` for "not answered yet" - a
 * chat that has not received its snapshot has nothing to show either way.
 */

type ManagedCommandsChatSlice = Pick<
  ChatSessionState,
  "managedCommands" | "connectionStatus" | "snapshotLoaded"
>;

// Stable stand-in for a chat with no live session (its tile is not mounted, or
// the snapshot has yet to land): no commands, and a stream still connecting.
const emptyChatSlice = create<ManagedCommandsChatSlice>()(() => ({
  managedCommands: [],
  connectionStatus: "connecting",
  snapshotLoaded: false,
}));

function useChatSliceStore(epicId: string, chatId: string, hostId: string) {
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  return handle === null ? emptyChatSlice : handle.store;
}

/**
 * Running first, then most recent activity. A command that is doing something
 * now outranks one that finished a second ago, which is what a human scanning
 * for "what is live" is looking for.
 */
function compareManagedCommands(a: ManagedCommand, b: ManagedCommand): number {
  const aRunning = a.status.state === "running";
  const bRunning = b.status.state === "running";
  if (aRunning !== bRunning) return aRunning ? -1 : 1;
  return b.updatedAtMs - a.updatedAtMs;
}

/**
 * Every command this chat owns, whatever state it is in - the menu's list. The
 * ordering is applied once here so every reader shares it; the host sends the
 * set whole, so the sorted array only changes when the set does.
 */
export function useManagedCommandsForChat(
  epicId: string,
  chatId: string,
  hostId: string,
): readonly ManagedCommand[] {
  const commands = useStore(
    useChatSliceStore(epicId, chatId, hostId),
    (state) => state.managedCommands,
  );
  return useMemo(() => [...commands].sort(compareManagedCommands), [commands]);
}

/**
 * The subset of {@link useManagedCommandsForChat} that is live right now - what
 * the chat's Background panel lists, since that panel is about work happening
 * at this moment rather than about the commands as durable objects.
 */
export function useRunningManagedCommandsForChat(options: {
  epicId: string;
  chatId: string;
  hostId: string;
}): readonly ManagedCommand[] {
  const commands = useManagedCommandsForChat(
    options.epicId,
    options.chatId,
    options.hostId,
  );
  return useMemo(
    () => commands.filter((command) => command.status.state === "running"),
    [commands],
  );
}

/**
 * The chat stream's connection status, which is now also the commands' - they
 * arrive on it. A menu held open across a dropped connection says its rows may
 * be stale rather than silently freezing them.
 */
export function useManagedCommandsConnectionStatus(
  epicId: string,
  chatId: string,
  hostId: string,
): StreamConnectionStatus {
  return useStore(
    useChatSliceStore(epicId, chatId, hostId),
    (state) => state.connectionStatus,
  );
}

/**
 * One command by id, found across the live chat sessions of ONE host in this
 * epic - what an output window's tab title and glyph read, holding a command
 * pointer and no chat id.
 *
 * Scoped to the tile's bound host, not the epic: a cross-host clone carries the
 * source transcript's command ids, so an epic-wide scan would let a tab bound
 * to the clone host wear the source shell's live name and monitor glyph for a
 * shell that host does not own. Within one host the id is unambiguous, and it
 * stays a scan rather than an index because a host's live sessions are a
 * handful and the alternative is a second source of truth to keep in step.
 *
 * `null` when the owning chat has no live session on that host (never opened,
 * or gone idle), which is the window's pre-hydration state - the tab falls back
 * to its persisted name until the chat is opened.
 */
export function useManagedCommandOnHost(args: {
  readonly epicId: string;
  readonly hostId: string;
  readonly commandId: string;
}): ManagedCommand | null {
  const { epicId, hostId, commandId } = args;
  const subscribe = useCallback(
    (onChange: () => void) =>
      subscribeHostManagedCommands(epicId, hostId, commandId, onChange),
    [epicId, hostId, commandId],
  );
  const getSnapshot = useCallback(
    () => findManagedCommandOnHost(epicId, hostId, commandId),
    [epicId, hostId, commandId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/**
 * Whether a shell still exists, as far as this card can honestly tell.
 *
 * Scoped to the transcript's bound HOST - never to the epic, and not to the
 * owner chat alone. A cross-host clone carries the source transcript's blocks,
 * so a lookup by command id alone would find the SOURCE host's shell and let
 * the clone's card pulse it as live while its door opened a tile on a host
 * that cannot own it. Within the host the chat does not narrow it further: a
 * same-host fork copies those blocks too, and the shell they name is owned by
 * the source chat while being perfectly alive and openable here.
 *
 * Absence is a verdict once the owner's snapshot has landed, and only then:
 * that is the moment its command set is the host's word rather than a
 * placeholder. A session opens with an empty set and stays that way until the
 * snapshot arrives, and a card that read that as "deleted" told every reader,
 * on every chat open, that every shell was gone for the first few frames.
 *
 * The live connection status is deliberately NOT part of it. A shell the host
 * has already said nothing about does not come back when the socket blips, so
 * demoting a proven deletion to `unknown` for the length of a reconnect would
 * re-arm doors onto a shell whose log is gone. `snapshotLoaded` is the honest
 * gate at both ends: it is false before the first word and false again after a
 * re-subscribe, when the new stream has yet to speak.
 *
 * Anything less is `unknown`, and a surface treats unknown as "still there" -
 * the door stays open, and the output window it opens has its own honest
 * account of what it finds.
 */
export type ManagedCommandPresence =
  | { readonly kind: "present"; readonly command: ManagedCommand }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

export function useManagedCommandPresence(args: {
  readonly epicId: string | null;
  readonly commandId: string;
  readonly owner: { readonly chatId: string; readonly hostId: string } | null;
}): ManagedCommandPresence {
  const { epicId, commandId, owner } = args;
  // Presence is read across the owner's HOST, not just the owner chat: a
  // same-host fork copies the source transcript's blocks verbatim, so a card
  // there points at a shell the SOURCE chat owns. That shell is alive and its
  // output opens fine on this host, and the fork's own set - which will never
  // hold it - is no evidence about it.
  const live = useManagedCommandOnHost({
    epicId: epicId ?? "",
    hostId: owner?.hostId ?? "",
    commandId,
  });
  // ...but only the owner chat's session can date the evidence: its snapshot is
  // the "the host has now spoken" mark this verdict waits for.
  const ownerStore = useChatSliceStore(
    epicId ?? "",
    owner?.chatId ?? "",
    owner?.hostId ?? "",
  );
  const ownerAnswered = useStore(ownerStore, (state) => state.snapshotLoaded);
  if (epicId === null || owner === null) return { kind: "unknown" };
  if (live !== null) return { kind: "present", command: live };
  return ownerAnswered ? { kind: "absent" } : { kind: "unknown" };
}

/**
 * Stable across calls while nothing changes: the host sends the set whole, so
 * the array - and the record inside it - keeps its identity until a new frame
 * replaces it. That is what lets `useSyncExternalStore` read this directly.
 */
function findManagedCommandOnHost(
  epicId: string,
  hostId: string,
  commandId: string,
): ManagedCommand | null {
  if (commandId.length === 0) return null;
  for (const handle of hostHandles(epicId, hostId)) {
    const found = handle.store
      .getState()
      .managedCommands.find((command) => command.id === commandId);
    if (found !== undefined) return found;
  }
  return null;
}

/** This epic's live chat sessions on ONE host - never another host's. */
function hostHandles(
  epicId: string,
  hostId: string,
): readonly ChatSessionStoreHandle[] {
  if (hostId.length === 0) return [];
  return getChatSessionRegistry().listHandlesForHost(epicId, hostId);
}

/**
 * The registry is read at call time, never as a module constant: this module is
 * reached from `epic-selectors`, which the registry itself imports, so a
 * top-level read would run inside that import cycle before it exists.
 */
function subscribeHostManagedCommands(
  epicId: string,
  hostId: string,
  commandId: string,
  onChange: () => void,
): () => void {
  if (commandId.length === 0) return noopUnsubscribe;
  const handleSubs = new Map<ChatSessionStoreHandle, () => void>();

  const resync = (): void => {
    reconcileStoreSubscriptions(
      hostHandles(epicId, hostId),
      handleSubs,
      (handle) =>
        handle.store.subscribe((state, previousState) => {
          if (state.managedCommands === previousState.managedCommands) return;
          onChange();
        }),
    );
    onChange();
  };

  const unsubscribeRegistry = getChatSessionRegistry().subscribe(resync);
  resync();

  return () => {
    unsubscribeRegistry();
    for (const unsubscribe of handleSubs.values()) unsubscribe();
    handleSubs.clear();
  };
}

function noopUnsubscribe(): void {}
