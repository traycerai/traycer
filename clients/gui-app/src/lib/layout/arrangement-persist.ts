import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit";
import { CONTEXT_USAGE_ROW_KEYS } from "@/lib/context-usage-rows";
import {
  AUTOMATIC_LIMIT_SELECTION,
  BAR_REGION_IDS,
  isAutomaticLimitSelection,
  DEFAULT_ARRANGEMENT,
  DEFAULT_DOCK_ORDER,
  DEFAULT_TOOLBAR_LEFT,
  DEFAULT_TOOLBAR_RIGHT,
  TOOLBAR_REGION_IDS,
  USAGE_PROVIDER_IDS,
  type BarHost,
  type BarRegionId,
  type EdgeSide,
  type LayoutArrangement,
  type StatusBarProviderLimits,
  type StatusBarProviderLimitSelection,
  type SideStripView,
  type ReadingWidth,
  type TaskTabLayout,
  type StatusBarShownProfiles,
  type TabStripPlacement,
} from "@/lib/layout/layout-arrangement";
import { sameFieldList } from "@/lib/layout/layout-values";
import {
  DEFAULT_RAIL,
  highestDividerSeq,
  normalizeRail,
  RAIL_REGION_IDS,
  type RailEntry,
} from "@/lib/layout/rail";
import type { ToolbarRegionId } from "@/lib/layout/region-id";
import { mergeOrder } from "@/lib/order-merge";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * Both sides of the arrangement's durability boundary: the invariants any
 * arrangement is held to, and the field-by-field read of one some build of the
 * app wrote.
 *
 * One module rather than two, because the write path runs the same
 * normalisation the rehydrate ends in - a drag that lands impossibly is
 * repaired where a persisted blob would be, rather than only on the next start.
 */

/**
 * An arrangement held to every invariant its type states: each toolbar region
 * in exactly one cluster with `model` on the right, every dock row and every
 * provider present once, every panel in the rail once, and a `dividerSeq`
 * that has not fallen behind the ids the rail is already using.
 *
 * Every field it did not have to change keeps its INPUT identity, and an
 * arrangement it changed nothing about is returned as itself. Identity is the
 * only thing a selector subscribed to one arrangement field compares, so
 * rebuilding the arrays on every call made a no-op write re-render the whole
 * status bar (G1-14).
 */
export function normalizeArrangement(
  arrangement: LayoutArrangement,
): LayoutArrangement {
  const toolbar = resolveToolbarClusters(
    arrangement.toolbarLeft,
    arrangement.toolbarRight,
  );
  const rail = keptEntries(arrangement.rail, normalizeRail(arrangement.rail));
  const next: LayoutArrangement = {
    ...arrangement,
    dock: keptOrder(
      arrangement.dock,
      mergeOrder(arrangement.dock, DEFAULT_DOCK_ORDER),
    ),
    toolbarLeft: keptOrder(arrangement.toolbarLeft, toolbar.left),
    toolbarRight: keptOrder(arrangement.toolbarRight, toolbar.right),
    rail,
    providerLimits: withoutAutomaticLimits(arrangement.providerLimits),
    usageProviders: keptOrder(
      arrangement.usageProviders,
      mergeOrder(arrangement.usageProviders, USAGE_PROVIDER_IDS),
    ),
    pinnedContextFieldOrder: keptOrder(
      arrangement.pinnedContextFieldOrder,
      mergeOrder(arrangement.pinnedContextFieldOrder, CONTEXT_USAGE_ROW_KEYS),
    ),
    dividerSeq: Math.max(arrangement.dividerSeq, highestDividerSeq(rail)),
  };
  return sameArrangement(arrangement, next) ? arrangement : next;
}

/** The stored list when normalising did not move anything, so its identity survives. */
function keptOrder<Id extends string>(
  stored: ReadonlyArray<Id>,
  normalized: ReadonlyArray<Id>,
): ReadonlyArray<Id> {
  return sameFieldList(stored, normalized) ? stored : normalized;
}

