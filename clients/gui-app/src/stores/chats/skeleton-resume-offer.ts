import type { ChatSkeletonChunk } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  buildSkeletonResumeOffer,
  type ChatSkeletonResume,
  type SkeletonResumeOffer,
} from "@traycer/protocol/persistence/chat-transcript/skeleton-resume";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { CachedSkeletonResume } from "@/stores/chats/skeleton-resume-cache";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";

/**
 * One chat's side of skeleton resume (`chat.subscribe@1.18`, see
 * `skeleton-resume.ts` in the protocol): what it offered the host on the last
 * subscribe, and the rewrite of the host's answer back into the stream it
 * stands for.
 *
 * ## The rewrite
 *
 * A resumed stream's first chunk starts at `retainedRows` and says the rows
 * below it are the ones the offer described. Rather than teach the window a
 * second kind of stream, {@link SkeletonResumeOfferHolder.resolveChunk} turns
 * that chunk into the chunk a full stream would have sent - the offered
 * entries followed by the chunk's own - and the window applies it through the
 * one path every skeleton already takes. Its coverage, completeness, span and
 * stale-carry reconciliation therefore see exactly what they would have seen
 * had the host streamed the rows, which is the whole claim resume makes: a
 * withheld entry equal to the one held is the same as a sent one.
 *
 * The offered entries are kept rather than read back out of the window because
 * the window may no longer hold them: a snapshot at a different epoch - a host
 * that restarted onto a fresh publication - clears the skeleton before the
 * first chunk arrives, and the rows the host verified are still the ones this
 * client described.
 *
 * ## When a resumed chunk is refused
 *
 * A `retainedRows` this client cannot honour - no offer on this connection,
 * more rows than it offered, or a chunk that does not start where it says -
 * is applied UNCHANGED. The stream then has a hole below its first chunk, so
 * its final chunk reads as lost chunks: the window voids its index and asks
 * for a resnapshot, which the host answers with a full stream. That is the
 * recovery a dropped chunk already takes, and nothing here invents another.
 */
export interface SkeletonResumeOfferHolder {
  /**
   * The claim for the subscribe about to be sent, or `null` to claim nothing.
   * Remembers what it offered, replacing any earlier offer: the answer comes
   * on the connection this subscribe opens, and on no other.
   *
   * The window is asked first. `cached` is asked only when the window has
   * nothing to offer - a chat re-opened after its session was closed - and
   * is the skeleton that session left behind (`skeleton-resume-cache.ts`).
   */
  offer(
    window: TranscriptWindow | null,
    cached: () => CachedSkeletonResume | null,
  ): ChatSkeletonResume | null;
  /**
   * The chunk to apply for one received from the host. Every chunk spends the
   * offer: only a stream's FIRST chunk can answer it.
   */
  resolveChunk(
    chunk: ChatSkeletonChunk,
    retainedRows: number | undefined,
  ): ChatSkeletonChunk;
}

/** What was offered, with the described entries read only if a host resumes. */
type PendingOffer = {
  readonly claim: ChatSkeletonResume;
  readonly readEntries: () => readonly RowSkeletonEntry[];
};

export function createSkeletonResumeOfferHolder(): SkeletonResumeOfferHolder {
  let pending: PendingOffer | null = null;
  // The last offer BUILT, by the skeleton it was built from. A window's
  // skeleton array is replaced whenever it changes, so identity is a sound
  // key, and a reconnect burst re-reads the offer without re-hashing a
  // skeleton that did not move.
  let memo: {
    readonly skeleton: TranscriptWindow["skeleton"];
    readonly rowCount: number;
    readonly offer: SkeletonResumeOffer | null;
  } | null = null;

  const offerFor = (window: TranscriptWindow): SkeletonResumeOffer | null => {
    // Only a skeleton this client knows is whole and current is worth
    // describing: a partial or invalidated one would claim rows the window
    // itself does not trust.
    if (!window.skeletonComplete || window.invalidated) return null;
    if (
      memo !== null &&
      memo.skeleton === window.skeleton &&
      memo.rowCount === window.rowCount
    ) {
      return memo.offer;
    }
    const offer = buildSkeletonResumeOffer(window.skeleton, window.rowCount);
    memo = { skeleton: window.skeleton, rowCount: window.rowCount, offer };
    return offer;
  };

  return {
    offer: (window, cached) => {
      const fromWindow = window === null ? null : offerFor(window);
      if (fromWindow !== null) {
        pending = {
          claim: fromWindow.claim,
          readEntries: () => fromWindow.entries,
        };
      } else {
        pending = cached();
      }
      return pending?.claim ?? null;
    },
    resolveChunk: (chunk, retainedRows) => {
      const offer = pending;
      pending = null;
      if (retainedRows === undefined || offer === null) return chunk;
      const entries = offer.readEntries();
      if (
        retainedRows > entries.length ||
        retainedRows % offer.claim.blockSize !== 0 ||
        chunk.fromOrdinal !== retainedRows
      ) {
        return chunk;
      }
      return {
        epoch: chunk.epoch,
        fromOrdinal: 0,
        entries: [...entries.slice(0, retainedRows), ...chunk.entries],
        isFinal: chunk.isFinal,
      };
    },
  };
}
