import {
  use,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { HostReachabilityStatus } from "@/hooks/agent/use-host-reachability";
import { useOwnerSandboxOpensLive } from "@/hooks/chats/use-owner-sandbox-opens-live";
import { makeChatOpenTileRef } from "@/lib/chats/chat-open-tile-ref";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { PublishedChatTileRef } from "@/stores/epics/canvas/types";

/**
 * Whether a published copy on screen should give way to the live chat tile.
 *
 * The tile kind is chosen once, when the row is tapped, and a copy opened
 * while the owner was away used to stay a copy for the tab's life: the footer
 * followed the owner back ("not available live from this device") but nothing
 * on screen said the one thing that works, close and reopen. This is the
 * row's own open decision, re-run from inside the copy, with the proof the
 * row does not have.
 *
 * - `ownerOpensLive` is what the row reads: the owner answers, or it is a
 *   team sandbox at rest the pool serves (`useOwnerSandboxOpensLive`).
 *   `checking` and `host-starting` are not `reachable`, so a host mid-restart
 *   does not flip the tile twice.
 * - `ownerRefusesStore`: a reachable owner too old for the epic's store
 *   would dial the live tile straight into `HOST_OLDER_THAN_DATA`.
 * - `ownerIsThisHost`: the copy exists because the serving host answered
 *   that it no longer holds the chat; there is no live tile to convert to.
 * - `recordOnOwner` is the proof: the epic's own projection holds a chat
 *   record with this id whose persisted owner host is the copy's. A
 *   cloud-only row, a fork clone sharing the id under another owner, or a
 *   chat the host deleted while away all fail it and keep the copy. This is
 *   what the old "open it live" button lacked when reachability alone routed
 *   it to a tile that opened nothing.
 */
export function publishedChatOpensLive(input: {
  readonly ownerOpensLive: boolean;
  readonly ownerRefusesStore: boolean;
  readonly ownerIsThisHost: boolean;
  readonly recordOnOwner: boolean;
}): boolean {
  return (
    input.ownerOpensLive &&
    !input.ownerRefusesStore &&
    !input.ownerIsThisHost &&
    input.recordOnOwner
  );
}

/**
 * Converts a published-copy tab into the live chat tile, once, when
 * {@link publishedChatOpensLive} first turns true for it.
 *
 * The live ref is minted through `makeChatOpenTileRef` with the owner
 * reachable, so it is byte-for-byte the ref the sidebar row would open now,
 * bound to the OWNER host; the published ref stays bound to its serving
 * host, which is why this is a replacement and not a mutation (tabs bind a
 * host for life). The swap is `replacePublishedChatTileInTab`: same pane,
 * same slot, and the copy is not recorded as a closed tile.
 *
 * Once per mount: the swap unmounts this tile, and where the store holds no
 * such instance (the canvas rendering a copy over a live ref) the action is
 * a no-op that must not be retried on every re-render.
 *
 * The proof reads the surrounding epic session the way
 * `useEpicChatRecordHead` does, `epicId` as a guard, so a tile rendered
 * under another epic's session, or none, never converts.
 */
export function usePublishedChatLiveConversion(input: {
  readonly node: PublishedChatTileRef;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly ownerStatus: HostReachabilityStatus;
  readonly ownerRefusesStore: boolean;
  readonly ownerIsThisHost: boolean;
}): void {
  const { node, epicId, viewTabId, paneId } = input;
  const ownerHostId = node.ownerHostId.length > 0 ? node.ownerHostId : null;
  const ownerSandboxOpensLive = useOwnerSandboxOpensLive(ownerHostId);
  const handle = use(EpicSessionContext);
  const store =
    handle !== null && handle.epicId === epicId ? handle.store : null;
  const subscribe = useCallback(
    (onChange: () => void) =>
      store === null ? () => undefined : store.subscribe(onChange),
    [store],
  );
  const getRecordOnOwner = useCallback((): boolean => {
    if (store === null || ownerHostId === null) return false;
    const chats = store.getState().chats.byId;
    if (!Object.hasOwn(chats, node.chatId)) return false;
    const chat = chats[node.chatId];
    return chat.hostId === ownerHostId && chat.userId === node.ownerUserId;
  }, [store, ownerHostId, node.chatId, node.ownerUserId]);
  const recordOnOwner = useSyncExternalStore(
    subscribe,
    getRecordOnOwner,
    getRecordOnOwner,
  );
  const opensLive = publishedChatOpensLive({
    ownerOpensLive:
      ownerHostId !== null &&
      (input.ownerStatus === "reachable" || ownerSandboxOpensLive),
    ownerRefusesStore: input.ownerRefusesStore,
    ownerIsThisHost: input.ownerIsThisHost,
    recordOnOwner,
  });
  const converted = useRef(false);
  useEffect(() => {
    if (!opensLive || converted.current || ownerHostId === null) return;
    converted.current = true;
    useEpicCanvasStore.getState().replacePublishedChatTileInTab(
      viewTabId,
      paneId,
      node.instanceId,
      makeChatOpenTileRef({
        taskId: node.taskId,
        chatId: node.chatId,
        name: node.name,
        ownerHostId,
        ownerUserId: node.ownerUserId,
        ownerIsUnreachable: false,
        ownerRefusesStore: false,
        sessionHostId: node.hostId,
      }),
    );
  }, [
    opensLive,
    ownerHostId,
    viewTabId,
    paneId,
    node.instanceId,
    node.taskId,
    node.chatId,
    node.name,
    node.ownerUserId,
    node.hostId,
  ]);
}
