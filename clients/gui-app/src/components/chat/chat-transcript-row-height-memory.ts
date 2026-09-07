import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  clampPlaceholderHeight,
  rawPlaceholderRowHeight,
  PLACEHOLDER_MAX_HEIGHT_PX,
  PLACEHOLDER_UNCALIBRATED_MAX_HEIGHT_PX,
  PLACEHOLDER_UNKNOWN_HEIGHT_PX,
} from "@/components/chat/chat-transcript-placeholder-height";

/** For those rows there is no estimate and no jump at all: the placeholder is the size the body was. 2. **A row never seen is placed at a CALIBRATED estimate.** Rows that have been both estimated and measured say what the estimator's error actually is in this chat, at this width, for this kind of content. A remembered height can also go stale if a row's body is rewritten (an edit, a regenerate) - the row is re-fetched and remeasured on its next hydration, and until then a stale MEASURED height is still much closer than the byte estimate it replaced, so this deliberately does not carry an invalidation channel for it. */

/** Rows to remember heights for. Well past what a reader revisits in a session. */
const MAX_REMEMBERED_ROWS = 4000;
/** Rows that must have been both estimated and measured before the scale factor is trusted. Low, because the first screenful is exactly when a reader scrolls into unmeasured history and the raw estimator is at its worst. */
const MIN_CALIBRATION_SAMPLES = 4;
/** The band is deliberately wide: a pooled ratio over several rows is a real observation about this chat, and a NARROW band would quietly override it with a prior. */
const CALIBRATION_MIN_FACTOR = 0.01;
const CALIBRATION_MAX_FACTOR = 10;

interface RememberedRow {
  /** The row's last measured height in px. */
  height: number;
  /** The role bucket this row contributed to, or `null` if it never has. The ROLE rather than a boolean, because a remeasurement has to find the bucket again to correct it - and the skeleton entry that named the role is not necessarily still at that ordinal by then. */
  sampledRole: RowSkeletonEntry["role"] | null;
}

interface RoleCalibration {
  /** Summed `rawPlaceholderRowHeight` over sampled rows of this role. */
  estimated: number;
  /** Summed measured height over the same rows. */
  measured: number;
  count: number;
}

/** Both members re-flow every row, and neither implies the other: a font-size change can leave the pixel width identical, and a resize does not touch typography. A basis that named only one of them silently served heights measured under the other. */
export interface RowHeightLayoutBasis {
  /** The transcript container's measured width, in CSS pixels. */
  readonly width: number;
  /** The effective root font size the rows are laid out at, in CSS pixels. */
  readonly fontSizePx: number;
}

export interface ChatTranscriptRowHeightMemory {
  /** Point the memory at the current row skeleton, which is how a measured row is matched to the `byteLength` it was estimated from. Cheap when the array is unchanged; on a new one it also back-fills samples for rows that were measured BEFORE their skeleton entry arrived - the chat's own tail, which hydrates from the snapshot ahead of the first skeleton chunk and is the only real content available to calibrate against before the reader has scrolled anywhere. */
  observeSkeleton(skeleton: readonly (RowSkeletonEntry | undefined)[]): void;
  /** Nothing else can notice - the memory is created once per `ChatMessages` mount and outlives any number of tile resizes - so a height measured in a narrow tile is otherwise served verbatim to a placeholder standing in for the same row in a wide one, reserving thousands of pixels too many or too few and jumping when the body lands. Width is not the only thing a height was measured under TYPOGRAPHY is the other half, and it was missing. */
  observeLayoutBasis(basis: RowHeightLayoutBasis): void;
  /** Feeding a placeholder's own measured height back in would record this module's estimate as if it were an observation and make the calibration confirm itself. Those are still remembered by id, but they are not calibration samples: there is no skeleton entry to say what they were estimated from, and a streaming row's height is not settled anyway. */
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
  /** The tallest row this transcript has actually drawn, which is what raises the placeholder ceiling above its fixed default. A row that has been measured at this height is by definition not an absurd height for a row here, so a guess may reach it. */
  let tallestMeasured = 0;
  /** The layout width every number above was measured at, or `null` before any has been reported. `null` is "no baseline yet", never "zero wide" - the first report adopts a width rather than invalidating against it. */
  let layoutBasis: RowHeightLayoutBasis | null = null;

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

  /** How tall a calibrated guess may go: never below the fixed rail, and up to the tallest row this transcript has actually drawn. */
  const calibratedCeiling = (): number =>
    Math.max(PLACEHOLDER_MAX_HEIGHT_PX, tallestMeasured);

  /** The scale factor for this role, or `null` while the evidence is too thin. Guards the divisor: a role whose sampled rows all estimated to zero would otherwise produce a non-finite factor. */
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
      // A zero or non-finite width is a container that has not been laid out - an unmounted tile, a hidden tab - and adopting it as the baseline would make the next real width read as a change and discard a full memory.
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
      // The calibration goes with the heights, not just alongside them: the pooled factor is `sum(measured) / sum(estimated)` over rows measured at the OLD width, so keeping it would carry the stale evidence into every placeholder drawn before the first row is remeasured.
      // `tallestMeasured` likewise - it is the ceiling those measurements justified.
      rows.clear();
      byRole.clear();
      heightTotal = 0;
      tallestMeasured = 0;
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
      // Keep the role bucket in step with the row's CURRENT height, not the first one it ever reported.
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
      // With no scale factor there is no evidence that a big byte count means a tall row - the two roles here differ 39x at the same size - so the raw model stays behind the conservative no-evidence cap.
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
