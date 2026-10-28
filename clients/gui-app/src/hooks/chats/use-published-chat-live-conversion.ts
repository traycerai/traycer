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
 * Converts a published-copy tab into the live chat tile once the matching
 * owner record is present and the owner can serve it.
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
  // A serving owner has already reported this chat missing locally; a
  // refusing owner cannot open this epic's store. Reachability alone is not
  // proof of a live chat: the projection must match both owner identities.
  const opensLive =
    ownerHostId !== null &&
    (input.ownerStatus === "reachable" || ownerSandboxOpensLive) &&
    !input.ownerRefusesStore &&
    !input.ownerIsThisHost &&
    recordOnOwner;
  const converted = useRef(false);
  useEffect(() => {
    if (!opensLive || converted.current) return;
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
