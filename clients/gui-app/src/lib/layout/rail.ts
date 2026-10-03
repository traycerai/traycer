import type { LeftPanelId } from "@/lib/left-panel-ids";
import type { LayoutValues, Visibility } from "@/lib/layout/layout-values";
import type { AutoRailRegionId, RailRegionId } from "@/lib/layout/region-id";

/**
 * The sidebar rail's own shape: its entries, the bijection onto the sidebar's
 * panel ids, and the two gestures that move a panel within it.
 *
 * A leaf of the layout model, deliberately: nothing here names
 * `LayoutArrangement`, so `layout-arrangement.ts` can hold the rail among its
 * fields and its mutations among its writers without the two importing each
 * other. Reading the rail is this file's job; changing an arrangement is not.
 */

/**
 * The rail as one flat list of items (L-155, L-166, L-181): a panel, a
 * divider, or a stack.
 *
 * Two independent notions, and they stay independent.
 *
 * A DIVIDER is a SPACER and nothing more - the user adds one, drags it and
 * removes it, and the rail draws it as a gap at rest (L-140). It groups
 * nothing, and the shipped rail ships with none.
 *
 * A STACK joins two or more adjacent panels that share the sidebar body, top to bottom, with a resize handle between each two
 * (L-166, L-181). It is an entry rather than a flag on a panel so that both
 * lists the user reads - the inspector index and the Position list - get its
 * row for free, and so `moveCanvasOrderMember` keeps placing one member by id
 * whatever kind it is. It sits directly after its first member, and its ID
 * names every member in order, which is the whole of what it is:
 * {@link normalizeRail} keeps each member only while the members it names
 * still stand side by side.
 *
 * The rail draws a stack as one icon, the top member's, named for every
 * member (L-181); the whole stack moves when it is dragged.
 */
export type RailEntry =
  | { readonly kind: "panel"; readonly id: RailRegionId }
  | { readonly kind: "divider"; readonly id: string }
  | { readonly kind: "stack"; readonly id: string };

/** The rail's panels in canonical order, which is the sidebar's own. */
export const RAIL_REGION_IDS: ReadonlyArray<RailRegionId> = [
  "railAgents",
  "railArtifacts",
  "railTerminals",
  "railBrowsers",
  "railGitDiff",
  "railPullRequests",
  "railFileTree",
  "railSharing",
  "railComments",
];

/**
 * The rail regions and the sidebar panels they draw, both ways.
 *
 * Written out twice rather than derived, because deriving the inverse of a
 * `Record` costs a cast and buys nothing: the pair is nine lines that a reader
 * checks by looking.
 */
const PANEL_BY_RAIL_REGION: Readonly<Record<RailRegionId, LeftPanelId>> = {
  railAgents: "chats",
  railArtifacts: "artifacts",
  railTerminals: "terminals",
  railBrowsers: "browsers",
  railGitDiff: "git-diff",
  railPullRequests: "pull-requests",
  railFileTree: "file-tree",
  railSharing: "sharing",
  railComments: "comments",
};

/**
 * Exported for the one caller that walks it rather than asking about a panel
 * it already knows: the shipped-key carry, which reads a persisted map keyed
 * by panel id (L-61).
 */
export const RAIL_REGION_BY_PANEL: Readonly<Record<LeftPanelId, RailRegionId>> =
  {
    chats: "railAgents",
    artifacts: "railArtifacts",
    terminals: "railTerminals",
    browsers: "railBrowsers",
    "git-diff": "railGitDiff",
    "pull-requests": "railPullRequests",
    "file-tree": "railFileTree",
    sharing: "railSharing",
    comments: "railComments",
  };

/**
 * Which sidebar panel a rail region draws, for the surfaces that need the
 * panel's own metadata - its title and its icon - rather than the region's id.
 */
export function leftPanelIdForRailRegion(regionId: RailRegionId): LeftPanelId {
  return PANEL_BY_RAIL_REGION[regionId];
}

