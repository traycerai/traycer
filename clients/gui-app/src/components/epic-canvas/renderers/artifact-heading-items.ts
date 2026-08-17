/**
 * Pure logic for the artifact heading minimap: the read-only heading walk, the
 * scroller-relative offset cache, and current-section resolution.
 *
 * Read-only is load-bearing. The artifact body is a collaborative `Y.Doc`, so
 * anything that stamped ids onto headings (what `@tiptap/extension-table-of-
 * contents` does via `appendTransaction`) would be a persisted mutation fired
 * by every client on every doc change. Nothing here touches the document.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/** The rail shows the document skeleton, not every subsection. */
export const ARTIFACT_HEADING_MAX_LEVEL = 2;
/** A single tick is noise, not a map. */
export const ARTIFACT_HEADING_MIN_ITEMS = 2;
/** Long enough for a wrapped two-line row in a 20rem card. */
export const ARTIFACT_HEADING_LABEL_MAX_CHARS = 120;

export type ArtifactHeadingLevel = 1 | 2;

export interface ArtifactHeadingItem {
  /**
   * ProseMirror position. Ephemeral by nature - it shifts under edits above the
   * heading - which is fine because the list is rebuilt on every doc change.
   * Callers holding focus must preserve the active item deliberately rather
   * than relying on this to be stable.
   */
  readonly id: number;
  /**
   * Render key: level, label and how many identical headings preceded it.
   * Position would be the obvious key and is the wrong one - it changes under
   * every edit above the heading, remounting rows the reader may be pointing
   * at. Two headings with the same text are disambiguated by occurrence.
   */
  readonly key: string;
  readonly level: ArtifactHeadingLevel;
  readonly label: string;
}

function isArtifactHeadingLevel(level: number): level is ArtifactHeadingLevel {
  return level === 1 || level === 2;
}

function readHeadingLevel(node: ProseMirrorNode): number | null {
  const level: unknown = node.attrs["level"];
  return typeof level === "number" ? level : null;
}

/**
 * Collapses whitespace and caps the label. Unlike the chat rail's preview this
 * runs over heading text only, so a bounded-scan walk would be premature - a
 * heading long enough to matter does not exist in practice, and the cap below
 * bounds what is retained either way.
 */
export function compactArtifactHeadingLabel(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= ARTIFACT_HEADING_LABEL_MAX_CHARS) return compact;
  return `${compact.slice(0, ARTIFACT_HEADING_LABEL_MAX_CHARS).trimEnd()}…`;
}

/**
 * Every non-empty `h1`/`h2` in document order. Empty headings are skipped: a
 * freshly seeded artifact carries an empty leading `# ` title line
 * (`seedArtifactTitleHeading`), which would otherwise show as a blank row.
 */
export function deriveArtifactHeadingItems(
  doc: ProseMirrorNode,
): ReadonlyArray<ArtifactHeadingItem> {
  const items: ArtifactHeadingItem[] = [];
  const occurrences = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    const level = readHeadingLevel(node);
    if (level === null || !isArtifactHeadingLevel(level)) return false;
    const label = compactArtifactHeadingLabel(node.textContent);
    if (label.length === 0) return false;
    const signature = `${level}:${label}`;
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    items.push({ id: pos, key: `${signature}#${occurrence}`, level, label });
    // Headings hold inline content only - no nested heading to descend into.
    return false;
  });
  return items;
}

/**
 * What the rail renders: the heading skeleton with no document positions in
 * it. Positions shift under every edit, so keeping them out of the rendered
 * model is what lets the rail ignore typing that does not change the outline.
 */
export interface ArtifactHeadingOutlineEntry {
  readonly key: string;
  readonly level: ArtifactHeadingLevel;
  readonly label: string;
}

export function toArtifactHeadingOutline(
  items: ReadonlyArray<ArtifactHeadingItem>,
): ReadonlyArray<ArtifactHeadingOutlineEntry> {
  return items.map((item) => ({
    key: item.key,
    level: item.level,
    label: item.label,
  }));
}

/** The key encodes level, label and occurrence, so it is the whole identity. */
export function sameArtifactHeadingOutline(
  left: ReadonlyArray<ArtifactHeadingOutlineEntry>,
  right: ReadonlyArray<ArtifactHeadingOutlineEntry>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry.key === right[index].key);
}

export interface ArtifactHeadingViewLike {
  nodeDOM(pos: number): Node | null;
}

/**
 * Scroller-relative top of every heading, in the order the positions are given.
 *
 * Measured as `headingRect.top - scrollerRect.top + scroller.scrollTop` rather
 * than `offsetTop`: offset parents inside the editor (tables, node views, the
 * comment decoration layer) are not guaranteed to be the scroller, so
 * `offsetTop` silently measures against the wrong box.
 *
 * A heading with no resolvable element yet (node view still mounting) inherits
 * the previous heading's top, keeping the array monotonic and the same length
 * as `positions` so index-keyed lookups never shift.
 */
