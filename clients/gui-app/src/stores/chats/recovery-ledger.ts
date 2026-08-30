import type { OrdinalRange } from "@/stores/chats/transcript-window";

/**
 * # One recovery ledger: what was asked, what is owed, what may be trusted
 *
 * This ledger subsumes the two latches that used to answer recovery questions
 * in parallel - `outstandingHydrationRequests` and
 * `resnapshotRequestedForEpoch` - and carries the summary-assembly trust
 * state beside them, so "is this scope still owed something" is answered in
 * exactly one place. Never add a third parallel answer to the same question:
 * both prior loss-recovery defects were two records of one fact drifting.
 *
 * ## Entries, not flags
 *
 * An entry is an OBLIGATION: something was asked of the host, or announced by
 * it, and until the close condition arrives the scope it names is untrusted.
 * Entries are `open` until closed (removed), replaced (a new entry carries
 * the obligation), or `abandoned` - the honest terminal when the watchdog
 * budget is exhausted. Abandoned is rendered-but-degraded via the existing
 * degraded surfaces, never permanent untrust; epoch stagnation is real
 * (append-only chats live at epoch 0 forever), so a per-epoch budget is not a
 * global bound and abandonment must be representable.
 *
 * ## The rebuild boundary subsumes, it does not clear
 *
 * An accepted authority boundary (a rebuild announcement, a rebase, or a
 * voided index - the same three cases the dedup slot releases on) replaces
 * every open range entry at once: their pre-boundary answers must never seat,
 * because a pre-boundary-framed answer is indistinguishable from a
 * post-boundary slice of current state (the host slices at answer time). The
 * obligation is not lost - a rebuild announcement opens the
 * `skeleton-completion` entry whose close hands planning back to the fresh
 * skeleton, and the planner re-derives every still-required gap continuously
 * (it is NOT gated on the open entry; gating it strands the delivered prefix
 * behind a close that never comes when the stream stalls into abandonment).
 * An aux-only rebroadcast is none of the three cases and supersedes nothing:
 * frequent aux frames whose drip discards every slow answer in turn is the
 * documented starvation this distinction exists to prevent.
 */

export const MAX_OUTSTANDING_HYDRATION_REQUESTS = 8;

interface RangeEntry {
  readonly scope: "range";
  readonly requestId: string;
  readonly epoch: number;
  readonly range: OrdinalRange;
  /**
   * Ordinals whose body a later frame invalidated while the request was
   * outstanding, or `"all"`. Clipped to the request's extent by the caller.
   */
  readonly superseded: ReadonlySet<number> | "all";
}

interface ResnapshotEntry {
  readonly scope: "resnapshot";
  readonly epoch: number;
  state: "open" | "abandoned";
}

interface SkeletonCompletionEntry {
  readonly scope: "skeleton-completion";
  readonly epoch: number;
  state: "open" | "abandoned";
}

interface SummaryAssemblyEntry {
  readonly scope: "summary-assembly";
  readonly generation: number;
  state: "open" | "closed" | "abandoned";
}

export interface SummaryTrust {
  /** An assembly exists for the current stream - the panel has a delivery. */
  readonly started: boolean;
  /** That assembly reached its final chunk - the published set is vouched. */
  readonly seated: boolean;
}

export interface RangeAnswer {
  readonly requestId: string;
  readonly fromOrdinal: number;
  readonly servedCount: number;
}