/** The inverse, for the rail's own writers, which speak in panel ids. */
export function railRegionForLeftPanelId(panelId: LeftPanelId): RailRegionId {
  return RAIL_REGION_BY_PANEL[panelId];
}

/** The two panels with a presence rule of their own, and so an `auto` (L-47). */
export const AUTO_RAIL_REGION_IDS: ReadonlyArray<AutoRailRegionId> = [
  "railPullRequests",
  "railComments",
];

export function isAutoRailRegionId(id: string): id is AutoRailRegionId {
  return AUTO_RAIL_REGION_IDS.some((candidate) => candidate === id);
}

/**
 * The nine rail regions' `shown` as the sparse show/hide map every sidebar
 * render path already reads (`isLeftPanelVisible`). An entry is written only
 * where the value departs from the panel's own rule: `hidden` always, `shown`
 * only on the two panels whose rule can leave them out. An always-present
 * panel that is shown is on its rule, so it stays absent from the map.
 */
export function panelVisibilityOverridesFromValues(
  values: Pick<LayoutValues, RailRegionId>,
): Readonly<Partial<Record<LeftPanelId, boolean>>> {
  const overrides: Partial<Record<LeftPanelId, boolean>> = {};
  for (const regionId of RAIL_REGION_IDS) {
    const shown = values[regionId].shown;
    if (shown === "auto") continue;
    if (shown === "shown" && !isAutoRailRegionId(regionId)) continue;
    overrides[PANEL_BY_RAIL_REGION[regionId]] = shown === "shown";
  }
  return overrides;
}

/** The other direction, for a writer holding one panel's show/hide. */
export function railVisibilityFor(override: boolean): Visibility {
  return override ? "shown" : "hidden";
}

/** A divider id is always this shape, so it can never collide with a panel id. */
const DIVIDER_ID_PREFIX = "divider:";

export function railDividerId(seq: number): string {
  return `${DIVIDER_ID_PREFIX}${String(seq)}`;
}

/** The highest number any divider in a rail is already using. */
export function highestDividerSeq(rail: ReadonlyArray<RailEntry>): number {
  return rail.reduce((highest, entry) => {
    if (entry.kind !== "divider") return highest;
    const seq = Number(entry.id.slice(DIVIDER_ID_PREFIX.length));
    return Number.isFinite(seq) ? Math.max(highest, seq) : highest;
  }, 0);
}

/**
 * A stack's id NAMES ITS MEMBERS, in order, which is the whole of its
 * identity: it needs no counter, no persisted field and no re-minting, and a
 * duplicate is impossible because a panel appears in the rail once. A shipped
 * pair's id (`stack:railAgents+railArtifacts`) is the two-member case of the
 * same shape, so every stored pair reads back unchanged (L-181).
 *
 * Naming every member rather than counting positions is what makes "a panel
 * that moves away leaves the stack" a fact the entry itself carries: a
 * positional reading would silently take in whatever panel slid up into the
 * gap, and the id says who the members were, so that reading cannot happen.
 */
const STACK_ID_PREFIX = "stack:";
const STACK_ID_SEPARATOR = "+";

export function railStackId(members: ReadonlyArray<RailRegionId>): string {
  return `${STACK_ID_PREFIX}${members.join(STACK_ID_SEPARATOR)}`;
}

/**
 * The members a stack's id names, in order, or `null` for an id this build
 * cannot read: fewer than two, a repeat, or a panel it does not know.
 */
export function railStackMembers(
  id: string,
): ReadonlyArray<RailRegionId> | null {
  if (!id.startsWith(STACK_ID_PREFIX)) return null;
  const members = id
    .slice(STACK_ID_PREFIX.length)
    .split(STACK_ID_SEPARATOR)
    .map((part) => RAIL_REGION_IDS.find((candidate) => candidate === part));
  const known = members.filter(
    (member): member is RailRegionId => member !== undefined,
  );
  if (known.length !== members.length || known.length < 2) return null;
  return new Set(known).size === known.length ? known : null;
}

