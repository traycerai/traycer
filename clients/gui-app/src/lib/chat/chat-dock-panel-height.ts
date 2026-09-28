/**
 * How tall an opened compact-dock pill panel is ALLOWED to stand, as a share
 * of the CHAT PANE (L-142, L-145, L-151).
 *
 * A CAP rather than a height (L-151): the panel is as tall as whatever the
 * open pill has to show, up to this share, and its body scrolls past it. Five
 * todo rows no longer open a third of the pane with nothing in the other two
 * thirds. Everything below still describes the same number - the handle sets
 * it, the store remembers it, the separator's ARIA reports it - because the
 * cap is the only thing a user ever chooses; the height is the content's.
 *
 * A share of the PANE rather than of the window: on the epic canvas a chat is
 * a tile that may be a third of the window tall, so a window-relative third
 * buries that tile's entire transcript. The pane is the box that bounds the
 * transcript, the dock and the composer - `epic-canvas/renderers/chat-tile.tsx`
 * marks it `data-chat-pane` and makes it a size container - and it is the same
 * element whether the chat is one tile among several or a full tab.
 *
 * In this module rather than beside the component that draws it because the
 * settings store clamps with it too, and the store may not import a component.
 */

/** About a third of the chat pane - the most an opened pill takes by default. */
export const CHAT_DOCK_PANEL_DEFAULT_HEIGHT_RATIO = 0.33;
/** Small enough to be worth closing instead, and still two or three rows. */
export const CHAT_DOCK_PANEL_MIN_HEIGHT_RATIO = 0.12;
/** Half the pane. Past this the panel buries the transcript it belongs to. */
export const CHAT_DOCK_PANEL_MAX_HEIGHT_RATIO = 0.5;

/**
 * The marker the chat pane carries, so the panel can find the box its share is
 * a share OF without knowing anything else about the tile around it.
 */
export const CHAT_PANE_ATTRIBUTE = "data-chat-pane";

/**
 * The floor a share alone cannot hold: on a very short pane 12% is a scrollbar
 * with nothing beside it. Capped by the half-pane rule below, so this can
 * never push the panel over the transcript it belongs to.
 *
 * It is a floor under the CAP, never under the panel: a pill with one row to
 * show draws one row, whatever this says. It only stops a tiny pane from
 * making the cap itself unusable.
 */
const CHAT_DOCK_PANEL_FLOOR_CSS = "6rem";

/**
 * The stored share, made safe to draw with.
 *
 * Clamped on read as well as on write: a record rehydrated from another
 * version of this app, or hand-edited, must not be able to put a pane-high
 * panel on top of the composer.
 */
export function clampChatDockPanelHeightRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return CHAT_DOCK_PANEL_DEFAULT_HEIGHT_RATIO;
  return Math.min(
    CHAT_DOCK_PANEL_MAX_HEIGHT_RATIO,
    Math.max(CHAT_DOCK_PANEL_MIN_HEIGHT_RATIO, ratio),
  );
}

/**
 * The custom property the panel body's `max-height` reads.
 *
 * A property rather than an inline `max-height`, because the value is a formula in
 * units this app's own test environment cannot parse: jsdom drops a `min()` of
 * `cqh` from `style.height` entirely, so an inline height would be invisible
 * to every test and to anyone debugging one. A custom property is stored
 * verbatim by both, and the class that reads it stays a single token.
 */
export const CHAT_DOCK_PANEL_HEIGHT_PROPERTY = "--chat-dock-panel-height";

/**
 * The CAP on the panel body's height, from an already-clamped percentage.
 *
 * The body carries it as `max-height` and takes its height from its content,
 * so this is the point at which the body stops growing and starts scrolling
 * (L-151). It is not the height of anything.
 *
 * `cqh` is a share of the nearest ancestor SIZE container, which is the chat
 * pane; the panel's own `@container` is an inline-size container, which is not
 * eligible for a block-axis unit and is skipped. A mount with no pane above it
 * at all (the landing composer's dock, a test) falls back to the small
 * viewport, which is what every share here meant before L-145.
 *
 * `max()` keeps the cap usable on a short pane and `min()` keeps that floor
 * from crossing the half-pane rule, so a pane too short for the floor lowers
 * the cap rather than being covered by the panel - and the body scrolls, as
 * it already does at every other size.
 */
export function chatDockPanelHeightCss(percent: number): string {
  const cap = Math.round(CHAT_DOCK_PANEL_MAX_HEIGHT_RATIO * 100);
  return `min(${cap}cqh, max(${CHAT_DOCK_PANEL_FLOOR_CSS}, ${percent}cqh))`;
}

/**
 * The pixel height a drag maps against: the chat pane the handle sits in, or
 * the window where there is no pane - the same fallback `cqh` itself takes.
 *
 * Read ONCE per drag, at pointer down, so the 1:1 drag loop stays free of
 * layout reads and nothing observes the pane while it is moving.
 */
export function chatDockPanelPaneHeight(from: Element | null): number {
  const pane = from === null ? null : from.closest(`[${CHAT_PANE_ATTRIBUTE}]`);
  const height = pane === null ? 0 : pane.getBoundingClientRect().height;
  return height > 0 ? height : window.innerHeight;
}