export interface RecoveryLedger {
  /**
   * Record a framed range request. When the cap binds, the OLDEST entries are
   * evicted and returned so the caller can supersede-and-replan them into one
   * NEW wider request that carries their obligation - cap-eviction-as-silent-
   * trust is outlawed; an unrecorded response is discarded, never seated.
   */
  readonly openRange: (input: {
    readonly requestId: string;
    readonly epoch: number;
    readonly range: OrdinalRange;
  }) => { readonly capEvicted: readonly RangeEntry[] };
  /**
   * Mark ordinals invalidated while requests were outstanding - the existing
   * supersede semantics, verbatim: `"all"` (or a newer epoch) voids every
   * entry's answer; same-epoch ordinal invalidations accumulate per entry.
   */
  readonly markRangesSuperseded: (input: {
    readonly epoch: number;
    readonly invalidated: readonly number[] | "all";
  }) => void;
  /**
   * Should this answer be thrown away rather than seated? Untracked answers
   * are discarded - absence means a boundary, a downgrade or the cap dropped
   * the record, which is precisely the state in which nothing recorded what
   * happened to those ordinals while the answer was in the air.
   */
  readonly rangeAnswerIsStale: (answer: RangeAnswer) => boolean;
  /** The answer was accepted and seated - the obligation is discharged. */
  readonly closeRange: (requestId: string) => void;
  /** Whether any range obligation is open - the streaming-echo gate's read. */
  readonly hasOpenRanges: () => boolean;
  /**
   * An accepted authority boundary (rebuild announcement / rebase / voided
   * index - the slot-release predicate). Replaces EVERY open range entry;
   * closes the epoch's resnapshot entries (the boundary is what they asked
   * for); when the boundary ANNOUNCES a rebuild, opens
   * `skeleton-completion@epoch` to carry the subsumed obligations to a close
   * that is guaranteed within the watchdog budget.
   */
  readonly authorityBoundary: (input: {
    readonly epoch: number;
    readonly announcesRebuild: boolean;
  }) => void;
  /** `skeletonComplete` became true for this epoch - the rebuild delivered. */
  readonly skeletonCompleted: (epoch: number) => void;
  /**
   * Dedup + obligation for one resnapshot ask. `false` means an entry is
   * already open for this epoch and the send must be suppressed - the pending
   * answer repairs whatever prompted the re-ask, and re-sending per prompt is
   * the request loop this store already shipped once.
   */
  readonly openResnapshot: (epoch: number) => boolean;
  /**
   * The bounded wait expired: release the dedup so recovery can re-ask, while
   * the caller re-arms the completion watchdog (whose budget is what makes
   * the retry loop finite).
   */
  readonly releaseResnapshot: (epoch: number) => void;
  /**
   * Whether an open resnapshot entry exists for this epoch - the timer's
   * guard, so a deadline armed for an obligation that has since closed or
   * been replaced acts on nothing.
   */
  readonly hasOpenResnapshot: (epoch: number) => boolean;
  /**
   * A chunk of `generation` was OBSERVED - healthy path and recovery path
   * alike, nonzero `fromIndex` included ("observed" because the generation's
   * actual first chunk may itself be the dropped one). A new generation's
   * first observed chunk replaces the previous generation's entry - entries
   * never accumulate, and a dropped final chunk for gen N cannot hold the
   * seated flag hostage once gen N+1 arrives. A non-final chunk of the
   * current generation RE-OPENS a closed entry (un-seats).
   */
  readonly observeSummaryChunk: (generation: number) => void;
  /** The generation's final chunk landed with contiguous coverage. */
  readonly closeSummaryAssembly: (generation: number) => void;
  /**
   * The rebuild boundary for the summary stream (`indexRevision === null`) or
   * a line downgrade: the counter may restart, so the retained assembly
   * vouches for nothing and the next chunk must read as a change.
   */
  readonly resetSummaryStream: () => void;
  /**
   * The one derivation of both published trust flags. Deriving one and
   * hand-setting the other is the two-answers drift this ledger removes.
   */
  readonly summaryTrust: () => SummaryTrust;
  /**
   * Watchdog budget exhausted for this epoch: recovery entries move to the
   * abandoned terminal. Range entries are untouched - their answers may still
   * arrive and seat; abandonment is about streams nothing will re-ask for.
   */
  readonly abandonEpochRecovery: (epoch: number) => void;
  /**
   * The windowed line is gone (legacy downgrade / dispose): every entry
   * describes coordinates nothing can read. Drops everything, summary trust
   * included.
   */
  readonly dropAll: () => void;
}