/** The stack this panel belongs to in a normalized rail, or `null`. */
export function railStackOf(
  rail: ReadonlyArray<RailEntry>,
  regionId: RailRegionId,
): {
  readonly id: string;
  readonly members: ReadonlyArray<RailRegionId>;
} | null {
  for (const entry of rail) {
    if (entry.kind !== "stack") continue;
    const members = railStackMembers(entry.id);
    if (members?.includes(regionId) === true) return { id: entry.id, members };
  }
  return null;
}

/**
 * The shipped rail: the nine panels in order, no dividers (L-155), and exactly
 * one stack - Agents with Artifacts (L-166).
 *
 * That pair is the one the shipped sidebar drew together, and the owner's
 * objection was to the seven default dividers rather than to the two panels
 * sharing the body.
 */
export const DEFAULT_RAIL: ReadonlyArray<RailEntry> = [
  { kind: "panel", id: "railAgents" },
  { kind: "stack", id: railStackId(["railAgents", "railArtifacts"]) },
  ...RAIL_REGION_IDS.slice(1).map((id): RailEntry => ({ kind: "panel", id })),
];

/** The `dividerSeq` the shipped rail has used up, so the first one is `divider:1`. */
export const DEFAULT_RAIL_DIVIDER_SEQ = 0;

/**
 * The panels the rail draws, in its own order, with the hidden ones dropped.
 *
 * THE visibility filter for the sidebar (R5R-05): the rail's icon column, the
 * body's choice of panel and the PR retention all ask it, so a new rule about
 * which panels are drawn is applied in one place rather than in three copies
 * of "walk the rail, drop the dividers, drop the hidden".
 */
export function visibleRailPanelIds(
  rail: ReadonlyArray<RailEntry>,
  isVisible: (panelId: LeftPanelId) => boolean,
): ReadonlyArray<LeftPanelId> {
  return rail.flatMap((entry): LeftPanelId[] => {
    if (entry.kind !== "panel") return [];
    const panelId = PANEL_BY_RAIL_REGION[entry.id];
    return isVisible(panelId) ? [panelId] : [];
  });
}

/**
 * One thing a rail SURFACE draws: a panel, a divider, or a stack's one icon,
 * the top member's, named for every member (L-181). The three surfaces that draw the rail - the epic
 * sidebar's column, the sample scene's copy of it and the preset card's
 * miniature - walk this rather than `arrangement.rail` directly.
 *
 * The visibility filter is applied HERE rather than by each surface, which is
 * what makes "a hidden panel drops out of its stack for display, and a lone
 * visible partner stands alone" one rule instead of three (L-166). The member
 * itself stays in the model: hiding a panel is not unstacking it, and showing
 * it again puts it back.
 */
export type RailDisplayEntry =
  | { readonly kind: "panel"; readonly id: RailRegionId }
  | { readonly kind: "divider"; readonly id: string }
  | {
      readonly kind: "stack";
      readonly id: string;
      /** The visible members, in order: always two or more. */
      readonly members: ReadonlyArray<RailRegionId>;
    };

export function railDisplayEntries(
  rail: ReadonlyArray<RailEntry>,
  isVisible: (regionId: RailRegionId) => boolean,
): ReadonlyArray<RailDisplayEntry> {
  const entries: RailDisplayEntry[] = [];
  for (const entry of rail) {
    if (entry.kind === "divider") {
      entries.push({ kind: "divider", id: entry.id });
      continue;
    }
    if (entry.kind === "stack" || !isVisible(entry.id)) continue;
    const stack = railStackOf(rail, entry.id);
    if (stack === null) {
      entries.push({ kind: "panel", id: entry.id });
      continue;
    }
    const members = stack.members.filter(isVisible);
    // Drawn once, at its first visible member; the rest are inside it.
    if (members[0] !== entry.id) continue;
    entries.push(
      members.length >= 2
        ? { kind: "stack", id: stack.id, members }
        : { kind: "panel", id: entry.id },
    );
  }
  return entries;
}

