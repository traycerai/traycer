import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import { queuedPreparationFailureFromEventMetadata } from "@traycer/protocol/persistence/epic/chat-events";
import type { ChatQueueState } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  currentDraftBlobOwnerId,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import { repairQueuedPromptBlobs } from "@/lib/drafts/queued-prompt-blob-repair";
/**
 * What this arm reads of the queue, and nothing more: whether it is paused, and
 * which items are still in it.
 *
 * Structural rather than `ChatQueueState` itself - the real state is assignable
 * to it - so the arm cannot quietly start depending on a queued item's message,
 * sender or settings, and so a test can state the two facts that matter without
 * standing up a full `ChatQueuedItem` it would then have to keep in sync.
 */
export interface QueueRepairView {
  readonly status: ChatQueueState["status"];
  readonly items: ReadonlyArray<{ readonly queueItemId: string }>;
}

/**
 * TWO LEDGERS, BECAUSE THERE ARE TWO DIFFERENT RE-DELIVERIES and they warrant
 * different answers.
 *
 * Both are MODULE-LEVEL, and that is the point. The `send.failed` this arm keys
 * on is a DURABLE chat event: written by `failQueuedPromptPreparation`,
 * broadcast live, then replayed inside every subscribe snapshot - so it comes
 * back on every reconnect, every resnapshot, and every remount of the tile. A
 * ledger held in a ref would be cleared by exactly the remount that re-delivers
 * the event, which is the one case it exists to survive. Renderer-lifetime,
 * like `confirmedBlobsByHost` next door.
 *
 * `handledEvents` - the SAME event seen again (`eventId` + `queueItemId`). That
 * is a replay of something already answered, so it is silent: no upload, no
 * resume, and no toast either, or every reconnect would re-narrate a failure
 * the user has already been told about.
 *
 * `attemptedItems` - the same ITEM failing again under a NEW event id. A
 * per-event ledger alone does not bound this and must not be mistaken for a
 * bound: each queued drain appends its own `send.failed` row with a fresh
 * `eventId`, so repair → resume → drain → new event → repair is an unbounded
 * upload/resume loop, with every iteration passing a per-event guard honestly.
 * ONE repair that RESUMED per item, therefore, after which a further failure
 * for that item leaves the queue paused and says so. A host that still cannot
 * find the bytes ends in a visible paused state the user can act on rather than
 * in a loop they cannot see.
 *
 * IT IS THE RESUME THAT IS SPENT, NOT THE ATTEMPT, and the asymmetry is the
 * point: only a resume hands the drain another turn, so only a resume can
 * produce the next event. A pass that ended "no local bytes" ends the chain by
 * itself, and holding the item's one attempt against it would cost the user the
 * repair they are owed once the bytes ARE local again - a re-paste into the
 * edited row and a manual resume would draw a toast where a repair was
 * possible. So the entry is taken before the pass (it doubles as the in-flight
 * guard) and released on any outcome that did not resume.
 *
 * `handledEvents` keeps its entry unconditionally: that event has been answered
 * however it turned out, and re-answering it is the replay this ledger exists
 * to swallow.
 */
const handledEvents = new Set<string>();
const attemptedItems = new Set<string>();

export function resetQueuedPromptBlobRepairForTests(): void {
  handledEvents.clear();
  attemptedItems.clear();
}

function repairKey(eventId: string, queueItemId: string): string {
  return `${eventId}\0${queueItemId}`;
}

