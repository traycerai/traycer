import type {
  PersistedTabStripLayout,
  SplitSide,
  StripItem,
} from "@/stores/tabs/layout";
import type {
  TabCustomization,
  TabCustomizations,
} from "@/stores/tabs/tab-groups";

/**
 * The tabs layout before the Tracy surface (decision 150) held one `bot` ref
 * per bot tab. Parsing reads each as the one `tracy` ref (`parseTabRef`), so a
 * layout that held several now names the surface several times. This keeps
 * one: the active item's, or the first, so the active item keeps its
 * identity. A split of two bots becomes the surface's tab, a
 * split that loses its bot keeps its other side, the activation history
 * names the surface once, at its most recent place, and the bots'
 * customizations collapse onto the surface's key.
 */
const LEGACY_BOT_KEY_PREFIX = "bot:";
const TRACY_KEY = "tracy:tracy";

/**
 * The bot the raw layout had active: its active item's ref, or the focused
 * side of its active split, else the other side. `null` when the active item
 * is not a bot's, or the payload is not a layout.
 */
export function legacyActiveBotIdOf(raw: unknown): string | null {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null;
  const active: unknown = raw.items.find(
    (item: unknown) => isRecord(item) && item.id === raw.activeItemId,
  );
  if (!isRecord(active)) return null;
  if (active.kind === "tab") return legacyBotIdOfRef(active.ref);
  if (active.kind !== "split") return null;
  const [first, second] =
    active.focusedSide === "right"
      ? [active.right, active.left]
      : [active.left, active.right];
  return legacyBotIdOfSide(first) ?? legacyBotIdOfSide(second);
}

function legacyBotIdOfSide(side: unknown): string | null {
  return isRecord(side) && side.kind === "tab"
    ? legacyBotIdOfRef(side.ref)
    : null;
}

function legacyBotIdOfRef(ref: unknown): string | null {
  return isRecord(ref) &&
    ref.kind === "bot" &&
    typeof ref.id === "string" &&
    ref.id.length > 0
    ? ref.id
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTracySide(side: SplitSide): boolean {
  if (side.kind === "tab") return side.ref.kind === "tracy";
  if (side.kind === "unavailable") return side.previousRef.kind === "tracy";
  return false;
}

function itemHoldsTracy(item: StripItem): boolean {
  if (item.kind === "tab") return item.ref.kind === "tracy";
  return isTracySide(item.left) || isTracySide(item.right);
}

/** `item` with no Tracy in it, or `null` when nothing else is left. */
function withoutTracy(item: StripItem): StripItem | null {
  if (item.kind === "tab") return null;
  const left: SplitSide = isTracySide(item.left)
    ? { kind: "empty" }
    : item.left;
  const right: SplitSide = isTracySide(item.right)
    ? { kind: "empty" }
    : item.right;
  if (left.kind === "empty" && right.kind === "empty") return null;
  return { ...item, left, right };
}

/** The one surface's item: a split whose two sides were both bots is its tab. */
function keptTracyItem(item: StripItem): StripItem {
  if (item.kind === "tab") return item;
  if (isTracySide(item.left) && isTracySide(item.right)) {
    return { kind: "tab", id: item.id, ref: { kind: "tracy", id: "tracy" } };
  }
  return item;
}

export function collapseTracyRefs(
  layout: PersistedTabStripLayout,
  legacyActiveBotId: string | null,
): PersistedTabStripLayout {
  const holders = layout.items.filter(itemHoldsTracy);
  const kept =
    holders.find((item) => item.id === layout.activeItemId) ?? holders.at(0);
  const hasLegacyKeys = Object.keys(layout.customizations ?? {}).some((key) =>
    key.startsWith(LEGACY_BOT_KEY_PREFIX),
  );
  const history = layout.activationHistory;
  const tracyInHistory =
    history?.filter((ref) => ref.kind === "tracy").length ?? 0;
  if (kept === undefined && !hasLegacyKeys && tracyInHistory < 2) {
    return layout;
  }
  // The active item is the one kept whenever it holds the surface, so the
  // selection never moves off it.
  const items = layout.items.flatMap((item): ReadonlyArray<StripItem> => {
    if (!itemHoldsTracy(item)) return [item];
    if (item === kept) return [keptTracyItem(item)];
    const rest = withoutTracy(item);
    return rest === null ? [] : [rest];
  });
  const firstTracy = history?.findIndex((ref) => ref.kind === "tracy") ?? -1;
  return {
    ...layout,
    items,
    activationHistory: history?.filter(
      (ref, index) => ref.kind !== "tracy" || index === firstTracy,
    ),
    customizations: collapseTracyCustomizations(
      layout.customizations,
      legacyActiveBotId,
    ),
  };
}

/**
 * One customization for the surface: its own if it has one, else the active
 * bot tab's, else the first bot tab's. No bot key survives.
 */
function collapseTracyCustomizations(
  customizations: TabCustomizations | undefined,
  legacyActiveBotId: string | null,
): TabCustomizations | undefined {
  if (customizations === undefined) return undefined;
  const entries = Object.entries(customizations);
  const legacy = entries.filter(([key]) =>
    key.startsWith(LEGACY_BOT_KEY_PREFIX),
  );
  if (legacy.length === 0) return customizations;
  const next: Record<string, TabCustomization> = Object.fromEntries(
    entries.filter(([key]) => !key.startsWith(LEGACY_BOT_KEY_PREFIX)),
  );
  if (!Object.hasOwn(next, TRACY_KEY)) {
    const preferred =
      legacy.find(
        ([key]) => key === `${LEGACY_BOT_KEY_PREFIX}${legacyActiveBotId}`,
      ) ?? legacy[0];
    next[TRACY_KEY] = preferred[1];
  }
  return next;
}
