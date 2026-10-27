import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  clampPlaceholderHeight,
  rawPlaceholderRowHeight,
  PLACEHOLDER_MAX_HEIGHT_PX,
  PLACEHOLDER_UNCALIBRATED_MAX_HEIGHT_PX,
  PLACEHOLDER_UNKNOWN_HEIGHT_PX,
} from "@/components/chat/chat-transcript-placeholder-height";

/**
 * # What the transcript has already measured
 *
 * A placeholder's job is to hold its row's place at roughly the right height.
 * `placeholderRowHeight` can only guess that from `byteLength`, and a guess is
 * wrong by whatever the difference is between bytes of serialized record and
 * pixels of rendered markdown - which varies by an order of magnitude between a
 * one-line reply and a folded turn full of tool cards. Every bit of that error
 * is paid as a visible jump when the body lands and the row resizes under the
 * reader.
 *
 * The list already knows the true answer for any row it has drawn: LegendList
 * reports it through `onItemSizeChanged`. This module remembers it, so the
 * error is paid at most once per row instead of on every visit.
 *
 * ## Two things it does, in order of confidence
 *
 * 1. **A row measured before is placed at exactly that height.** Scrolling back
 *    over history the window has evicted is the common case on a long chat -
 *    and it became the DOMINANT case once span-merge capping let eviction
 *    actually fire (`SPAN_MERGE_MAX_BYTES` in `transcript-window.ts`; before
 *    that the tail exemption swallowed everything a reader had visited, so
 *    nothing was ever re-placeholdered). For those rows there is no estimate
 *    and no jump at all: the placeholder is the size the body was.
 *
 * 2. **A row never seen is placed at a CALIBRATED estimate.** Rows that have
 *    been both estimated and measured say what the estimator's error actually
 *    is in this chat, at this width, for this kind of content. Pooling those
 *    into one scale factor per role and applying it to the byte estimate is a
 *    far better opening guess than the raw formula, and it needs no constant
 *    tuned against a transcript nobody has seen.
 *
 * ## Why the scale factor is pooled, and per role
 *
 * Pooled means `sum(measured) / sum(estimated)` rather than the mean of the
 * per-row ratios. A mean of ratios is dominated by short rows, where a 44px
 * floor against a 200-byte body produces a huge ratio that says nothing about
 * the long rows whose error the reader actually feels. The pooled form weights
 * each row by its size, which is the same thing as asking "how tall is this
 * whole stretch of transcript", which is the question the scrollbar is asking.
 *
 * Per role because the populations genuinely differ: a user row is plain text
 * and close to linear in its bytes, while an assistant row carries segments and
 * tool payloads whose serialized size runs far ahead of what is drawn - a
 * collapsed tool card is kilobytes of record and one line of pixels.
 *
 * ## The ceiling moves with the evidence
 *
 * A placeholder is capped so one pathological row cannot open a mile of blank
 * scrollback. That cap has to be ABOVE the heights rows here really reach or it
 * stops being a safety rail and becomes the jump itself - a transcript whose
 * turns draw 8000px held every one of them at 3200 and corrected by 5000px on
 * hydration, which is precisely the symptom this module was written for. So the
 * cap is the fixed default until something taller has been measured, and the
 * tallest measured row after that: a height a row in this chat has actually
 * drawn is by definition not an absurd height for a row in this chat.
 *
 * For the same reason the scale factor is fitted against the UNCLAMPED byte
 * model. A clamped base is flat above the cap, and no factor fitted to a flat
 * base can recover the size ordering the clamp destroyed.
 *
 * ## Bounds and staleness
 *
 * The row table is capped and evicts oldest-first, so a long session cannot
 * grow it without limit; losing an entry costs one estimated placement, never
 * correctness. A remembered height can also go stale if a row's body is
 * rewritten (an edit, a regenerate) - the row is re-fetched and remeasured on
 * its next hydration, and until then a stale MEASURED height is still much
 * closer than the byte estimate it replaced, so this deliberately does not
 * carry an invalidation channel for it.
 *
 * LAYOUT BASIS is the staleness that does get a channel, because it fails the
 * argument that excuses the others: a rewritten body makes one entry a little
 * wrong, while a resize or a type-size change makes every entry wrong at once
 * and in the same direction, and the surviving number is no longer "closer than
 * the estimate" - a height measured in a narrow tile, or at a smaller font, is
 * arbitrarily far from the same row's height in a wide one. See
 * {@link ChatTranscriptRowHeightMemory.observeLayoutBasis}.
 *
 * Nothing here is React state. Heights are hints consumed at mount, so a
 * changed factor must never re-render a mounted transcript; the next
 * placeholder to mount picks up the better number on its own.
 */

