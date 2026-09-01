/**
 * The one placement decision (plan §5.1 steps 1-7; decisions C3-C7, C10).
 *
 * Pure: everything it reads is an argument, so the whole placement contract is
 * table-testable and the executor stays a dumb dispatcher.
 */
import { findPaneTabForRef } from "@/stores/epics/canvas/actions";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import type { TilePane } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import { tilePlacementForCategory } from "@/stores/settings/settings-store";
import {
  tileCategoryOf,
  type ExplicitTilePlacement,
  type BrowserTilePlacement,
  type TileCategory,
  type TileOpenGesture,
  type TileOpenIntent,
  type TileOpenMode,
  type TileOpenModifiers,
  type TileOpenPlan,
  type TilePlacementSettings,
} from "./intent";

const NO_MODIFIERS: TileOpenModifiers = {
  shift: false,
  alt: false,
  middle: false,
};

/** Step 3 (C4). Middle-click and host pushes are background; a single click
 * previews; everything deliberate is permanent. */
function resolveMode(
  gesture: TileOpenGesture,
  modifiers: TileOpenModifiers,
): TileOpenMode {
  if (gesture === "host" || modifiers.middle) return "background";
  return gesture === "single" ? "preview" : "permanent";
}

/** Step 4 (C3, C4). Setting for the category, then `shift` forces a split and
 * `alt` inverts tab<->split. `pip` is untouched by `alt` - it inverts the two
 * placements it names, not "whatever is configured". */
function resolvePlacement(
  settings: TilePlacementSettings,
  category: TileCategory,
  modifiers: TileOpenModifiers,
): BrowserTilePlacement {
  const configured = tilePlacementForCategory(settings, category);
  const shifted = modifiers.shift ? "split" : configured;
  if (!modifiers.alt) return shifted;
  if (shifted === "tab") return "split";
  if (shifted === "split") return "tab";
  return shifted;
}

/**
 * How recently `category` was looked at inside one pane: the smallest
 * `activationHistory` index among its same-category tabs (0 = the pane's
 * current tab). `null` when the pane hosts none.
 */
function categoryRecency(
  canvas: EpicCanvasState,
  pane: TilePane,
  category: TileCategory,
): number | null {
  let best: number | null = null;
  for (const instanceId of pane.tabInstanceIds) {
    const ref = canvas.tilesByInstanceId[instanceId];
    if (ref === undefined || tileCategoryOf(ref) !== category) continue;
    const index = pane.activationHistory.indexOf(instanceId);
    const rank = index === -1 ? pane.activationHistory.length : index;
    if (best === null || rank < best) best = rank;
  }
  return best;
}

/**
 * Step 6 (C5): the most recently active pane already hosting this category.
 *
 * ponytail: the store keeps no cross-pane activation order - only
 * `activePaneId` and a per-pane tab `activationHistory` - so recency across
 * panes is approximated by how recent the category is WITHIN each pane, with
 * the active pane winning outright. Swap in a real pane-activation history if
 * this ever picks wrong.
 */
function affinityPaneId(
  canvas: EpicCanvasState,
  category: TileCategory,
): string | null {
  let bestId: string | null = null;
  let bestRank = 0;
  for (const pane of collectPanes(canvas.root)) {
    const rank = categoryRecency(canvas, pane, category);
    if (rank === null) continue;
    if (pane.id === canvas.activePaneId) return pane.id;
    if (bestId === null || rank < bestRank) {
      bestId = pane.id;
      bestRank = rank;
    }
  }
  return bestId;
}

/** The pane an unanchored open lands in: the active one, else the first. */
function anchorPaneId(canvas: EpicCanvasState): string | null {
  if (canvas.root === null) return null;
  if (
    canvas.activePaneId !== null &&
    findPaneById(canvas.root, canvas.activePaneId) !== null
  ) {
    return canvas.activePaneId;
  }
  return collectPanes(canvas.root).at(0)?.id ?? null;
}

/**
 * Steps 4a + 5 (C7, C10): a placement the caller already decided. A single-tile
 * viewport has nowhere to split into, and a background open never creates
 * geometry, so both degrade a split to a tab in the pane that was named.
 */