export function createRecoveryLedger(): RecoveryLedger {
  const ranges = new Map<string, RangeEntry>();
  const recoveries: (ResnapshotEntry | SkeletonCompletionEntry)[] = [];
  let summaryAssembly: SummaryAssemblyEntry | null = null;

  const openRecovery = <Scope extends "resnapshot" | "skeleton-completion">(
    scope: Scope,
    epoch: number,
  ): void => {
    const existing = recoveries.find(
      (entry) =>
        entry.scope === scope &&
        entry.epoch === epoch &&
        entry.state === "open",
    );
    if (existing !== undefined) return;
    recoveries.push({ scope, epoch, state: "open" });
  };

  const dropRecoveries = (
    keep: (entry: ResnapshotEntry | SkeletonCompletionEntry) => boolean,
  ): void => {
    for (let index = recoveries.length - 1; index >= 0; index -= 1) {
      if (!keep(recoveries[index])) recoveries.splice(index, 1);
    }
  };

  return {
    openRange: (input) => {
      ranges.set(input.requestId, {
        scope: "range",
        requestId: input.requestId,
        epoch: input.epoch,
        range: input.range,
        superseded: new Set<number>(),
      });
      const capEvicted: RangeEntry[] = [];
      // Evict one MORE than the overflow so the caller's single replacement
      // request fits back under the cap without evicting again - the wider
      // request replaces the evicted obligations one-for-many, never chains.
      if (ranges.size > MAX_OUTSTANDING_HYDRATION_REQUESTS) {
        const evictCount = ranges.size - MAX_OUTSTANDING_HYDRATION_REQUESTS + 1;
        for (let index = 0; index < evictCount; index += 1) {
          // Map iterates in insertion order, so this is the oldest entry.
          const oldest = ranges.keys().next();
          if (oldest.done === true) break;
          const entry = ranges.get(oldest.value);
          ranges.delete(oldest.value);
          if (entry !== undefined) capEvicted.push(entry);
        }
      }
      return { capEvicted };
    },
    markRangesSuperseded: (input) => {
      for (const [requestId, entry] of ranges) {
        if (entry.superseded === "all") continue;
        if (input.invalidated === "all" || input.epoch > entry.epoch) {
          ranges.set(requestId, { ...entry, superseded: "all" });
          continue;
        }
        if (input.epoch !== entry.epoch) continue;
        // EXCLUSIVE at the top: `entry.range` is the planner's OrdinalRange,
        // and the wire sends `toOrdinal - 1`, so the highest servable ordinal
        // is `toOrdinal - 1`. A delta one row past the request must not
        // supersede it.
        const inside = input.invalidated.filter(
          (ordinal) =>
            ordinal >= entry.range.fromOrdinal &&
            ordinal < entry.range.toOrdinal,
        );
        if (inside.length === 0) continue;
        ranges.set(requestId, {
          ...entry,
          superseded: new Set([...entry.superseded, ...inside]),
        });
      }
    },
    rangeAnswerIsStale: (answer) => {
      const entry = ranges.get(answer.requestId);
      if (entry === undefined) return true;
      if (entry.superseded === "all") return true;
      const servedEnd = answer.fromOrdinal + answer.servedCount;
      for (const ordinal of entry.superseded) {
        if (ordinal >= answer.fromOrdinal && ordinal < servedEnd) return true;
      }
      return false;
    },
    closeRange: (requestId) => {
      ranges.delete(requestId);
    },
    hasOpenRanges: () => ranges.size > 0,
    authorityBoundary: (input) => {
      ranges.clear();
      // The boundary is what the resnapshot asked for - its entries close,
      // whichever epoch asked (an epoch change replaces old-epoch entries by
      // definition, and a same-epoch rebuild answers the same obligation).
      dropRecoveries((entry) => entry.scope !== "resnapshot");
      // Recovery entries from other epochs describe streams that can no
      // longer arrive, and a same-epoch ABANDONED entry's obligation is
      // re-carried by whatever this boundary opens - keeping it would let
      // rebuild-abandon cycles at a stagnant epoch accumulate residue for
      // the life of the session. The boundary's own epoch's OPEN entries
      // carry forward.
      dropRecoveries(
        (entry) => entry.epoch === input.epoch && entry.state === "open",
      );
      if (input.announcesRebuild) {
        openRecovery("skeleton-completion", input.epoch);
      }
    },
    skeletonCompleted: (epoch) => {
      dropRecoveries(
        (entry) =>
          !(
            entry.scope === "skeleton-completion" &&
            entry.epoch === epoch &&
            entry.state === "open"
          ),
      );
    },
    openResnapshot: (epoch) => {
      const alreadyOpen = recoveries.some(
        (entry) =>
          entry.scope === "resnapshot" &&
          entry.epoch === epoch &&
          entry.state === "open",
      );
      if (alreadyOpen) return false;
      openRecovery("resnapshot", epoch);
      return true;
    },
    releaseResnapshot: (epoch) => {
      dropRecoveries(
        (entry) =>
          !(
            entry.scope === "resnapshot" &&
            entry.epoch === epoch &&
            entry.state === "open"
          ),
      );
    },
    hasOpenResnapshot: (epoch) =>
      recoveries.some(
        (entry) =>
          entry.scope === "resnapshot" &&
          entry.epoch === epoch &&
          entry.state === "open",
      ),
    observeSummaryChunk: (generation) => {
      if (
        summaryAssembly !== null &&
        summaryAssembly.generation === generation
      ) {
        summaryAssembly.state = "open";
        return;
      }
      summaryAssembly = {
        scope: "summary-assembly",
        generation,
        state: "open",
      };
    },
    closeSummaryAssembly: (generation) => {
      if (summaryAssembly?.generation === generation) {
        summaryAssembly.state = "closed";
      }
    },
    resetSummaryStream: () => {
      summaryAssembly = null;
    },
    summaryTrust: () => ({
      started: summaryAssembly !== null,
      seated: summaryAssembly?.state === "closed",
    }),
    abandonEpochRecovery: (epoch) => {
      for (const entry of recoveries) {
        if (entry.epoch === epoch && entry.state === "open") {
          entry.state = "abandoned";
        }
      }
      if (summaryAssembly !== null && summaryAssembly.state === "open") {
        summaryAssembly.state = "abandoned";
      }
    },
    dropAll: () => {
      ranges.clear();
      recoveries.length = 0;
      summaryAssembly = null;
    },
  };
}