/** Rows to remember heights for. Well past what a reader revisits in a session. */
const MAX_REMEMBERED_ROWS = 4000;
/**
 * Rows that must have been both estimated and measured before the scale factor
 * is trusted. Low, because the first screenful is exactly when a reader scrolls
 * into unmeasured history and the raw estimator is at its worst.
 */
const MIN_CALIBRATION_SAMPLES = 4;
/**
 * The scale factor rejects nonsense, and nothing more. The band is deliberately
 * wide: a pooled ratio over several rows is a real observation about this
 * chat, and a NARROW band would quietly override it with a prior. A ratio far
 * below 1 is entirely ordinary - a folded turn is kilobytes of serialized tool
 * payload and a few lines of pixels - and clipping it there was measured
 * holding a row that draws 8200px at 3200.
 */
const CALIBRATION_MIN_FACTOR = 0.01;
const CALIBRATION_MAX_FACTOR = 10;

interface RememberedRow {
  /**
   * The sum of the row's measured parts in px. It is exact only once every
   * slot in `partCount` has reported; until then missing slots are estimated. A
   * long assistant turn is drawn as several list items and the placeholder
   * that later stands in for its ordinal stands in for all of them at once.
   */
  height: number;
  /**
   * Last measured height per list item, keyed by the part's INDEX in the row.
   * One entry at 0 for a row drawn whole.
   *
   * The index rather than the list key, so the set can be reconciled against
   * the row's current part COUNT: a turn redrawn into fewer parts - rewritten,
   * regenerated, re-projected over fewer blocks - keeps reporting the slots it
   * still draws and never mentions the ones it dropped, so a key-addressed
   * entry would linger and hold the remembered total, the pooled role factor
   * and every placeholder calibrated from them as tall as the turn used to be.
   */
  readonly parts: Map<number, number>;
  partCount: number;
  /**
   * The complete row's calibration contribution, or `null` while partial.
   *
   * Keep the original byte estimate to withdraw the sample if a growing turn
   * becomes partial, even when its skeleton entry is no longer at that ordinal.
   */
  sample: {
    readonly role: RowSkeletonEntry["role"];
    readonly estimated: number;
  } | null;
}

interface RoleCalibration {
  /** Summed `rawPlaceholderRowHeight` over sampled rows of this role. */
  estimated: number;
  /** Summed measured height over the same rows. */
  measured: number;
  count: number;
}

/**
 * What a remembered height was measured UNDER.
 *
 * Both members re-flow every row, and neither implies the other: a font-size
 * change can leave the pixel width identical, and a resize does not touch
 * typography. A basis that named only one of them silently served heights
 * measured under the other.
 */
export interface RowHeightLayoutBasis {
  /** The transcript container's measured width, in CSS pixels. */
  readonly width: number;
  /** The effective root font size the rows are laid out at, in CSS pixels. */
  readonly fontSizePx: number;
}

export interface ChatTranscriptRowHeightMemory {
  /**
   * Point the memory at the current row skeleton, which is how a measured row
   * is matched to the `byteLength` it was estimated from. Cheap when the array
   * is unchanged; on a new one it also back-fills samples for rows that were
   * measured BEFORE their skeleton entry arrived - the chat's own tail, which
   * hydrates from the snapshot ahead of the first skeleton chunk and is the
   * only real content available to calibrate against before the reader has
   * scrolled anywhere.
   */
  observeSkeleton(skeleton: readonly (RowSkeletonEntry | undefined)[]): void;
  /**
   * Tell the memory how wide the transcript is being laid out, so it can
   * discard measurements that width has invalidated.
   *
   * Every number here is width-dependent: markdown re-wraps, tool cards
   * reflow, and the pooled scale factor is fitted at one width and says
   * nothing about another. Nothing else can notice - the memory is created
   * once per `ChatMessages` mount and outlives any number of tile resizes - so
   * a height measured in a narrow tile is otherwise served verbatim to a
   * placeholder standing in for the same row in a wide one, reserving
   * thousands of pixels too many or too few and jumping when the body lands.
   *
   * A change discards everything rather than rescaling it, and the discard is
   * cheaper than it looks: the rows on screen are being remeasured by the very
   * resize that cleared them, so they re-enter immediately, and what actually
   * goes is the off-screen entries whose width no longer applies. A drag
   * re-fills as fast as it clears, so there is no thrash to trade against.
   *
   * The FIRST call only records the basis. LegendList measures inside its own
   * layout effect, which runs BEFORE the effect that reports it, so the
   * opening commit's measurements land before any basis has been observed -
   * discarding them would throw away the tail calibration that is the only
   * evidence available before the reader has scrolled anywhere.
   *
   * ## Width is not the only thing a height was measured under
   *
   * TYPOGRAPHY is the other half, and it was missing. Changing the UI font
   * size rewrites `document.documentElement.style.fontSize`, which re-flows
   * every row - but the tile can keep exactly the same pixel width, so a
   * width-only test preserved heights and a pooled calibration factor measured
   * at the old size. Cold rows then reserved stale space and jumped when they
   * hydrated, which is the precise failure this memory exists to prevent.
   *
   * One method taking both rather than two observers, so a change to both at
   * once (a settings panel that resizes the tile AND the font) clears once
   * instead of twice, and so there is exactly one place that defines what a
   * remembered height is valid UNDER.
   */
  observeLayoutBasis(basis: RowHeightLayoutBasis): void;
  /**
   * Record a row's REAL measured height.
   *
   * Only ever called for a HYDRATED row. Feeding a placeholder's own measured
   * height back in would record this module's estimate as if it were an
   * observation and make the calibration confirm itself.
   *
   * `ordinal` is `null` for a row that owns no place in the transcript (a
   * pending send, the live turn). Those are still remembered by id, but they
   * are not calibration samples: there is no skeleton entry to say what they
   * were estimated from, and a streaming row's height is not settled anyway.
   */
  recordMeasuredHeight(input: {
    readonly rowId: string;
    /**
     * Which LIST ITEM of the row was measured, and how many the row is drawn
     * as: `0` and `1` for a row drawn whole. A long assistant turn reports one
     * measurement per part and the row's remembered height is their sum, so
     * the count is what lets a row redrawn into fewer parts forget the slots
     * it no longer has (see {@link RememberedRow.parts}).
     */
    readonly partIndex: number;
    readonly partCount: number;
    readonly ordinal: number | null;
    readonly height: number;
  }): void;
  /** The height a placeholder standing in for this row should occupy. */
  placeholderHeight(entry: RowSkeletonEntry | null): number;
}

