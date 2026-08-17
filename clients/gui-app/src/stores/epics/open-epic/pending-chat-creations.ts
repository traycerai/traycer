/**
 * Chats this client has had a host CREATE, for as long as no record for them
 * has arrived back.
 *
 * ## Why the record table alone cannot carry them
 *
 * `epic.createChat` writes the chat into the serving host's database and into
 * NOTHING this renderer already projects (the single-write pivot stopped the
 * doc write). The row only becomes visible once it makes the trip back through
 * `epic.listChatRecords` or a `host.chatRecords.subscribe` delta - up to a 20s
 * poll away, and further still when the creating host is not the one this
 * window's record stream is keyed to. An optimistic insert into the record map
 * does not survive either: `applyChatRecords` CLEARS AND REPLACES that map from
 * the serving host's snapshot, so the next poll evicts it.
 *
 * So creations are retained BESIDE the record rows and unioned in at publish
 * time, which is the one seam both the poll and the push path go through. A
 * pending row is expired when a real record with the same chat arrives via ANY
 * path, when the chat is retracted, or when the create fails.
 *
 * ## Keyed by chat identity, never by host
 *
 * A pending row is `(ownerUserId, chatId)` - the same identity a record row
 * carries - and names the host it was created on only as data to render. It is
 * deliberately NOT keyed by, or filtered against, whichever host is active:
 * creating on a host other than the active one is exactly the case this
 * primitive exists for, and the app-wide host-selection layer is being
 * re-architected separately.
 */
import type { ChatProjection, ChatsSlice } from "./types";
import { isChatVisibleToUser } from "./projection-helpers";

/**
 * What a creation surface knows at submit time, INCLUDING the owner it was
 * authorized as - see `ownerUserId`. The store stamps only what it alone knows:
 * the timestamps, from the clock.
 *
 * The owner used to be stamped here from the signed-in profile, which read the
 * wrong moment: this runs when the host answers, and a profile change while the
 * create was in flight refiled the row under a user who never made it.
 */
export interface PendingChatCreation {
  /**
   * The created chat. Client-minted and echoed by the resolver, so the request,
   * the response and the record that eventually arrives all name it.
   */
  readonly chatId: string;
  /** The host the chat is being created on - NOT whichever host is active. */
  readonly hostId: string;
  readonly parentChatId: string | null;
  /** The submitted title, normally `""` ("no title yet"). */
  readonly title: string;
  /**
   * The signed-in user the create was authorized as, captured by the caller when
   * the request left - NOT whoever is signed in when it is retained.
   *
   * Supplied rather than read here because only the caller knows that moment.
   * The registry keys every retirement decision by owner, so a row filed under
   * the wrong identity is one the real record can never retire; `null` means the
   * caller had no signed-in user, and the registration is dropped.
   */
  readonly ownerUserId: string | null;
}

/** A pending creation as retained: the caller's facts plus the store's stamp. */
export interface RetainedChatCreation {
  readonly pending: PendingChatCreation;
  /**
   * The signed-in user at registration. IDENTITY-BEARING, exactly as it is on a
   * record row: `chatId` is not globally unique, so two users can legitimately
   * hold the same one inside a single task (see the collaborator regression
   * test in `__tests__/chat-records-union.test.ts`). Every retirement decision
   * keys on this together with the id, and the display filter keys on it alone,
   * so a user switch hides an in-flight creation the same way it hides that
   * identity's records.
   *
   * Non-nullable, which is why the store REFUSES to retain a creation while no
   * profile is hydrated: a stand-in that cannot say whose it is could be
   * retired by a stranger's row, or shown to whoever signs in next.
   */
  readonly ownerUserId: string;
  readonly createdAt: number;
}

/**
 * A pending creation in the renderer's chat shape.
 *
 * `settings` is `null` for the same reason a record row projects `null` there
 * (see `chatProjectionFromRecord`): the row this one stands in for cannot carry
 * a settings tuple, so putting the submitted settings here would flip to `null`
 * the moment the real record lands - a visible change with no fact behind it.
 */
export function chatProjectionFromPendingCreation(
  retained: RetainedChatCreation,
): ChatProjection {
  return {
    id: retained.pending.chatId,
    title: retained.pending.title,
    parentId: retained.pending.parentChatId,
    createdAt: retained.createdAt,
    updatedAt: retained.createdAt,
    userId: retained.ownerUserId,
    hostId: retained.pending.hostId,
    isTitleEditedByUser: false,
    settings: null,
    archivedAt: null,
  };
}

/**
 * The record slice with every still-pending creation folded in.
 *
 * A real row ALWAYS wins: a pending entry whose chat is already in `records` is
 * skipped rather than merged, so the handover from optimistic to authoritative
 * cannot duplicate a row or overwrite a served field with a submit-time guess.
 * (Expiry deletes it at ingest anyway; this is what makes the union correct
 * even in the window before that runs.)
 *
 * Returns `records` BY REFERENCE when nothing is pending - the overwhelmingly
 * common case - so an epic with no creation in flight keeps the exact slice
 * identity the record path produced and costs no downstream re-render.
 */
export function unionPendingChatCreations(
  records: ChatsSlice,
  retained: Iterable<RetainedChatCreation>,
  currentUserId: string | null,
): ChatsSlice {
  let byId: Record<string, ChatProjection> | null = null;
  let allIds: string[] | null = null;
  for (const entry of retained) {
    const { chatId } = entry.pending;
    if (Object.hasOwn(records.byId, chatId)) continue;
    if (!isChatVisibleToUser(entry.ownerUserId, currentUserId)) continue;
    if (byId === null || allIds === null) {
      byId = { ...records.byId };
      allIds = [...records.allIds];
    }
    if (Object.hasOwn(byId, chatId)) continue;
    byId[chatId] = chatProjectionFromPendingCreation(entry);
    allIds.push(chatId);
  }
  if (byId === null || allIds === null) return records;
  return { byId, allIds };
}
