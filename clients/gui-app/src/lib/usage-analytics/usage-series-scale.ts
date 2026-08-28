/**
 * Categorical color assignment for the per-day chart's harness/model
 * breakdown.
 *
 * The generic model scale has sixteen fixed slots, assigned in the order the
 * caller supplies. The harness scale layers semantic brand preferences over
 * the same validated slots, with dedicated anchors for its key identities.
 * `buildUsageSeriesScaleForBuckets` splits the supplied keys deliberately:
 * the keys past the cap are chosen by SPEND (so "Other" is the long tail)
 * while the order of the ones that fit is total-independent (so a series does
 * not change color
 * when a refetch merely reorders magnitudes). Slots 1-8 are the dataviz
 * skill's validated primary hues;
 * 9-16 are their shade/tint cousins (see `usage-analytics-chart.css`), a
 * deliberately weaker ring that only the cheaper series ever land in. Past
 * sixteen distinct keys the tail folds into "Other" rather than generating
 * a seventeenth color - a generated color is indistinguishable from an
 * existing one under CVD and breaks every validated-palette check.
 */
export const USAGE_SERIES_SLOT_COUNT = 16;
export const USAGE_SERIES_OTHER_KEY = "__usage_series_other__";

const USAGE_SERIES_SLOTS = Array.from(
  { length: USAGE_SERIES_SLOT_COUNT },
  (_, index) => index + 1,
);

/**
 * Preferred categorical slot for every harness currently shipped by Traycer.
 * The first three harnesses below use dedicated semantic tokens instead: they
 * are the identities users recognize most readily, and their colors must not
 * move when another harness enters or leaves the response.
 *
 * For monochrome brands after OpenCode, the preference deliberately chooses a
 * distinct hue. Repeating black/gray would erase categorical separation in a
 * dense legend. The allocator treats these as preferences, not guarantees: if
 * a preferred slot is occupied, it takes the next free validated slot.
 */
const HARNESS_PREFERRED_SLOT: Readonly<Partial<Record<string, number>>> = {
  amp: 8,
  copilot: 5,
  cursor: 15,
  devin: 3,
  droid: 6,
  grok: 13,
  hermes: 12,
  huggingface: 4,
  kilocode: 14,
  kimi: 9,
  kiro: 7,
  omp: 10,
  openrouter: 11,
  pi: 16,
  qwen: 7,
  reasonix: 9,
  traycer: 3,
};

type HarnessBrandColor = {
  readonly colorVar: string;
  readonly reservedSlots: readonly number[];
  /** Slots whose CSS value exactly equals this semantic token. */
  readonly exactColorSlots?: readonly number[];
};

const FIXED_HARNESS_COLOR: Readonly<
  Partial<Record<string, HarnessBrandColor>>
> = {
  claude: {
    colorVar: "var(--usage-harness-claude)",
    reservedSlots: [2, 10],
  },
  codex: {
    colorVar: "var(--usage-harness-codex)",
    reservedSlots: [1, 9],
    exactColorSlots: [1],
  },
  opencode: {
    colorVar: "var(--usage-harness-opencode)",
    reservedSlots: [],
  },
};

const PREFERRED_HARNESS_COLOR: Readonly<
  Partial<Record<string, HarnessBrandColor>>
> = {
  amp: { colorVar: "var(--usage-harness-amp)", reservedSlots: [8, 16] },
  huggingface: {
    colorVar: "var(--usage-harness-huggingface)",
    reservedSlots: [4, 12],
  },
  omp: { colorVar: "var(--usage-harness-omp)", reservedSlots: [2, 10] },
  reasonix: {
    colorVar: "var(--usage-harness-reasonix)",
    reservedSlots: [1, 9],
  },
};

export interface UsageSeriesScale {
  /** Series keys in slot order - real harness ids / model ids, plus the "Other" sentinel if any key overflowed. */
  readonly order: readonly string[];
  /** CSS `var(...)` reference for a series key - falls back to the "Other" token for an unrecognized key. */
  readonly colorVar: (seriesKey: string) => string;
  /** Display label - the raw harness/model id (no invented display-name catalog), or "Other". */
  readonly labelFor: (seriesKey: string) => string;
}

export function buildUsageSeriesScale(
  seriesKeysInSlotOrder: readonly string[],
): UsageSeriesScale {
  const primary = seriesKeysInSlotOrder.slice(0, USAGE_SERIES_SLOT_COUNT);
  const overflow = seriesKeysInSlotOrder.slice(USAGE_SERIES_SLOT_COUNT);
  const order =
    overflow.length > 0 ? [...primary, USAGE_SERIES_OTHER_KEY] : primary;
  const slotIndex = new Map(primary.map((id, index) => [id, index]));

  return {
    order,
    colorVar: (seriesKey) => {
      if (seriesKey === USAGE_SERIES_OTHER_KEY) {
        return "var(--usage-series-other)";
      }
      const index = slotIndex.get(seriesKey);
      return index === undefined
        ? "var(--usage-series-other)"
        : `var(--usage-series-${String(index + 1)})`;
    },
    labelFor: (seriesKey) =>
      seriesKey === USAGE_SERIES_OTHER_KEY ? "Other" : seriesKey,
  };
}