/**
 * THE CLIENT ARM for a queued prompt whose drain could not find its attachment
 * bytes.
 *
 * The host's dangling-hash chokepoint on a LIVE send rejects the frame and
 * hands the prompt back to the composer, where the refused-content memo
 * retraction already runs. The QUEUED drain has no such door: it writes a
 * durable `send.failed` row and pauses the queue with the item retained, so
 * nothing reaches the composer and a Retry re-drains host-side with no
 * re-upload - the same bytes missing, the same refusal. This closes that gap
 * from the renderer: forget the memo for the hashes the host named, put them
 * back, and resume.
 *
 * BRANCH ON THE PARSE, NEVER ON THE CODE. `send.failed` rows carrying a
 * preparation code are a WIDER set than the actionable ones: a refusal that
 * REMOVED the item from an unpaused queue, and a speculative preparation on a
 * synthetic item that was never queued (the headless landing probe
 * `"initial:" + messageId`, the received-agent interrupt restart, Steer Now's
 * temporary item) both look identical in the raw bag. The host gates the bag on
 * queue membership at the append, so all of those parse to `null` - which is
 * exactly why this reads `failure.code` and never `event.metadata.code`. The
 * shortcut would fire a re-upload for a `queueItemId` that does not exist and
 * call `resumeQueue` on a running queue.
 *
 * Three conditions beyond the code, and each rules out a real re-delivery:
 *
 *  - the named item is still IN the queue (a cancelled item must not be
 *    resumed into),
 *  - the queue is PAUSED (resuming a running queue is not a no-op), and
 *  - this exact (event, item) pair has not been attempted (the snapshot
 *    replay), and
 *  - this ITEM has not already had its one repair (the drain loop - see
 *    `attemptedItems`; the per-event guard does not bound this, because each
 *    drain mints a new `eventId`).
 *
 * The first two are NOT made redundant by the host's append-time gate, and the
 * difference is the whole reason this arm has them: that gate is a fact about
 * the moment the row was WRITTEN, while these are facts about NOW. The carrier
 * is durable and replayed, so an event whose item was genuinely queued and
 * paused when it was appended can reach this arm long afterwards - on a
 * reconnect, after the user has cancelled that row or resumed the queue by
 * hand. A non-null parse is a licence to act on the row as it was, not
 * evidence about the queue in front of the user.
 *
 * A RESIDUAL, and it is behaviour rather than a gap to close. The bag is the
 * TRIGGER and the enrichment; the queue state is the precondition. The durable
 * row replays in the windowed snapshot's transcript TAIL, so a just-failed
 * drain is always visible - but `emitOversizedWindowedSnapshot` sheds tail rows
 * on a very large transcript, so an OLD failure's row can age out. The queue
 * state rides the snapshot whole, so "paused with the item retained" always
 * survives; only the hash list can be lost. When the queue is paused with a
 * prompt at the head and no bag is visible, this arm does nothing - deliberately,
 * because a user's own pause looks exactly the same from here, and resuming on
 * that guess would start a turn nobody asked for. The row stays editable in the
 * dock, and editing or re-sending it is the recovery.
 *
 * `resumeQueue` is queue-wide by construction - the client frame carries
 * `ownerActionFrameFields` and no `queueItemId` - which is correct here only
 * because the host pauses the WHOLE queue on a preparation failure. If that
 * ever becomes a per-item pause, this call is the line that has to change, and
 * there is no per-item verb on the wire today to change it to.
 */