export function measureArtifactHeadingTops(input: {
  readonly view: ArtifactHeadingViewLike;
  readonly scroller: HTMLElement;
  readonly positions: ReadonlyArray<number>;
}): ReadonlyArray<number> {
  const scrollerTop = input.scroller.getBoundingClientRect().top;
  const scrollTop = input.scroller.scrollTop;
  const tops: number[] = [];
  for (const pos of input.positions) {
    const element = input.view.nodeDOM(pos);
    if (!(element instanceof HTMLElement)) {
      tops.push(tops.length === 0 ? 0 : tops[tops.length - 1]);
      continue;
    }
    tops.push(element.getBoundingClientRect().top - scrollerTop + scrollTop);
  }
  return tops;
}

/**
 * How far below the viewport top a heading must sit before the reader is
 * considered to have left it. Keeps the current section highlighted while its
 * heading scrolls off, instead of handing over the moment the next heading's
 * first pixel appears.
 */
export const ARTIFACT_HEADING_ACTIVATION_OFFSET = 96;

/**
 * The section the reader is inside - the last heading whose top is at or above
 * the activation line, i.e. the interval `[top_i, top_{i+1})` containing it.
 *
 * Interval semantics, not intersection: a heading is a 1px-tall band, so
 * "which heading is on screen" hands the highlight to the next section as soon
 * as its heading edge appears, while the reader is still in the current one.
 *
 * Content above the first heading resolves to the first item, matching how the
 * document title reads as the active entry at the top of the document. At the
 * very bottom the last item wins even if its heading never crosses the line,
 * so a short trailing section is still reachable as "current".
 */
export function resolveArtifactHeadingActiveIndex(input: {
  readonly tops: ReadonlyArray<number>;
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}): number | null {
  if (input.tops.length === 0) return null;

  const atBottom =
    input.scrollTop + input.clientHeight >= input.scrollHeight - 1;
  if (atBottom) return input.tops.length - 1;

  const activationLine = input.scrollTop + ARTIFACT_HEADING_ACTIVATION_OFFSET;
  let active = 0;
  for (let index = 0; index < input.tops.length; index += 1) {
    if (input.tops[index] > activationLine) break;
    active = index;
  }
  return active;
}

/** Breathing room above a heading the reader jumped to. */
export const ARTIFACT_HEADING_SCROLL_PADDING = 24;

/** Matches the rail's `left-3` inset. */
export const ARTIFACT_HEADING_RAIL_EDGE_INSET = 12;
export const ARTIFACT_HEADING_HIT_STRIP_MAX_WIDTH = 40;
/** Painted widths at full size; narrower gutters retain the 2:1 hierarchy. */
const ARTIFACT_HEADING_LEVEL_ONE_TICK_MAX_WIDTH = 24;
const ARTIFACT_HEADING_LEVEL_TWO_TICK_MAX_WIDTH = 12;

/**
 * Width of the transparent pointer target, capped to the real gutter between
 * the scroller's left edge and the text column.
 *
 * Measured, not derived from a content-width constant the way the chat rail
 * does it: that formula assumes a viewport-centered column and returns zero in
 * a narrow pane, whereas this scroller carries its own horizontal padding, so a
 * usable gutter exists even when the column fills the tile. Zero means no safe
 * room, and the caller makes the target inert rather than let it cover text.
 */
export function resolveArtifactHeadingHitStripWidth(input: {
  readonly contentLeft: number;
  readonly scrollerLeft: number;
}): number {
  const gutter = input.contentLeft - input.scrollerLeft;
  if (!Number.isFinite(gutter) || gutter <= 0) return 0;
  return Math.max(
    0,
    Math.min(
      ARTIFACT_HEADING_HIT_STRIP_MAX_WIDTH,
      Math.floor(gutter - ARTIFACT_HEADING_RAIL_EDGE_INSET),
    ),
  );
}

/**
 * Keeps every painted tick inside the same measured gutter as its hit target.
 *
 * The full-size 24px h1 marker used to extend past the narrow-pane gutter and
 * over artifact text even though the transparent hit target was correctly
 * capped. Scale both levels together until their normal 24px/12px widths fit;
 * zero available width naturally hides the rail when no safe gutter remains.
 */
export function resolveArtifactHeadingTickWidth(
  availableWidth: number,
  level: ArtifactHeadingLevel,
): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 0;
  const maxWidth =
    level === 1
      ? ARTIFACT_HEADING_LEVEL_ONE_TICK_MAX_WIDTH
      : ARTIFACT_HEADING_LEVEL_TWO_TICK_MAX_WIDTH;
  const scaledWidth = level === 1 ? availableWidth : availableWidth / 2;
  return Math.min(maxWidth, scaledWidth);
}