/**
 * The limits with every Automatic entry dropped, since Automatic IS the absent
 * key: a stored default-equal entry would read as a change it is not. Kept as
 * itself when there was none to drop.
 */
function withoutAutomaticLimits(
  limits: StatusBarProviderLimits,
): StatusBarProviderLimits {
  const entries = Object.entries(limits);
  const kept = entries.filter(
    ([, selection]) => !isAutomaticLimitSelection(selection),
  );
  return kept.length === entries.length ? limits : Object.fromEntries(kept);
}

/** {@link keptOrder} for the rail, which is entries rather than ids. */
function keptEntries(
  stored: ReadonlyArray<RailEntry>,
  normalized: ReadonlyArray<RailEntry>,
): ReadonlyArray<RailEntry> {
  const same =
    stored.length === normalized.length &&
    stored.every(
      (entry, index) =>
        entry.kind === normalized[index].kind &&
        entry.id === normalized[index].id,
    );
  return same ? stored : normalized;
}

/** Every field {@link sameArrangement} compares, which is all of them. */
const ARRANGEMENT_FIELDS: ReadonlyArray<keyof LayoutArrangement> = [
  "dock",
  "toolbarLeft",
  "toolbarRight",
  "rail",
  "usageProviders",
  "pinnedContextFieldOrder",
  "hiddenProviders",
  "providerLimits",
  "shownProfiles",
  "usageHost",
  "usageSide",
  "resourceHost",
  "resourceSide",
  "minimapSide",
  "statusBarParked",
  "mobileFooter",
  "dividerSeq",
  "tabStripPlacement",
  "sidebarSide",
  "sideStripView",
  "taskTabLayout",
  "readingWidth",
];

/**
 * Whether normalising left every field exactly as it found it. Reference
 * equality throughout, because each field above already reuses the input's
 * identity when it did not change it.
 */
function sameArrangement(
  left: LayoutArrangement,
  right: LayoutArrangement,
): boolean {
  return ARRANGEMENT_FIELDS.every((field) => left[field] === right[field]);
}

/**
 * The arrangement as some build of the app wrote it, field by field against
 * the defaults - a hand-edited bar host would otherwise mount neither surface,
 * and a stale panel id would ask the rail for an icon it has no case for.
 */