export function createChatTranscriptRowHeightMemory(): ChatTranscriptRowHeightMemory {
  const rows = new Map<string, RememberedRow>();
  const byRole = new Map<RowSkeletonEntry["role"], RoleCalibration>();
  let skeleton: readonly (RowSkeletonEntry | undefined)[] = [];
  /** Only complete rows contribute to the unknown-row average. */
  let heightTotal = 0;
  let measuredRowCount = 0;
  /**
   * The tallest row this transcript has actually drawn, which is what raises
   * the placeholder ceiling above its fixed default. A row that has been
   * measured at this height is by definition not an absurd height for a row
   * here, so a guess may reach it.
   */
  let tallestMeasured = 0;
  /**
   * The layout width every number above was measured at, or `null` before any
   * has been reported. `null` is "no baseline yet", never "zero wide" - the
   * first report adopts a width rather than invalidating against it.
   */
  let layoutBasis: RowHeightLayoutBasis | null = null;

  const sample = (entry: RowSkeletonEntry, remembered: RememberedRow): void => {
    if (
      remembered.sample !== null ||
      remembered.parts.size !== remembered.partCount
    )
      return;
    const estimated = rawPlaceholderRowHeight(entry.byteLength);
    remembered.sample = { role: entry.role, estimated };
    const bucket = byRole.get(entry.role) ?? {
      estimated: 0,
      measured: 0,
      count: 0,
    };
    bucket.estimated += estimated;
    bucket.measured += remembered.height;
    bucket.count += 1;
    byRole.set(entry.role, bucket);
  };

  const evictOldest = (): void => {
    if (rows.size <= MAX_REMEMBERED_ROWS) return;
    const oldest = rows.keys().next();
    if (oldest.done === true) return;
    const dropped = rows.get(oldest.value);
    if (dropped !== undefined && dropped.parts.size === dropped.partCount) {
      heightTotal -= dropped.height;
      measuredRowCount -= 1;
    }
    rows.delete(oldest.value);
  };

  /**
   * How tall a calibrated guess may go: never below the fixed rail, and up to
   * the tallest row this transcript has actually drawn.
   */
  const calibratedCeiling = (): number =>
    Math.max(PLACEHOLDER_MAX_HEIGHT_PX, tallestMeasured);

  /**
   * The scale factor for this role, or `null` while the evidence is too thin.
   * Guards the divisor: a role whose sampled rows all estimated to zero would
   * otherwise produce a non-finite factor.
   */
  const factorFor = (role: RowSkeletonEntry["role"]): number | null => {
    const bucket = byRole.get(role);
    if (bucket === undefined) return null;
    if (bucket.count < MIN_CALIBRATION_SAMPLES) return null;
    if (bucket.estimated <= 0) return null;
    const factor = bucket.measured / bucket.estimated;
    if (!Number.isFinite(factor) || factor <= 0) return null;
    return Math.min(
      CALIBRATION_MAX_FACTOR,
      Math.max(CALIBRATION_MIN_FACTOR, factor),
    );
  };

  return {
    observeSkeleton(next): void {
      if (next === skeleton) return;
      skeleton = next;
      for (const entry of next) {
        if (entry === undefined) continue;
        const remembered = rows.get(entry.rowId);
        if (remembered === undefined) continue;
        sample(entry, remembered);
      }
    },

    observeLayoutBasis(basis): void {
      // A zero or non-finite width is a container that has not been laid out -
      // an unmounted tile, a hidden tab - and adopting it as the baseline would
      // make the next real width read as a change and discard a full memory.
      // The same argument covers a font size that has not resolved yet.
      if (!Number.isFinite(basis.width) || basis.width <= 0) return;
      if (!Number.isFinite(basis.fontSizePx) || basis.fontSizePx <= 0) return;
      if (layoutBasis === null) {
        layoutBasis = basis;
        return;
      }
      if (
        layoutBasis.width === basis.width &&
        layoutBasis.fontSizePx === basis.fontSizePx
      ) {
        return;
      }
      layoutBasis = basis;
      // The calibration goes with the heights, not just alongside them: the
      // pooled factor is `sum(measured) / sum(estimated)` over rows measured at
      // the OLD width, so keeping it would carry the stale evidence into every
      // placeholder drawn before the first row is remeasured. `tallestMeasured`
      // likewise - it is the ceiling those measurements justified.
      rows.clear();
      byRole.clear();
      heightTotal = 0;
      measuredRowCount = 0;
      tallestMeasured = 0;
    },

    recordMeasuredHeight({
      rowId,
      partIndex,
      partCount,
      ordinal,
      height,
    }): void {
      // A zero or negative measurement is an unmounted or not-yet-laid-out row,
      // never an observation about how tall the row is.
      if (!Number.isFinite(height) || height <= 0) return;
      const remembered: RememberedRow = rows.get(rowId) ?? {
        height: 0,
        parts: new Map<number, number>(),
        partCount,
        sample: null,
      };
      const wasComplete = remembered.parts.size === remembered.partCount;
      const previousHeight = remembered.height;
      if (wasComplete) {
        heightTotal -= previousHeight;
        measuredRowCount -= 1;
      }
      remembered.partCount = partCount;
      remembered.parts.set(partIndex, height);
      // A rewrite can drop slots without those removed parts reporting again.
      for (const index of remembered.parts.keys()) {
        if (index >= partCount) remembered.parts.delete(index);
      }
      remembered.height = 0;
      for (const partHeight of remembered.parts.values()) {
        remembered.height += partHeight;
      }
      const complete = remembered.parts.size === partCount;
      if (complete) {
        heightTotal += remembered.height;
        measuredRowCount += 1;
        tallestMeasured = Math.max(tallestMeasured, remembered.height);
      }
      // A growing turn can become partial again, even when this measurement
      // leaves its sum unchanged. Withdraw its WHOLE-row sample immediately.
      const previousSample = remembered.sample;
      if (previousSample !== null) {
        const bucket = byRole.get(previousSample.role);
        if (bucket !== undefined) {
          if (complete) {
            bucket.measured += remembered.height - previousHeight;
          } else {
            bucket.measured -= previousHeight;
            bucket.estimated -= previousSample.estimated;
            bucket.count -= 1;
          }
        }
        if (!complete) remembered.sample = null;
      }
      rows.set(rowId, remembered);
      evictOldest();
      if (ordinal === null) return;
      const entry = skeleton[ordinal];
      // Skeleton delivery can lag the body; never pair a different row's bytes.
      if (entry !== undefined && entry.rowId === rowId)
        sample(entry, remembered);
    },

    placeholderHeight(entry): number {
      if (entry === null) {
        if (measuredRowCount === 0) return PLACEHOLDER_UNKNOWN_HEIGHT_PX;
        return clampPlaceholderHeight(
          heightTotal / measuredRowCount,
          calibratedCeiling(),
        );
      }
      const remembered = rows.get(entry.rowId);
      if (
        remembered !== undefined &&
        remembered.parts.size === remembered.partCount
      ) {
        return remembered.height;
      }
      const base = rawPlaceholderRowHeight(entry.byteLength);
      const factor = factorFor(entry.role);
      // Only complete observations can calibrate the whole-row byte estimate.
      const estimate =
        factor === null
          ? clampPlaceholderHeight(base, PLACEHOLDER_UNCALIBRATED_MAX_HEIGHT_PX)
          : clampPlaceholderHeight(base * factor, calibratedCeiling());
      if (remembered === undefined) return estimate;
      const missingShare =
        (remembered.partCount - remembered.parts.size) / remembered.partCount;
      return remembered.height + estimate * missingShare;
    },
  };
}