type HarnessColorAllocation = {
  readonly colorByKey: Map<string, string>;
  readonly brandFamilyReservedSlots: Set<number>;
  readonly exactColorReservedSlots: Set<number>;
};

function reserveHarnessBrandColor(
  allocation: HarnessColorAllocation,
  seriesKey: string,
  color: HarnessBrandColor,
): void {
  allocation.colorByKey.set(seriesKey, color.colorVar);
  for (const reservedSlot of color.reservedSlots) {
    allocation.brandFamilyReservedSlots.add(reservedSlot);
  }
  for (const exactColorSlot of color.exactColorSlots ?? []) {
    allocation.exactColorReservedSlots.add(exactColorSlot);
  }
}

function allocateHarnessBrandColors(
  primary: readonly string[],
  allocation: HarnessColorAllocation,
): void {
  for (const seriesKey of primary) {
    const fixed = FIXED_HARNESS_COLOR[seriesKey];
    if (fixed !== undefined) {
      reserveHarnessBrandColor(allocation, seriesKey, fixed);
    }
  }

  for (const seriesKey of primary) {
    if (allocation.colorByKey.has(seriesKey)) continue;
    const preferred = PREFERRED_HARNESS_COLOR[seriesKey];
    if (
      preferred !== undefined &&
      !preferred.reservedSlots.some((slot) =>
        allocation.brandFamilyReservedSlots.has(slot),
      )
    ) {
      reserveHarnessBrandColor(allocation, seriesKey, preferred);
    }
  }
}

function findAvailableUsageSeriesSlot(
  preferredSlot: number | undefined,
  occupiedSlots: ReadonlySet<number>,
  brandFamilyReservedSlots: ReadonlySet<number>,
  exactColorReservedSlots: ReadonlySet<number>,
): number | undefined {
  if (
    preferredSlot !== undefined &&
    !occupiedSlots.has(preferredSlot) &&
    !brandFamilyReservedSlots.has(preferredSlot)
  ) {
    return preferredSlot;
  }
  return (
    USAGE_SERIES_SLOTS.find(
      (candidate) =>
        !occupiedSlots.has(candidate) &&
        !brandFamilyReservedSlots.has(candidate),
    ) ??
    USAGE_SERIES_SLOTS.find(
      (candidate) =>
        !occupiedSlots.has(candidate) &&
        !exactColorReservedSlots.has(candidate),
    )
  );
}

/**
 * Brand-aware variant for harness breakdowns. Fixed semantic colors are
 * allocated first; the remaining harnesses use brand-adjacent preferences
 * without ever sharing a color in the same scale. Model breakdowns must keep
 * using `buildUsageSeriesScale`: a model slug is not a harness identity.
 */
export function buildHarnessUsageSeriesScale(
  seriesKeysInSlotOrder: readonly string[],
): UsageSeriesScale {
  const primary = seriesKeysInSlotOrder.slice(0, USAGE_SERIES_SLOT_COUNT);
  const overflow = seriesKeysInSlotOrder.slice(USAGE_SERIES_SLOT_COUNT);
  const order =
    overflow.length > 0 ? [...primary, USAGE_SERIES_OTHER_KEY] : primary;
  const allocation: HarnessColorAllocation = {
    colorByKey: new Map<string, string>(),
    brandFamilyReservedSlots: new Set<number>(),
    exactColorReservedSlots: new Set<number>(),
  };
  const occupiedSlots = new Set<number>();

  allocateHarnessBrandColors(primary, allocation);

  for (const seriesKey of primary) {
    if (allocation.colorByKey.has(seriesKey)) continue;
    const slot = findAvailableUsageSeriesSlot(
      HARNESS_PREFERRED_SLOT[seriesKey],
      occupiedSlots,
      allocation.brandFamilyReservedSlots,
      allocation.exactColorReservedSlots,
    );
    if (slot === undefined) continue;
    occupiedSlots.add(slot);
    allocation.colorByKey.set(seriesKey, `var(--usage-series-${String(slot)})`);
  }

  return {
    order,
    colorVar: (seriesKey) =>
      seriesKey === USAGE_SERIES_OTHER_KEY
        ? "var(--usage-series-other)"
        : (allocation.colorByKey.get(seriesKey) ?? "var(--usage-series-other)"),
    labelFor: (seriesKey) =>
      seriesKey === USAGE_SERIES_OTHER_KEY ? "Other" : seriesKey,
  };
}