export function useQueuedPromptBlobRepair(input: {
  readonly hostId: string;
  readonly client: DraftBlobClient | null;
  readonly events: ReadonlyArray<ChatEvent>;
  readonly queue: QueueRepairView;
  /**
   * Whether this viewer may act on this chat at all - the tile's own
   * connected + owner-permission + profile verdict. A read-only collaborator
   * must not repair: they usually lack the bytes entirely (so they would see
   * "Couldn't attach an image" for a prompt they never sent), and if they DO
   * hold the hash they would upload it into THEIR staging tier, which the
   * host's author-tier drain will not read, and then attempt an owner action
   * with it.
   */
  readonly canAct: boolean;
  readonly resumeQueue: () => string | null;
}): void {
  const { hostId, client, events, queue, canAct, resumeQueue } = input;
  /**
   * THE QUEUE AS IT IS NOW, not as it was when the pass started.
   *
   * `resumeQueue` is queue-WIDE, so a continuation that resumes on the strength
   * of the props its effect closed over can resume a queue that is no longer
   * the one it checked: cancel the failed item while its put is in flight and
   * the fulfilment resumes whatever ELSE is queued behind it; resume by hand
   * mid-upload and the fulfilment resumes a second time. The pre-flight checks
   * cannot cover this - they are facts about a moment that has passed by the
   * time the upload settles.
   */
  const queueRef = useRef<QueueRepairView>(queue);
  /**
   * WHICH PAUSED EPISODE we are in, bumped every time the queue leaves
   * `"paused"`.
   *
   * Re-reading status and item presence at fulfilment is not enough on its own,
   * because both can come back: resume by hand, then pause again while the
   * upload is still in flight, and the live queue reads paused with the same
   * item present - identical to the state the pass started in. Resuming then
   * would override the user's NEWER pause. `QueueRepairView` carries no
   * revision that would show the transition, so the arm counts it.
   */
  const pausedEpisodeRef = useRef(0);
  const previousStatusRef = useRef<QueueRepairView["status"]>(queue.status);
  useEffect(() => {
    if (previousStatusRef.current === "paused" && queue.status !== "paused") {
      pausedEpisodeRef.current += 1;
    }
    previousStatusRef.current = queue.status;
    queueRef.current = queue;
  }, [queue]);
  /** The tile's live eligibility, for the re-check after the await. */
  const canActRef = useRef(canAct);
  useEffect(() => {
    canActRef.current = canAct;
  }, [canAct]);
  /**
   * Whether this tile is still mounted. An unmounted arm has no business
   * resuming anyone's queue: the user closed the tab, and `resumeQueue` reaches
   * the session store regardless.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (client === null) return;
    // ADMISSION, and it returns before ANY ledger is claimed on purpose. A
    // viewer who cannot act must leave no trace: a mount that is read-only, or
    // merely not actionable yet (reconnecting), would otherwise consume this
    // event's ledger entry and the owner's later ready snapshot would find it
    // already answered and never repair.
    if (!canAct) return;
    // Checked once, above the scan: the queue's status is a property of the
    // queue, not of any one failed item.
    if (queue.status !== "paused") return;
    for (const event of events) {
      if (event.type !== "send.failed") continue;
      const failure = queuedPreparationFailureFromEventMetadata(event.metadata);
      // `null` is an older `send.failed`, or one of the other preparation
      // codes that ride this same bag. Not an error - just not ours.
      if (failure === null) continue;
      if (failure.code !== "MISSING_ATTACHMENT_BYTES") continue;
      const stillQueued = queue.items.some(
        (item) => item.queueItemId === failure.queueItemId,
      );
      if (!stillQueued) continue;
      const key = repairKey(event.eventId, failure.queueItemId);
      // A replay of an event already answered. Silent by design - see
      // `handledEvents` above.
      if (handledEvents.has(key)) continue;
      // BOTH CLAIMED BEFORE THE AWAIT, not after it. The pass is asynchronous,
      // and a second delivery - a reconnect landing mid-upload - would
      // otherwise pass these guards while the first pass was still in flight
      // and start a second upload of the same bytes.
      handledEvents.add(key);
      if (attemptedItems.has(failure.queueItemId)) {
        // This item has already had a repair that RESUMED, or has one in
        // flight. Either way, re-uploading would be the same pass with the same
        // result and resuming would hand the drain another turn to fail - the
        // loop. Stop here, with the queue paused and the row editable, and say
        // so.
        toast.error("Couldn't attach an image");
        continue;
      }
      // Claimed BEFORE the await and released below on any outcome that did not
      // resume. The claim has to be taken here rather than at the verdict
      // because it is doing two jobs: it is the loop bound, and it is also the
      // in-flight guard - two DIFFERENT events for one item can arrive in a
      // single snapshot, and without a claim both would pass this check while
      // the first pass was still uploading and both would resume.
      attemptedItems.add(failure.queueItemId);
      // Only an outcome that RESUMED can loop: a resume hands the drain another
      // turn, which appends another `send.failed`. An outcome that did not
      // resume ends the chain by itself, so holding the item's one attempt
      // against it would cost the user the repair they are owed after they make
      // the bytes local again (a re-paste into the edited row, then a manual
      // resume) - they would get a toast where a repair was possible.
      const releaseAttempt = (): void => {
        attemptedItems.delete(failure.queueItemId);
      };
      // The paused episode this pass belongs to. A resume that lands in a
      // LATER episode is answering a pause the user has since replaced.
      const episodeAtStart = pausedEpisodeRef.current;
      void repairQueuedPromptBlobs({
        hostId,
        client,
        missingHashes: failure.missingHashes,
        // Read HERE rather than captured in the effect's closure: the
        // confirmations this repair records are keyed by account, and the
        // account can change between the refusal landing and this pass running.
        // Recording under the identity that is live at the upload is the only
        // reading that matches what the send gate will later ask.
        ownerUserId: currentDraftBlobOwnerId(),
      }).then(
        (verdict) => {
          if (verdict === "repaired") {
            // RE-CHECKED AT FULFILMENT against the live queue, because the
            // world moved while the bytes were uploading and `resumeQueue` is
            // queue-wide. Silent when it has: the user cancelled the row or
            // resumed by hand, and neither is a failure to narrate. The attempt
            // goes back because nothing resumed, so nothing can loop.
            const live = queueRef.current;
            const stillThere = live.items.some(
              (item) => item.queueItemId === failure.queueItemId,
            );
            if (
              !mountedRef.current ||
              !canActRef.current ||
              // A resume→pause round trip lands back on `"paused"` with the
              // same item, so status and presence alone cannot see it. The
              // episode counter can.
              pausedEpisodeRef.current !== episodeAtStart ||
              live.status !== "paused" ||
              !stillThere
            ) {
              releaseAttempt();
              return;
            }
            // The attempt is spent only on a real DISPATCH. `resumeQueue`
            // answers `null` when it could not send - disconnected, or no
            // session - and nothing resumed then, so nothing can loop and the
            // item keeps its attempt for a later event.
            if (resumeQueue() === null) releaseAttempt();
            return;
          }
          // No local bytes for at least one hash. Leave the queue paused with
          // the row untouched - it stays editable in the dock, which is the
          // only way forward - and say so without naming a hash or an id. No
          // resume was issued, so no drain follows and this item's attempt goes
          // back.
          releaseAttempt();
          toast.error("Couldn't attach an image");
        },
        () => {
          // The upload or the byte read threw. Same reasoning as the verdict
          // above: nothing resumed, so nothing can loop, so the attempt is not
          // spent.
          releaseAttempt();
          toast.error("Couldn't attach an image");
        },
      );
    }
    // `canAct` IS A DEPENDENCY, not just a read. Eligibility arrives late in
    // the ordinary case - profile, access role and connection all settle after
    // the first paint - and the failure is already in the snapshot by then. In
    // the real tile `resumeQueue` is memoized over the store handle and a
    // reconnect can deliver a byte-identical `events`/`queue`, so with `canAct`
    // out of this list nothing re-runs the scan and the repair never starts at
    // all. An unmount/remount hides that, which is exactly why the pin for this
    // flips it on the SAME mount.
  }, [canAct, client, events, hostId, queue, resumeQueue]);
}
