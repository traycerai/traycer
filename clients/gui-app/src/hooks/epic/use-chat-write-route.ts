/**
 * {@link routeChatWrite} at the UI's call sites.
 *
 * The predicate answers about ONE chat row. This module is the seam that finds
 * the row and the host fact for it, so the affordances that dispatch
 * `epic.renameChat` / `epic.setChatArchived` / `epic.deleteChat` all ask the
 * same question in the same order and cannot drift into four gates.
 *
 * ## Only chat rows are gated
 *
 * Every surface here is polymorphic - one row component renders chats,
 * terminal agents and artifacts - and `routeChatWrite` reads the CHAT union.
 * Handing it a terminal agent's id finds no row, which the predicate correctly
 * reads as unaddressable, so an ungated call would disable every terminal-agent
 * and artifact affordance on any host that serves a chat record plane. The kind
 * check is therefore part of the contract, not a caller's optimisation: the dnd
 * commit's `agentReparentRoute` guards the same way for the same reason.
 *
 * ## Reactivity
 *
 * The row is read through the epic store, so the `null` -> stated transition
 * (the delta plane's base row arrives carrying no home, then the poll answers)
 * re-enables the affordance on the next publication - no remount, no refetch.
 *
 * The HOST fact is not reactive: `readEpicDocRecordArms` reads the ambient
 * negotiated-manifest registry, which is module state rather than a store. A
 * host that upgrades in place therefore takes effect on the next store
 * publication rather than instantly. That is the same freshness the dnd commit
 * has (it reads the registry at commit time) and it is acceptable here because
 * the transition it matters for - a host GAINING a record plane - moves rows
 * from enabled to disabled, and the epic re-projects when it happens.
 */
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
 * The route for one row's registry-backed chat mutations.
 *
 * `isChatRow` rather than a row-kind union because the callers do not share
 * one: the sidebar rows are `EpicNodeKind` (which has `"terminal"` and the
 * individual artifact kinds), the mobile switcher rows are `SwitcherRowKind`
 * (which lumps artifacts into `"artifact"`), and a canvas tab has its own.
 * "Is this a chat" is the actual domain, and each caller answers it from the
 * union it already holds.
 *
 * A non-chat row is `"registry-rpc"`: it is not what this gate is about, and
 * its own routing (`isDocOnlyTerminalAgent` for terminal agents, the artifact
 * RPCs for artifacts) is unchanged.
 */
export function resolveChatWriteRoute(args: {
  /**
   * The chat UNION components read (`OpenEpicState["chats"]["byId"]`), not the
   * whole store state: this reads one row and nothing else, and taking the map
   * is what lets it be tested against a plain record instead of a projected
   * store slice nothing may hand-set.
   */
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
 * The refusal sentence for a MULTI-target action that contains unaddressable
 * chats, or `null` when none do.
 *
 * A destructive multi-select refuses as a whole rather than partly succeeding:
 * a user who selects five, confirms, and sees four vanish is least likely to
 * notice the one that silently remained, and a clean refusal is recoverable
 * where a silent partial is not. That only holds if the refusal is
 * ACTIONABLE - one that does not say which row to deselect is a dead end - so
 * this names the blocking rows.
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
 * The chat union, or an empty one when this surface has no epic session.
 *
 * `useMaybeOpenEpicHandle` rather than `useEpicStore`, which throws outside a
 * provider. Several of the surfaces this gate reaches - the canvas tab strip
 * most of all - are mounted in contexts that do not always carry an epic
 * session, and a status gate is the last thing that should be able to take a
 * surface down.
 *
 * Ungating in that case is not a hole. The three mutations are epic-scoped
 * (`epicId` is a required parameter), so with no session there is nothing to
 * dispatch and nothing to misroute; and the host leg agrees by construction -
 * no session means no `sessionHostId`, and `readEpicDocRecordArms(null)`
 * answers "the doc is still a record source", which is the same
 * fact-one-satisfied `"registry-rpc"` a floor-era host gets.
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

/**
 * {@link resolveChatWriteRoute} against the live epic session.
 *
 * Returns a plain string union, so an unchanged verdict is `Object.is`-equal
 * and re-renders nobody.
 *
 * That sentence has been here since this hook shipped and was FALSE as wired:
 * the verdict was derived AFTER the subscription, off `useChatsById()` - the
 * whole `chats.byId` map - so every row calling this re-rendered whenever any
 * chat record moved, whatever verdict it then computed. Measured on the field's
 * shape (40 chat rows, 12 bursted): 40 of 40 re-rendered per burst, and it
 * survived the row-level narrowing in `d1cb1b3a` untouched because the
 * subscription is two modules away from the row that pays for it.
 *
 * The derivation is inside `getSnapshot` now, so what this row subscribes to IS
 * its answer. `getSnapshot` must stay pure and must keep returning a primitive:
 * `useSyncExternalStore` compares snapshots with `Object.is` and would loop on
 * a freshly-allocated object.
 */
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

/**
 * The chat union for a caller that resolves several rows at once (the sidebar's
 * bulk delete), sharing this module's session tolerance.
 */
export function useChatsByIdForWriteRoute(): Readonly<
  Record<string, ChatProjection>
> {
  return useChatsById();
}
