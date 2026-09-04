/**
 * The one intent shape every tile open is expressed in, and the one plan shape
 * the resolver answers with (decisions C1-C7, C10; plan §5.1).
 *
 * Nothing here touches a store: `resolve-tile-open.ts` turns an intent plus
 * settings/canvas/viewport into a {@link TileOpenPlan}, and the executor
 * (ticket 05) is the only thing that runs one.
 */
import type { AnalyticsSource } from "@/lib/analytics";
import type { EdgeDropPosition } from "@/stores/epics/canvas/tile-tree";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/**
 * What the user did. `explicit` covers every deliberate open that is not a
 * click (button, palette, keyboard, drag-and-drop); `host` is a tile the host
 * pushed at us with no gesture behind it at all.
 */
export type TileOpenGesture = "single" | "double" | "explicit" | "host";

export interface TileOpenModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly middle: boolean;
}

/** Placement is configured per category, never per tile kind (C2, C3). */
export type TileCategory = "content" | "conversation" | "browser";

/**
 * A placement the caller already decided: a drop position, a PaneOpener's own
 * pane, an Electron popup's originating pane. Overrides the setting (C7).
 */
export type ExplicitTilePlacement =
  | {
      readonly kind: "tab";
      readonly paneId: string;
      readonly index: number | null;
    }
  | {
      readonly kind: "split";
      readonly paneId: string;
      readonly edge: EdgeDropPosition;
    };

/** Which epic canvas to open into: a header tab, or the epic behind one. */
export type TileOpenTarget =
  | { readonly tabId: string }
  | { readonly epicId: string };

export interface TileOpenIntent {
  readonly node: EpicCanvasTileRef;
  readonly target: TileOpenTarget;
  readonly gesture: TileOpenGesture;
  /** `null` for triggers with no event behind them (host, keyboard, DnD). */
  readonly modifiers: TileOpenModifiers | null;
  readonly placement: ExplicitTilePlacement | null;
  /** `false` only for the PaneOpener's "open a second view" (C6). */
  readonly dedupe: boolean;
  readonly source: AnalyticsSource;
}

/**
 * The common intent: no event modifiers, no caller-chosen placement, dedupe on.
 * Most opens are this - a literal spelling out three constants is noise. A site
 * that carries a real click, a drop position or the PaneOpener's second view
 * writes the object literal instead.
 */
export function tileIntent(
  node: EpicCanvasTileRef,
  target: TileOpenTarget,
  gesture: TileOpenGesture,
  source: AnalyticsSource,
): TileOpenIntent {
  return {
    node,
    target,
    gesture,
    modifiers: null,
    placement: null,
    dedupe: true,
    source,
  };
}

export type TileOpenMode = "preview" | "permanent" | "background";

/**
 * Where inside a pane an open lands: `mode` picks pinned / preview /
 * membership-only semantics and `index` the strip position (`null` appends).
 * One bag rather than two positional arguments - the pane openers already
 * carry `tabId`, `paneId` and the ref, and `(..., "permanent", null)` at a
 * call site says nothing about what the `null` is.
 */
export interface PaneTileOpenOptions {
  readonly mode: TileOpenMode;
  readonly index: number | null;
}

/**
 * `paneId: null` on `open-in-pane` means "no pane resolved" - the empty
 * canvas. The executor lets `openTile` seed a root pane, exactly as today.
 */
export type TileOpenPlan =
  | {
      /**
       * `promote` clears the pane's preview slot: a permanent re-open of the
       * tile that currently holds it pins the tile, exactly as the old
       * `openTile(preview: false)` dedupe hit did. `false` for a preview
       * gesture and for a hit that is not the pane's preview - promoting
       * there would pin a tile this gesture never touched.
       */
      readonly kind: "focus-existing";
      readonly tabId: string;
      readonly paneId: string;
      readonly instanceId: string;
      readonly promote: boolean;
    }
  | {
      readonly kind: "open-in-pane";
      readonly tabId: string;
      readonly paneId: string | null;
      readonly mode: TileOpenMode;
      readonly index: number | null;
    }
  | {
      readonly kind: "split";
      readonly tabId: string;
      readonly paneId: string;
      readonly edge: EdgeDropPosition;
      readonly mode: "preview" | "permanent";
    }
  | { readonly kind: "pip"; readonly tabId: string }
  /**
   * Nothing to do: a background open (host push, middle-click) whose tile is
   * already on the canvas. `openTileInBackgroundTab` was idempotent by
   * construction - it never moved focus - so re-registration must not steal
   * the active tab the way a `focus-existing` plan would.
   */
  | { readonly kind: "noop" };

/**
 * The placement category of a tile kind (C2). A `Record` over `TileKindId`
 * rather than a switch: adding a kind fails the type-check here (same trick as
 * `isTileKind`) rather than silently landing in someone else's category.
 *
 * `blank` maps to `content`. It is keyboard-only and never routed through an
 * intent (C2), so the entry exists purely to keep the record total.
 */
const TILE_CATEGORY_BY_KIND: Record<TileKindId, TileCategory> = {
  chat: "conversation",
  "terminal-agent": "conversation",
  terminal: "conversation",
  "browser-session": "browser",
  spec: "content",
  ticket: "content",
  story: "content",
  review: "content",
  "workspace-file": "content",
  "git-diff": "content",
  "snapshot-diff": "content",
  "managed-command-output": "content",
  "comm-graph": "content",
  "published-chat": "content",
  "pr-detail": "content",
  "pr-diff": "content",
  blank: "content",
};

export function tileCategoryOf(node: EpicCanvasTileRef): TileCategory {
  return TILE_CATEGORY_BY_KIND[node.type];
}

/**
 * The modifier triple behind a real click (C4). Takes the structural shape
 * rather than `React.MouseEvent` so a native `MouseEvent` and a synthetic one
 * both fit, and so a test can hand it a literal.
 */
export function modifiersFromMouseEvent(event: {
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly button: number;
}): TileOpenModifiers {
  return {
    shift: event.shiftKey,
    alt: event.altKey,
    middle: event.button === 1,
  };
}
