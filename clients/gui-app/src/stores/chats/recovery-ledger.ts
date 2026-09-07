import type { OrdinalRange } from "@/stores/chats/transcript-window";

/**
 * One ledger for what was asked and what may be trusted; never a third parallel answer.
 * A rebuild boundary subsumes open range entries; an aux-only rebroadcast supersedes nothing.
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
  /** Record a framed range request. */
  readonly openRange: (input: {
    readonly requestId: string;
    readonly epoch: number;
    readonly range: OrdinalRange;
  }) => { readonly capEvicted: readonly RangeEntry[] };
  /**
   * Mark ordinals invalidated while requests were outstanding - the existing supersede semantics,
   * verbatim: `"all"` (or a newer epoch) voids every entry's answer; same-epoch ordinal
   */
  readonly markRangesSuperseded: (input: {
    readonly epoch: number;
    readonly invalidated: readonly number[] | "all";
  }) => void;
  /** Should this answer be thrown away rather than seated? */
  readonly rangeAnswerIsStale: (answer: RangeAnswer) => boolean;
  /** The answer was accepted and seated - the obligation is discharged. */
  readonly closeRange: (requestId: string) => void;
  /** Whether any range obligation is open - the streaming-echo gate's read. */
  readonly hasOpenRanges: () => boolean;
  /**
   * An accepted authority boundary (rebuild announcement / rebase / voided index - the slot-release
   * predicate).
   */
  readonly authorityBoundary: (input: {
    readonly epoch: number;
    readonly announcesRebuild: boolean;
  }) => void;
  /** `skeletonComplete` became true for this epoch - the rebuild delivered. */
  readonly skeletonCompleted: (epoch: number) => void;
  /** Dedup + obligation for one resnapshot ask. */
  readonly openResnapshot: (epoch: number) => boolean;
  /**
   * The bounded wait expired: release the dedup so recovery can re-ask, while the caller re-arms the
   * completion watchdog (whose budget is what makes the retry loop finite).
   */
  readonly releaseResnapshot: (epoch: number) => void;
  /**
   * Whether an open resnapshot entry exists for this epoch - the timer's guard, so a deadline armed
   * for an obligation that has since closed or been replaced acts on nothing.
   */
  readonly hasOpenResnapshot: (epoch: number) => boolean;
  /**
   * A chunk of `generation` was OBSERVED - healthy path and recovery path alike, nonzero `fromIndex`
   * included ("observed" because the generation's actual first chunk may itself be the dropped one).
   */
  readonly observeSummaryChunk: (generation: number) => void;
  /** The generation's final chunk landed with contiguous coverage. */
  readonly closeSummaryAssembly: (generation: number) => void;
  /**
   * The rebuild boundary for the summary stream (`indexRevision === null`) or a line downgrade: the
   * counter may restart, so the retained assembly vouches for nothing and the next chunk must read
   */
  readonly resetSummaryStream: () => void;
  /**
   * The one derivation of both published trust flags. Deriving one and
   * hand-setting the other is the two-answers drift this ledger removes.
   */
  readonly summaryTrust: () => SummaryTrust;
  /** Watchdog budget exhausted for this epoch: recovery entries move to the abandoned terminal. */
  readonly abandonEpochRecovery: (epoch: number) => void;
  /**
   * The windowed line is gone (legacy downgrade / dispose): every entry describes coordinates
   * nothing can read. Drops everything, summary trust included.
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
        // EXCLUSIVE at the top: `entry.range` is the planner's OrdinalRange, and the wire sends `toOrdinal
        // - 1`, so the highest servable ordinal is `toOrdinal - 1`.
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
      // The boundary is what the resnapshot asked for - its entries close, whichever epoch asked (an
      // epoch change replaces old-epoch entries by definition, and a same-epoch rebuild answers the same
      dropRecoveries((entry) => entry.scope !== "resnapshot");
      // Recovery entries from other epochs describe streams that can no longer arrive, and a same-epoch
      // ABANDONED entry's obligation is re-carried by whatever this boundary opens - keeping it would
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