function resolveExplicitPlan(
  tabId: string,
  placement: ExplicitTilePlacement,
  mode: TileOpenMode,
  singleTileViewport: boolean,
): TileOpenPlan {
  if (placement.kind === "tab") {
    return {
      kind: "open-in-pane",
      tabId,
      paneId: placement.paneId,
      mode,
      index: placement.index,
    };
  }
  if (singleTileViewport || mode === "background") {
    return {
      kind: "open-in-pane",
      tabId,
      paneId: placement.paneId,
      mode,
      index: null,
    };
  }
  return {
    kind: "split",
    tabId,
    paneId: placement.paneId,
    edge: placement.edge,
    mode,
  };
}

/** Steps 4b-7: the configured placement, once no caller has overridden it. */
function resolveConfiguredPlan(args: {
  readonly canvas: EpicCanvasState;
  readonly settings: TilePlacementSettings;
  readonly category: TileCategory;
  readonly modifiers: TileOpenModifiers;
  readonly tabId: string;
  readonly mode: "preview" | "permanent";
  readonly singleTileViewport: boolean;
}): TileOpenPlan {
  const { canvas, category, mode, tabId } = args;
  const configured = resolvePlacement(args.settings, category, args.modifiers);
  // 5. `pip` is browser-only; anything else asking for it splits instead.
  const placement =
    configured === "pip" && category !== "browser" ? "split" : configured;

  if (args.singleTileViewport) {
    return {
      kind: "open-in-pane",
      tabId,
      paneId: anchorPaneId(canvas),
      mode,
      index: null,
    };
  }
  if (placement === "pip") return { kind: "pip", tabId };

  // 6. Split: group into the category's pane when there is one, else split
  // right of the anchor.
  if (placement === "split") {
    const grouped = affinityPaneId(canvas, category);
    if (grouped !== null) {
      return {
        kind: "open-in-pane",
        tabId,
        paneId: grouped,
        mode,
        index: null,
      };
    }
    const anchor = anchorPaneId(canvas);
    if (anchor !== null) {
      return { kind: "split", tabId, paneId: anchor, edge: "right", mode };
    }
  }

  // 7. Tab (and the empty canvas, which has no pane to split off).
  return {
    kind: "open-in-pane",
    tabId,
    paneId: anchorPaneId(canvas),
    mode,
    index: null,
  };
}

export function resolveTileOpen(input: {
  readonly intent: TileOpenIntent;
  readonly settings: TilePlacementSettings;
  readonly canvas: EpicCanvasState;
  readonly resolveTargetTabForEpic: (epicId: string) => string;
  readonly singleTileViewport: boolean;
}): TileOpenPlan {
  const { canvas, intent, settings, singleTileViewport } = input;

  // 1. Target tab.
  const tabId =
    "tabId" in intent.target
      ? intent.target.tabId
      : input.resolveTargetTabForEpic(intent.target.epicId);

  const modifiers = intent.modifiers ?? NO_MODIFIERS;
  const category = tileCategoryOf(intent.node);

  // 2. Dedupe (C6). A middle-click on a browser node is explicitly asking for
  // a SECOND tab of that URL, so it never dedupes (B4).
  const bypassDedupe = modifiers.middle && category === "browser";
  if (intent.dedupe && !bypassDedupe) {
    const existing = findPaneTabForRef(canvas, intent.node);
    if (existing !== null) {
      return {
        kind: "focus-existing",
        tabId,
        paneId: existing.pane.id,
        instanceId: existing.instanceId,
      };
    }
  }

  // 3. Mode.
  const mode = resolveMode(intent.gesture, modifiers);

  // 4a. Explicit placement wins over the setting (C7).
  if (intent.placement !== null) {
    return resolveExplicitPlan(
      tabId,
      intent.placement,
      mode,
      singleTileViewport,
    );
  }

  // A background open never creates geometry: `split` and `pip` carry no
  // background mode by construction. Grouping still happens for the host
  // paths, which pass the session's pane as an explicit placement (§5.3).
  if (mode === "background") {
    return {
      kind: "open-in-pane",
      tabId,
      paneId: anchorPaneId(canvas),
      mode,
      index: null,
    };
  }

  return resolveConfiguredPlan({
    canvas,
    settings,
    category,
    modifiers,
    tabId,
    mode,
    singleTileViewport,
  });
}