export function resolvePersistedArrangement(value: unknown): LayoutArrangement {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  const usageHost = persistedBarHost(
    stored.usageHost,
    DEFAULT_ARRANGEMENT.usageHost,
  );
  const legacyHeaderPair =
    usageHost === "header" && stored.resourceHost === undefined;
  return normalizeArrangement({
    dock: persistedIds(stored.dock, DEFAULT_DOCK_ORDER),
    // Each cluster is read against EVERY toolbar region, so a region the user
    // moved across stays where they put it, and the two are reconciled by
    // `normalizeArrangement` rather than by this read.
    toolbarLeft: persistedCluster(stored.toolbarLeft, DEFAULT_TOOLBAR_LEFT),
    toolbarRight: persistedCluster(stored.toolbarRight, DEFAULT_TOOLBAR_RIGHT),
    rail: persistedRail(stored.rail),
    usageProviders: persistedProviderIds(stored.usageProviders),
    hiddenProviders: persistedProviderIds(stored.hiddenProviders),
    providerLimits: persistedProviderLimits(stored.providerLimits),
    shownProfiles: persistedShownProfiles(stored.shownProfiles),
    usageHost,
    // The two fields a pre-L-156 record cannot have written, read against what
    // that record MEANT rather than against today's defaults (L-161).
    //
    // That build had one `usageHost` for both readings and drew the header
    // pair at the right end ("Top bar - right, before the icons"), so
    // `usageHost: "header"` said: both readings up, no strip, gauge on the
    // right. Resolving the absent fields to the shipped defaults would give
    // that user a status bar back with the readout in it and move their gauge
    // across the window. This is the only place that can tell a record
    // predates the split - an absent field - so the carry lives here and
    // nothing downstream has to know about it.
    usageSide: persistedSide(
      stored.usageSide,
      legacyHeaderPair ? "right" : DEFAULT_ARRANGEMENT.usageSide,
    ),
    resourceHost: persistedBarHost(
      stored.resourceHost,
      legacyHeaderPair ? "header" : DEFAULT_ARRANGEMENT.resourceHost,
    ),
    resourceSide: persistedSide(
      stored.resourceSide,
      DEFAULT_ARRANGEMENT.resourceSide,
    ),
    minimapSide: persistedSide(
      stored.minimapSide,
      DEFAULT_ARRANGEMENT.minimapSide,
    ),
    statusBarParked: persistedBarRegionIds(stored.statusBarParked),
    pinnedContextFieldOrder: persistedIds(
      stored.pinnedContextFieldOrder,
      CONTEXT_USAGE_ROW_KEYS,
    ),
    mobileFooter:
      typeof stored.mobileFooter === "boolean"
        ? stored.mobileFooter
        : DEFAULT_ARRANGEMENT.mobileFooter,
    dividerSeq:
      typeof stored.dividerSeq === "number" &&
      Number.isFinite(stored.dividerSeq)
        ? Math.max(0, Math.floor(stored.dividerSeq))
        : 0,
    tabStripPlacement: persistedTabStripPlacement(
      stored.tabStripPlacement,
      DEFAULT_ARRANGEMENT.tabStripPlacement,
    ),
    sidebarSide: persistedSide(
      stored.sidebarSide,
      DEFAULT_ARRANGEMENT.sidebarSide,
    ),
    sideStripView: persistedSideStripView(
      stored.sideStripView,
      DEFAULT_ARRANGEMENT.sideStripView,
    ),
    taskTabLayout: persistedTaskTabLayout(
      stored.taskTabLayout,
      DEFAULT_ARRANGEMENT.taskTabLayout,
    ),
    readingWidth: persistedReadingWidth(
      stored.readingWidth,
      DEFAULT_ARRANGEMENT.readingWidth,
    ),
  });
}

/**
 * Both clusters at once, holding the two invariants the type states: every
 * toolbar region exactly once across them, and `model` on the right.
 *
 * `model` is STRIPPED from the left rather than swapped in place, which leaves
 * it missing and therefore re-inserted into the right at its canonical
 * position - the same path a genuinely absent region takes, so there is one
 * rule to reason about rather than two.
 */
function resolveToolbarClusters(
  storedLeft: ReadonlyArray<ToolbarRegionId>,
  storedRight: ReadonlyArray<ToolbarRegionId>,
): {
  readonly left: ReadonlyArray<ToolbarRegionId>;
  readonly right: ReadonlyArray<ToolbarRegionId>;
} {
  const claimed = new Set<ToolbarRegionId>();
  const left = claimCluster(storedLeft, claimed).filter((id) => id !== "model");
  const right = claimCluster(storedRight, claimed);
  const present = new Set([...left, ...right]);
  const missing = TOOLBAR_REGION_IDS.filter((id) => !present.has(id));
  return {
    left: resolveToolbarSide(left, missing, DEFAULT_TOOLBAR_LEFT),
    right: resolveToolbarSide(right, missing, DEFAULT_TOOLBAR_RIGHT),
  };
}

function claimCluster(
  stored: ReadonlyArray<ToolbarRegionId>,
  claimed: Set<ToolbarRegionId>,
): ReadonlyArray<ToolbarRegionId> {
  const items: ToolbarRegionId[] = [];
  for (const id of stored) {
    if (claimed.has(id)) continue;
    claimed.add(id);
    items.push(id);
  }
  return items;
}

/**
 * One cluster, with the regions that belong here and are missing entirely
 * merged back in at their canonical positions.
 *
 * The canonical sequence is built PER CLUSTER and per resolve: using the
 * default cluster list directly would put back a region the user deliberately
 * moved to the other side.
 */