/**
 * The panels the sidebar body draws together for a stacked panel, in rail
 * order, or just the one it draws when the panel stands alone.
 *
 * Read off {@link railDisplayEntries} rather than off the rail directly, so
 * the body and the rail cannot disagree about what a stack is right now: the
 * same hidden panel that leaves the stack's name leaves the split.
 */
export function railStackMembersFor(
  rail: ReadonlyArray<RailEntry>,
  regionId: RailRegionId,
  isVisible: (candidate: RailRegionId) => boolean,
): ReadonlyArray<RailRegionId> {
  for (const entry of railDisplayEntries(rail, isVisible)) {
    if (entry.kind === "stack" && entry.members.includes(regionId))
      return entry.members;
  }
  return [regionId];
}

/**
 * Where "Add divider" puts a new one (L-159): immediately before the last
 * panel, never after it.
 *
 * Appending was right while an edge divider was inert and the gesture that
 * mattered was dragging it into place. Under L-155 a divider is a spacer the
 * user adds to SEE, and one past the last icon in a `justify-start` column
 * spaces nothing, so the press reads as a no-op and the user presses again.
 */
export function railDividerInsertIndex(rail: ReadonlyArray<RailEntry>): number {
  const lastPanel = rail.findLast((entry) => entry.kind === "panel");
  if (lastPanel === undefined) return rail.length;
  // Never between a stack's members: a divider there would break the join the
  // user made rather than space two icons apart, so when the last panel is in
  // a stack the insert lands before the whole stack (L-166).
  const stack = railStackOf(rail, lastPanel.id);
  const before = stack === null ? lastPanel.id : stack.members[0];
  return rail.findIndex(
    (entry) => entry.kind === "panel" && entry.id === before,
  );
}

/** Two rails holding the same entries in the same order. */
export function areRailsEqual(
  left: ReadonlyArray<RailEntry>,
  right: ReadonlyArray<RailEntry>,
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return entry.kind === other.kind && entry.id === other.id;
    })
  );
}

/**
 * A stored panel ORDER read back as a rail, with no dividers.
 *
 * The shape a persisted record from another store has is a list of ids this
 * build may not know (the L-49 carry), so an unknown id is dropped and
 * `normalizeRail` puts back whatever the record never named.
 */
export function railFromPanelIdOrder(
  panelIds: ReadonlyArray<string>,
): ReadonlyArray<RailEntry> {
  return normalizeRail(
    panelIds.flatMap((panelId): RailEntry[] => {
      const regionId = railRegionForPanelId(panelId);
      return regionId === null ? [] : [{ kind: "panel", id: regionId }];
    }),
  );
}

function railRegionForPanelId(panelId: string): RailRegionId | null {
  const match = Object.entries(RAIL_REGION_BY_PANEL).find(
    ([candidate]) => candidate === panelId,
  );
  return match === undefined ? null : match[1];
}

/**
 * Every panel this build knows, exactly once, in the stored order, with a
 * panel the stored rail never named re-inserted beside its canonical
 * neighbours rather than appended - the rail's `mergeOrder`, with dividers
 * carried along.
 *
 * Dividers keep their positions and their ids; a duplicate id is dropped,
 * because one divider drawn twice is not a shape the rail has.
 *
 * Stacks are re-placed rather than carried (L-166, L-181). What a stack IS is
 * the members its id names, so the stacks are read off the input first, the
 * panels and dividers are normalised without them, and each stack is put back
 * as the runs of its members that still stand side by side, in the order they
 * now stand in. That is what makes every rule about a stack a consequence of
 * one pass rather than separate guards: a member dragged away leaves (a
 * two-member stack dissolves), a divider or another panel moved between
 * members splits the stack where it landed, reordering members within a stack
 * keeps it, an id this build cannot read drops, and no panel is in two stacks
 * because a panel already claimed cannot be claimed again. Where the stored
 * entry happened to SIT says nothing, so a record that misplaced it is
 * repaired rather than losing a join the user made.
 */
