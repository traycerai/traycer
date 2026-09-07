/** Host capability is read from the negotiated-manifest registry, not a store. */
import { useCallback, useSyncExternalStore } from "react";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { readEpicDocRecordArms } from "@/stores/epics/open-epic/doc-record-arms";
import {
  routeChatWrite,
  type ChatWriteRoute,
} from "@/stores/epics/open-epic/chat-write-routing";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

/**
 * Route one row's registry-backed chat mutations. Callers pass `isChatRow` from the union they already hold. A non-chat row is `"registry-rpc"`.
 */
export function resolveChatWriteRoute(args: {
  /** The chat UNION components read (`OpenEpicState["chats"]["byId"]`), not the whole store state: this reads one row and nothing else, and taking the map is what lets it be tested against a plain record instead of a projected store slice nothing may hand-set. */
  readonly chatsById: Readonly<Record<string, ChatProjection>>;
  readonly isChatRow: boolean;
  readonly nodeId: string;
  readonly sessionHostId: string | null;
}): ChatWriteRoute {
  if (!args.isChatRow) return "registry-rpc";
  return routeChatWrite({
    // `noUncheckedIndexedAccess` is off, so the index read needs the explicit
    // own-key check to distinguish a missing row from a present one.
    chat: Object.hasOwn(args.chatsById, args.nodeId)
      ? args.chatsById[args.nodeId]
      : undefined,
    docArm: readEpicDocRecordArms(args.sessionHostId),
  });
}

/** How many blocking rows a bulk refusal names before it summarises. */
const NAMED_BLOCKED_ROWS = 3;

/**
 * Refusal sentence for a multi-target action that contains unaddressable chats, naming the blocking rows. Destructive multi-select refuses as a whole.
 */
export function describeBlockedChatWrites(
  blockedTitles: readonly string[],
): string | null {
  if (blockedTitles.length === 0) return null;
  const named = blockedTitles
    .slice(0, NAMED_BLOCKED_ROWS)
    .map((title) => `“${title}”`);
  const remaining = blockedTitles.length - named.length;
  const list =
    remaining > 0
      ? `${named.join(", ")} and ${remaining} more`
      : named.join(", ");
  if (blockedTitles.length === 1) {
    return `${list} isn’t adopted by its host yet, so it can’t be deleted. Deselect it to delete the rest.`;
  }
  return `Some agents aren’t adopted by their host yet, so they can’t be deleted: ${list}. Deselect them to delete the rest.`;
}

const EMPTY_CHATS_BY_ID: Readonly<Record<string, ChatProjection>> =
  Object.freeze({});

/**
 * Use `useMaybeOpenEpicHandle` (not `useEpicStore`, which throws outside a provider). No session ungates: mutations are epic-scoped so there is nothing to misroute.
 */
function useChatsById(): Readonly<Record<string, ChatProjection>> {
  const handle = useMaybeOpenEpicHandle();
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      handle === null ? () => {} : handle.store.subscribe(onStoreChange),
    [handle],
  );
  const getSnapshot = useCallback(
    (): Readonly<Record<string, ChatProjection>> =>
      handle === null ? EMPTY_CHATS_BY_ID : handle.store.getState().chats.byId,
    [handle],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Derive the primitive verdict inside getSnapshot. A fresh object would loop useSyncExternalStore. */
export function useChatWriteRoute(
  isChatRow: boolean,
  nodeId: string,
): ChatWriteRoute {
  const sessionHostId = useEpicSessionHostId();
  const handle = useMaybeOpenEpicHandle();
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      handle === null ? () => {} : handle.store.subscribe(onStoreChange),
    [handle],
  );
  const getSnapshot = useCallback(
    (): ChatWriteRoute =>
      resolveChatWriteRoute({
        chatsById:
          handle === null
            ? EMPTY_CHATS_BY_ID
            : handle.store.getState().chats.byId,
        isChatRow,
        nodeId,
        sessionHostId,
      }),
    [handle, isChatRow, nodeId, sessionHostId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** The chat union for a caller that resolves several rows at once (the sidebar's bulk delete), sharing this module's session tolerance. */
export function useChatsByIdForWriteRoute(): Readonly<
  Record<string, ChatProjection>
> {
  return useChatsById();
}
