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
  /** The row's last measured height in px. */
  height: number;
  /**
   * The role bucket this row contributed to, or `null` if it never has.
   *
   * The ROLE rather than a boolean, because a remeasurement has to find the
   * bucket again to correct it - and the skeleton entry that named the role is
   * not necessarily still at that ordinal by then.
   */
  sampledRole: RowSkeletonEntry["role"] | null;
}

interface RoleCalibration {
  /** Summed `rawPlaceholderRowHeight` over sampled rows of this role. */
  estimated: number;
  /** Summed measured height over the same rows. */
  measured: number;
  count: number;
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
  /** Sum of the latest height of every row in `rows`, for the unknown-row average. */
  let heightTotal = 0;
  /**
   * The tallest row this transcript has actually drawn, which is what raises
   * the placeholder ceiling above its fixed default. A row that has been
   * measured at this height is by definition not an absurd height for a row
   * here, so a guess may reach it.
   */
  let tallestMeasured = 0;

  const sample = (entry: RowSkeletonEntry, remembered: RememberedRow): void => {
    if (remembered.sampledRole !== null) return;
    remembered.sampledRole = entry.role;
    const bucket = byRole.get(entry.role) ?? {
      estimated: 0,
      measured: 0,
      count: 0,
    };
    bucket.estimated += rawPlaceholderRowHeight(entry.byteLength);
    bucket.measured += remembered.height;
    bucket.count += 1;
    byRole.set(entry.role, bucket);
  };

  const evictOldest = (): void => {
    if (rows.size <= MAX_REMEMBERED_ROWS) return;
    const oldest = rows.keys().next();
    if (oldest.done === true) return;
    const dropped = rows.get(oldest.value);
    if (dropped !== undefined) heightTotal -= dropped.height;
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

    recordMeasuredHeight({ rowId, ordinal, height }): void {
      // A zero or negative measurement is an unmounted or not-yet-laid-out row,
      // never an observation about how tall the row is.
      if (!Number.isFinite(height) || height <= 0) return;
      if (height > tallestMeasured) tallestMeasured = height;
      const existing = rows.get(rowId);
      if (existing === undefined) {
        const remembered: RememberedRow = { height, sampledRole: null };
        rows.set(rowId, remembered);
        heightTotal += height;
        evictOldest();
        if (ordinal === null) return;
        const entry = skeleton[ordinal];
        // The skeleton is ordinal-indexed and can lag the spans, so confirm it
        // describes THIS row before treating it as this row's byte length.
        if (entry !== undefined && entry.rowId === rowId)
          sample(entry, remembered);
        return;
      }
      const delta = height - existing.height;
      heightTotal += delta;
      existing.height = height;
      // Keep the role bucket in step with the row's CURRENT height, not the
      // first one it ever reported. A streaming assistant row is remeasured
      // continuously, and rows grow again when images and tool output finish
      // loading - so with only `MIN_CALIBRATION_SAMPLES` rows behind a factor,
      // a handful of rows sampled at their initial height can hold the whole
      // role's scale far below reality and undersize every unseen placeholder,
      // while this memory already holds the correct final numbers.
      //
      // `estimated` and `count` are untouched: the byte-derived estimate for
      // this row has not changed and it is still exactly one sample.
      if (existing.sampledRole === null) return;
      const bucket = byRole.get(existing.sampledRole);
      if (bucket === undefined) return;
      bucket.measured += delta;
    },

    placeholderHeight(entry): number {
      if (entry !== null) {
        const remembered = rows.get(entry.rowId);
        if (remembered !== undefined) return remembered.height;
      }
      if (entry === null) {
        if (rows.size === 0) return PLACEHOLDER_UNKNOWN_HEIGHT_PX;
        return clampPlaceholderHeight(
          heightTotal / rows.size,
          calibratedCeiling(),
        );
      }
      const base = rawPlaceholderRowHeight(entry.byteLength);
      const factor = factorFor(entry.role);
      // With no scale factor there is no evidence that a big byte count means
      // a tall row - the two roles here differ 39x at the same size - so the
      // raw model stays behind the conservative no-evidence cap.
      if (factor === null) {
        return clampPlaceholderHeight(
          base,
          PLACEHOLDER_UNCALIBRATED_MAX_HEIGHT_PX,
        );
      }
      return clampPlaceholderHeight(base * factor, calibratedCeiling());
    },
  };
}