export function normalizeRail(
  rail: ReadonlyArray<RailEntry>,
): ReadonlyArray<RailEntry> {
  return withRailStacks(normalizedPanelsAndDividers(rail), railJoins(rail));
}

/**
 * The member lists the input's stacks name, in the order the stacks appear.
 * An id this build cannot read - a hand-edited record, a panel the build has
 * retired - names nothing and is dropped.
 */
function railJoins(
  rail: ReadonlyArray<RailEntry>,
): ReadonlyArray<ReadonlyArray<RailRegionId>> {
  return rail.flatMap((entry): ReadonlyArray<ReadonlyArray<RailRegionId>> => {
    if (entry.kind !== "stack") return [];
    const members = railStackMembers(entry.id);
    return members === null ? [] : [members];
  });
}

function normalizedPanelsAndDividers(
  rail: ReadonlyArray<RailEntry>,
): ReadonlyArray<RailEntry> {
  const seenPanels = new Set<RailRegionId>();
  const seenDividers = new Set<string>();
  const entries: RailEntry[] = [];
  for (const entry of rail) {
    if (entry.kind === "stack") continue;
    if (entry.kind === "divider") {
      if (!entry.id.startsWith(DIVIDER_ID_PREFIX)) continue;
      if (seenDividers.has(entry.id)) continue;
      seenDividers.add(entry.id);
      entries.push(entry);
      continue;
    }
    if (!RAIL_REGION_IDS.includes(entry.id)) continue;
    if (seenPanels.has(entry.id)) continue;
    seenPanels.add(entry.id);
    entries.push(entry);
  }
  for (const [index, regionId] of RAIL_REGION_IDS.entries()) {
    if (seenPanels.has(regionId)) continue;
    const precedingPanels = RAIL_REGION_IDS.slice(0, index).filter(
      (candidate) => seenPanels.has(candidate),
    );
    const anchor = precedingPanels.at(-1);
    const anchorIndex =
      anchor === undefined
        ? -1
        : entries.findIndex(
            (entry) => entry.kind === "panel" && entry.id === anchor,
          );
    entries.splice(anchorIndex + 1, 0, { kind: "panel", id: regionId });
    seenPanels.add(regionId);
  }
  return entries;
}

/**
 * The surviving stacks put back, each after its first member.
 *
 * Every maximal run of a stack's members standing side by side, in any order,
 * is a stack of its own, re-minted for the order the members now stand in: a
 * stack is a view group, and reordering members within it is how the user
 * picks which panel sits on top.
 *
 * A stack has no cap (L-181). It had one of four, so each section kept three
 * rows at the window's 600px minimum height, but the sidebar's groups never
 * had one and users stack more: the split shrinks each section toward its
 * header, and a section's own body scrolls. All nine 36px headers fit the
 * minimum height's ~460px body.
 */
function withRailStacks(
  entries: ReadonlyArray<RailEntry>,
  joins: ReadonlyArray<ReadonlyArray<RailRegionId>>,
): ReadonlyArray<RailEntry> {
  const claimed = new Set<RailRegionId>();
  const stackByFirst = new Map<RailRegionId, ReadonlyArray<RailRegionId>>();
  for (const members of joins) {
    let run: RailRegionId[] = [];
    const close = (): void => {
      if (run.length >= 2) {
        for (const member of run) claimed.add(member);
        stackByFirst.set(run[0], run);
      }
      run = [];
    };
    for (const entry of entries) {
      if (
        entry.kind === "panel" &&
        members.includes(entry.id) &&
        !claimed.has(entry.id)
      ) {
        run.push(entry.id);
        continue;
      }
      close();
    }
    close();
  }
  return entries.flatMap((entry): RailEntry[] => {
    if (entry.kind !== "panel") return [entry];
    const stack = stackByFirst.get(entry.id);
    if (stack === undefined) return [entry];
    return [entry, { kind: "stack", id: railStackId(stack) }];
  });
}
