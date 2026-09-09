import type { ChatRecordHeadStamp } from "@traycer/protocol/host/epic/chat-records";

/**
 * The chat record's TWO independently ordered facts, and why the head is a
 * plane of its own rather than a field on the retained record row.
 *
 * A record row carries metadata (title, parent, archive state, ...) ordered by
 * `revision` - the owner host's projection counter - and, since
 * `epic.listChatRecords@1.2` / `host.chatRecords.subscribe@1.3`, the chat's
 * cloud publication `head`, ordered by its own server-monotonic `publishedAt`.
 * The two are written by two independent queues on the owner host (the
 * metadata outbox and the chat publisher), so a row can legitimately arrive
 * with a NEWER head at an UNCHANGED revision (a turn was published and nothing
 * was renamed) or a newer revision carrying an OLDER head (a rename landed
 * before a slower publication committed).
 *
 * ## Why this is not merged into the record table
 *
 * The record table's guard is `revision`-only and deliberately so: `runtime/
 * record-table.ts` accepts or rejects a WHOLE row on a strictly-exceeds test,
 * which is what makes replayed, reordered and duplicated deltas harmless with
 * no merge logic anywhere. A head-only delta arrives at an UNCHANGED revision
 * and is correctly dropped by that guard - correctly, because nothing about
 * the row's metadata is newer.
 *
 * Teaching that table a second ordering fact would mean a per-field merge in
 * an algorithm shared with the terminal-agent plane, for a field only chats
 * have. So the head rides beside it instead: its own table, its own ordering
 * fact, fed from the same two inputs (the list answer and the stream delta) at
 * the seams where both are already in hand on the main thread. The record
 * table never sees `head`, and its rules are untouched.
 *
 * ## A head is never cleared by a row without one
 *
 * `head` is optional AND nullable on the wire, and neither absence retracts a
 * held stamp. Absent is an older peer's row (`@1.0`/`@1.1` list, `@1.0`-`@1.2`
 * stream) that never carried the field; `null` is a host's "no publication to
 * point at". A held stamp proves a publication happened, and a publication is
 * never undone short of the chat's removal - which arrives as a `remove` frame
 * and drops the entry outright. Letting a metadata-only row clear the head
 * would send the tile back to its unkeyed read every time a rename raced a
 * publication, for nothing.
 */

/** ASCII unit separator - a control character no id can contain. */
const KEY_SEPARATOR = "\u001f";

/**
 * The record identity, `(ownerUserId, chatId)`, as one map key.
 *
 * `chatId` alone is host-minted and not unique under a task, so a key on it
 * would let a collaborator's row evict the viewer's own same-id chat. The
 * separator is a control character no id can contain, which is also what makes
 * {@link dropChatRecordHeadsForChat}'s suffix test exact.
 */
export function chatRecordKey(ownerUserId: string, chatId: string): string {
  return `${ownerUserId}${KEY_SEPARATOR}${chatId}`;
}

/**
 * One row's contribution to the head table: the record identity and whatever
 * the row says about a publication.
 *
 * Structural rather than one of the two wire row types, because both feed this
 * plane - the list's `@1.2` row (which also carries `docResident`) and the
 * stream's `@1.3` row (which must not) - and the head plane cares about
 * neither difference.
 */
export interface ChatRecordHeadBearingRow {
  readonly ownerUserId: string;
  readonly chatId: string;
  readonly head?: ChatRecordHeadStamp | null;
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
 * gate that keeps a poll re-serving unchanged rows from publishing a new table
 * identity.
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

/**
 * The table after folding `rows` in, or the SAME table when nothing advanced.
 *
 * The ordering fact is `publishedAt` alone - server-monotonic, clamped inside
 * the CAS so it strictly rises under the cloud row's lock. `revision` orders
 * METADATA and says nothing about a publication, and `throughRecordSeq` is a
 * projection two forked histories both number, so neither may decide this.
 *
 * Returning the held table unchanged is what makes the 20s list poll free: an
 * answer that re-serves the same heads publishes no new identity, so nothing
 * keyed on a stamp re-renders. Unchanged entries keep their stamp OBJECT for
 * the same reason.
 */
export function applyChatRecordHeadRows(
  held: Readonly<Record<string, ChatRecordHeadStamp>>,
  rows: Iterable<ChatRecordHeadBearingRow>,
): Readonly<Record<string, ChatRecordHeadStamp>> {
  let next: Record<string, ChatRecordHeadStamp> | null = null;
  for (const row of rows) {
    const incoming = row.head ?? null;
    // Absent and `null` are both "this row states no publication", and neither
    // retracts a held stamp - see the module header.
    if (incoming === null) continue;
    const key = chatRecordKey(row.ownerUserId, row.chatId);
    const current = next ?? held;
    const existing = Object.hasOwn(current, key) ? current[key] : null;
    if (existing !== null && incoming.publishedAt <= existing.publishedAt) {
      continue;
    }
    next ??= { ...held };
    next[key] = incoming;
  }
  return next ?? held;
}

/**
 * The table with every entry for `chatId` dropped, or the SAME table when it
 * held none.
 *
 * Keyed by `chatId` ALONE, matching how a `remove` frame is addressed: it
 * carries `(epicId, chatId, reason)` and no owner, so the frame is COARSER
 * than a record identity and retracts every retained entry with that id - the
 * same coarseness, and the same bound, as the record table's own retraction
 * map. The suffix test is exact because {@link KEY_SEPARATOR} is a control
 * character no id can contain.
 */
export function dropChatRecordHeadsForChat(
  held: Readonly<Record<string, ChatRecordHeadStamp>>,
  chatId: string,
): Readonly<Record<string, ChatRecordHeadStamp>> {
  const suffix = `${KEY_SEPARATOR}${chatId}`;
  const surviving = Object.keys(held).filter((key) => !key.endsWith(suffix));
  if (surviving.length === Object.keys(held).length) return held;
  if (surviving.length === 0) return EMPTY_CHAT_RECORD_HEADS;
  const next: Record<string, ChatRecordHeadStamp> = {};
  for (const key of surviving) next[key] = held[key];
  return next;
}