function resolveToolbarSide(
  stored: ReadonlyArray<ToolbarRegionId>,
  missing: ReadonlyArray<ToolbarRegionId>,
  defaults: ReadonlyArray<ToolbarRegionId>,
): ReadonlyArray<ToolbarRegionId> {
  const canonical = TOOLBAR_REGION_IDS.filter(
    (id) =>
      stored.includes(id) || (missing.includes(id) && defaults.includes(id)),
  );
  return mergeOrder(stored, canonical);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A stored order reduced to ids this build knows. `mergeOrder` in
 * `normalizeArrangement` does the re-insertion, so this is only the read.
 */
function persistedIds<Id extends string>(
  value: unknown,
  canonical: ReadonlyArray<Id>,
): ReadonlyArray<Id> {
  return Array.isArray(value) ? mergeOrder(value, canonical) : canonical;
}

/**
 * One toolbar cluster as it was stored: known regions, in stored order, with
 * no re-insertion - a region missing from BOTH clusters is put back by
 * `normalizeArrangement`, which is the only place that can see both.
 *
 * "Known" is `TOOLBAR_REGION_IDS`, so an id this build retired - `agent`,
 * deleted by L-136 - is dropped here rather than migrated away, and the
 * remaining members keep their stored order (P5).
 */
function persistedCluster(
  value: unknown,
  fallback: ReadonlyArray<ToolbarRegionId>,
): ReadonlyArray<ToolbarRegionId> {
  if (!Array.isArray(value)) return fallback;
  const ids: ToolbarRegionId[] = [];
  for (const entry of value) {
    const id = TOOLBAR_REGION_IDS.find((candidate) => candidate === entry);
    if (id === undefined || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

function persistedProviderIds(
  value: unknown,
): ReadonlyArray<RateLimitProviderId> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): RateLimitProviderId[] => {
    const parsed = rateLimitCapableProviderIdSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Opaque window keys: only non-strings and duplicates can be judged here. */
function persistedWindowKeys(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const keys = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return [...new Set(keys)];
}

/**
 * One provider's picks: the key list and nothing else, since an empty list IS
 * Automatic (R1-15). A record written before the field was dropped carries an
 * `automatic` boolean; it is ignored rather than rejected, because the only
 * thing it ever said was whether the list was empty, which the list says. The
 * store is unreleased, so there is no migration to write.
 */
function persistedLimitSelection(
  value: unknown,
): StatusBarProviderLimitSelection {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  const limitKeys = persistedWindowKeys(stored.limitKeys);
  return limitKeys.length > 0 ? { limitKeys } : AUTOMATIC_LIMIT_SELECTION;
}

function persistedProviderLimits(value: unknown): StatusBarProviderLimits {
  if (!isRecord(value)) return {};
  const limits: Partial<
    Record<RateLimitProviderId, StatusBarProviderLimitSelection>
  > = {};
  for (const [key, selection] of Object.entries(value)) {
    const providerId = rateLimitCapableProviderIdSchema.safeParse(key);
    if (!providerId.success) continue;
    limits[providerId.data] = persistedLimitSelection(selection);
  }
  return limits;
}

/** Profile ids are opaque strings and `null` is the ambient login. */
function persistedProfileIds(value: unknown): ReadonlyArray<string | null> {
  if (!Array.isArray(value)) return [];
  const ids = value.filter(
    (entry): entry is string | null =>
      entry === null || (typeof entry === "string" && entry.length > 0),
  );
  return [...new Set(ids)];
}

/**
 * The whole two-level map, entry by entry: a host key is any non-empty string,
 * a provider key has to be one the build knows, and an entry that resolves to
 * nothing checked is dropped - absent and empty mean the same thing at read
 * time, and only one of them should be able to exist.
 */
function persistedShownProfiles(value: unknown): StatusBarShownProfiles {
  if (!isRecord(value)) return {};
  const shownProfiles: Record<
    string,
    Partial<Record<RateLimitProviderId, ReadonlyArray<string | null>>>
  > = {};
  for (const [hostId, hostValue] of Object.entries(value)) {
    if (hostId.length === 0 || !isRecord(hostValue)) continue;
    const hostShown: Partial<
      Record<RateLimitProviderId, ReadonlyArray<string | null>>
    > = {};
    for (const [key, ids] of Object.entries(hostValue)) {
      const providerId = rateLimitCapableProviderIdSchema.safeParse(key);
      if (!providerId.success) continue;
      const profileIds = persistedProfileIds(ids);
      if (profileIds.length === 0) continue;
      hostShown[providerId.data] = profileIds;
    }
    if (Object.keys(hostShown).length === 0) continue;
    shownProfiles[hostId] = hostShown;
  }
  return shownProfiles;
}

function persistedSide(value: unknown, fallback: EdgeSide): EdgeSide {
  return value === "left" || value === "right" ? value : fallback;
}

/**
 * The stored tab strip placement, kept verbatim when it names one of the
 * three values this build knows (L-133); no legacy carry, because no record
 * has ever written another meaning for this key - it names nothing else, on
 * any build, before or after this one.
 */
function persistedTabStripPlacement(
  value: unknown,
  fallback: TabStripPlacement,
): TabStripPlacement {
  return value === "top" || value === "left" || value === "right"
    ? value
    : fallback;
}

/** The stored strip view, when it names one this build knows (L-133). */
function persistedSideStripView(
  value: unknown,
  fallback: SideStripView,
): SideStripView {
  return value === "layered" || value === "activity" ? value : fallback;
}

function persistedTaskTabLayout(
  value: unknown,
  fallback: TaskTabLayout,
): TaskTabLayout {
  return value === "scroll" || value === "shrink" ? value : fallback;
}

function persistedReadingWidth(
  value: unknown,
  fallback: ReadingWidth,
): ReadingWidth {
  return value === "comfortable" || value === "wide" ? value : fallback;
}

/** The remembered set, holding only ids this build has a reading for (L-160). */
function persistedBarRegionIds(value: unknown): ReadonlyArray<BarRegionId> {
  if (!Array.isArray(value)) return DEFAULT_ARRANGEMENT.statusBarParked;
  const parked = BAR_REGION_IDS.filter((region) =>
    value.some((entry) => entry === region),
  );
  return parked.length === 0 ? DEFAULT_ARRANGEMENT.statusBarParked : parked;
}

/** Which bar a stored reading names, or the one it ships in (L-156). */
function persistedBarHost(value: unknown, fallback: BarHost): BarHost {
  return value === "status-bar" || value === "header" ? value : fallback;
}

/**
 * The rail as it was stored. Structure only: `normalizeRail` decides which
 * panels are missing and where they land.
 *
 * A stored list that survives as NOTHING - an empty array, or nine entries
 * this build has no case for - falls back to the shipped rail rather than to
 * `normalizeRail`'s answer for `[]`, which is all nine panels with no dividers
 * at all and is not a grouping anybody chose (G1-22).
 */
function persistedRail(value: unknown): ReadonlyArray<RailEntry> {
  if (!Array.isArray(value)) return DEFAULT_RAIL;
  const entries = readRailEntries(value);
  return entries.length === 0 ? DEFAULT_RAIL : entries;
}

function readRailEntries(
  value: ReadonlyArray<unknown>,
): ReadonlyArray<RailEntry> {
  return value.flatMap((entry): RailEntry[] => {
    if (!isRecord(entry) || typeof entry.id !== "string") return [];
    if (entry.kind === "divider") {
      return [{ kind: "divider", id: entry.id }];
    }
    // A stack's id names its members; `normalizeRail` keeps the ones that
    // still stand side by side (L-166, L-181).
    if (entry.kind === "stack") {
      return [{ kind: "stack", id: entry.id }];
    }
    if (entry.kind !== "panel") return [];
    const regionId = RAIL_REGION_IDS.find(
      (candidate) => candidate === entry.id,
    );
    return regionId === undefined ? [] : [{ kind: "panel", id: regionId }];
  });
}
