import type { RecordListRevision } from "@traycer/protocol/host/epic/record-list-revision";

/**
 * The seam between the record-delta STREAM and the record-list POLLS.
 *
 * ## What it carries, and why it is not the deltas themselves
 *
 * `host.chatRecords.subscribe@1.4` stamps every record delta with the list
 * revision the write that produced it left behind. The rows in that delta are
 * routed by `ChatRecordsStreamMount` straight into the epic session's record
 * tables and need nothing from here. The STAMP has a different destination:
 * the two record-list polls (`epic.listChatRecords`, `epic.listTuiAgents`),
 * each of which holds the last revision its own answers reported and sends it
 * back as `knownRevision` so the host can answer "nothing you hold has
 * changed" in a few hundred bytes. A client that applies a delta and does not
 * advance that held revision asks for - and is served - a full snapshot on the
 * very next tick, which is the cost stage 2 exists to remove.
 *
 * So this announces one fact per applied delta and nothing else.
 *
 * ## Why the mount announces and the hooks decide, rather than the reverse
 *
 * The comparison needs three things the mount does not have and should not
 * grow: the held stamp (private to each list hook's `useRecordListStamp`, and
 * deliberately so - it is held only for an answer a store applied), the
 * viewer/store-generation identity that stamp is keyed on, and a way to make
 * the list re-read on a gap. That last one is decisive: the query key is
 * `["host", hostId, method, params, viewer, generation]`, and `params` is the
 * object `invalidateEpicChatRecords` documents as the thing a caller "would
 * have to reconstruct exactly to hit the slot" - so from the mount the only
 * reachable invalidation is the method-scoped one, which would refetch EVERY
 * other open epic's list on every gap. From the hook it is `query.refetch()`,
 * with no key to reconstruct at all.
 *
 * ## Per epic, not per plane
 *
 * Both list methods answer with the SAME per-(viewer, epic) composite
 * revision, so a CHAT delta moves the terminal-agent list's revision too even
 * though no terminal-agent row changed. Both planes therefore subscribe to one
 * per-epic channel and each advances its own held stamp; a per-plane channel
 * would leave the other plane a revision behind after every write and put
 * stage 1's snapshot-per-change back for half the traffic.
 *
 * ## Not a store, and not reactive
 *
 * Listeners are called SYNCHRONOUSLY inside the mount's delta handler, in the
 * same tick the rows were dispatched to the store, because the thing they
 * mutate is a ref read at the next dispatch - not rendered state. Nothing here
 * re-renders anything.
 */
type RecordListDeltaStampListener = (listRevision: RecordListRevision) => void;

const listenersByEpicId = new Map<string, Set<RecordListDeltaStampListener>>();

/**
 * Listen for the list revisions this client's applied deltas carried for one
 * epic. Returns the unsubscribe.
 *
 * The entry is dropped when its last listener leaves, so the map is bounded by
 * the epics currently mounted rather than by the epics visited.
 */
export function subscribeRecordListDeltaStamps(
  epicId: string,
  listener: RecordListDeltaStampListener,
): () => void {
  const existing = listenersByEpicId.get(epicId);
  const listeners = existing ?? new Set<RecordListDeltaStampListener>();
  if (existing === undefined) listenersByEpicId.set(epicId, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByEpicId.delete(epicId);
  };
}

/**
 * Announce the stamp an APPLIED delta carried.
 *
 * "Applied" is the whole contract, and it is the caller's to keep: a stamp
 * announced for a delta whose rows never reached a store would advance a held
 * revision past rows the store does not have, and the host would then answer
 * `unchanged` about a change this client missed - with equality-only
 * comparison leaving nothing to detect it with. The mount therefore announces
 * after routing, and only for a delta it actually routed.
 *
 * A delta from a host below `@1.4` carries no stamp; the mount has nothing to
 * announce and calls nothing, which leaves that host's clients on stage-1
 * behaviour (a snapshot per change) exactly as before.
 *
 * The listener set is copied before iteration so a listener that unsubscribes
 * during the notification - an epic torn down by the very delta being
 * announced - cannot mutate the set underneath the loop.
 */
export function publishRecordListDeltaStamp(
  epicId: string,
  listRevision: RecordListRevision,
): void {
  const listeners = listenersByEpicId.get(epicId);
  if (listeners === undefined) return;
  for (const listener of [...listeners]) listener(listRevision);
}
