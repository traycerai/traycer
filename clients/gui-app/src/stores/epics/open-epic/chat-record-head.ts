import type {
  ChatRecordHeadStamp,
  ChatRecordSummaryV11,
} from "@traycer/protocol/host/epic/chat-records";

/**
 * The chat record row's TWO independently ordered facts, and the merge that
 * keeps them independent.
 *
 * A record row carries metadata (title, parent, archive state, ...) ordered by
 * `revision` - the owner host's projection counter - and, since
 * `epic.listChatRecords@1.1` / `host.chatRecords.subscribe@1.3`, the chat's
 * cloud publication `head`, ordered by its own server-monotonic `publishedAt`.
 * The two are written by two independent queues on the owner host (the
 * metadata outbox and the chat publisher), so a row can legitimately arrive
 * with a NEWER head at an UNCHANGED revision (a turn was published and nothing
 * was renamed) or a newer revision carrying an OLDER head (a rename landed
 * before a slower publication committed). A single "drop unless revision
 * strictly exceeds" guard drops the first case on the floor and the second
 * case regresses a head the tile has already keyed a read on.
 *
 * So the store merges the two facts separately, exactly as the host's replica
 * store does: metadata advances on `revision`, the head advances on
 * `publishedAt`, and the row is written when EITHER advances - with each fact
 * taken from whichever side holds the newer one.
 *
 * ## A head is never cleared by a row without one
 *
 * `head` is optional AND nullable on the wire, and neither absence retracts a
 * held stamp. Absent is an older peer's row (`@1.0` list, `@1.0`-`@1.2`
 * stream) that never carried the field; `null` is a host's "no publication to
 * point at". A held stamp proves a publication happened, and a publication is
 * never undone short of the chat's removal - which arrives as a `remove`
 * frame and drops the whole row. Letting a metadata-only row clear the head
 * would send the tile back to its unkeyed read every time a rename raced a
 * publication, for nothing.
 */

/**
 * The record identity, `(ownerUserId, chatId)`, as one map key.
 *
 * `chatId` alone is host-minted and not unique under a task, so a key on it
 * would let a collaborator's row evict the viewer's own same-id chat. The
 * separator is a control character no id can contain.
 */
export function chatRecordKey(ownerUserId: string, chatId: string): string {
  return `${ownerUserId}\u001f${chatId}`;
}

/**
 * The row to hold after merging `incoming` over `held`, or `null` when
 * nothing about `incoming` is newer - a replay, a reorder, a duplicate, or
 * an older snapshot - and the held row stands.
 *
 * Object identity is preserved where it can be: an unchanged head is the
 * SAME stamp object, so a subscriber keyed on it sees no change.
 */
export function mergeChatRecordRow(
  held: ChatRecordSummaryV11 | undefined,
  incoming: ChatRecordSummaryV11,
): ChatRecordSummaryV11 | null {
  if (held === undefined) return incoming;
  const metadataAdvances = incoming.revision > held.revision;
  const heldHead = held.head ?? null;
  const incomingHead = incoming.head ?? null;
  const headAdvances =
    incomingHead !== null &&
    (heldHead === null || incomingHead.publishedAt > heldHead.publishedAt);
  if (!metadataAdvances && !headAdvances) return null;
  const head = headAdvances ? incomingHead : heldHead;
  if (metadataAdvances) {
    return head === incomingHead ? incoming : { ...incoming, head };
  }
  // Head-only advance: the held metadata stays, verbatim.
  return { ...held, head };
}

/**
 * The publication heads the record table currently holds, keyed by
 * {@link chatRecordKey}. Rows with no head are simply absent.
 *
 * Built over EVERY retained row regardless of owner: the published-copy tile
 * for a collaborator's chat reads its head from here, and the owner filter
 * that shapes `chats.byId` is a display rule the head has no part in.
 */
export function chatRecordHeadsFromRows(
  rows: Iterable<ChatRecordSummaryV11>,
): Readonly<Record<string, ChatRecordHeadStamp>> {
  const heads: Record<string, ChatRecordHeadStamp> = {};
  for (const row of rows) {
    const head = row.head ?? null;
    if (head === null) continue;
    heads[chatRecordKey(row.ownerUserId, row.chatId)] = head;
  }
  return heads;
}

export const EMPTY_CHAT_RECORD_HEADS: Readonly<
  Record<string, ChatRecordHeadStamp>
> = Object.freeze({});

export function chatRecordHeadStampsEq(
  a: ChatRecordHeadStamp,
  b: ChatRecordHeadStamp,
): boolean {
  return (
    a === b ||
    (a.headSha256 === b.headSha256 &&
      a.publishedAt === b.publishedAt &&
      a.throughRecordSeq === b.throughRecordSeq)
  );
}

/**
 * Whether two head tables say the same thing, entry for entry - the change
 * gate that keeps a poll re-serving unchanged rows from publishing a new
 * table identity.
 */
export function chatRecordHeadsEq(
  a: Readonly<Record<string, ChatRecordHeadStamp>>,
  b: Readonly<Record<string, ChatRecordHeadStamp>>,
): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every(
    (key) => Object.hasOwn(b, key) && chatRecordHeadStampsEq(a[key], b[key]),
  );
}
