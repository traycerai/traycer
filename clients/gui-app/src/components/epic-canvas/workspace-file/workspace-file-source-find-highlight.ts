/**
 * Source-preview text-range painting for workspace-file find.
 *
 * The markdown-preview path drives `FindEngine`, which *searches* the rendered
 * DOM itself. Source preview can't reuse that: Shiki splits a line into many
 * token `<span>`s, so a match that straddles a token boundary lives across
 * several text nodes and a per-text-node `indexOf` would miss it. The source
 * adapter therefore searches the raw file string and produces absolute
 * character offsets; this module maps those offsets back onto the rendered DOM
 * and paints them with the same CSS Custom Highlight API so multiple matches on
 * one line are individually visible and the active one stands out.
 *
 * A regular source container can be mapped with a flat text-node walk. Diffs
 * renders each source line as a sibling grid row inside its shadow root, so
 * that path inserts a virtual newline between `[data-line-index]` rows while
 * building the same raw-file offset map.
 */

import {
  getHighlights,
  RangeHighlighter,
} from "@/lib/find-engine/range-highlighter";

export interface SourceFindRange {
  readonly offset: number;
  readonly length: number;
}

const sourceHighlighters = new WeakMap<HTMLElement, RangeHighlighter>();

interface TextNodeSpan {
  readonly node: Text;
  readonly start: number;
}

function collectTextSpans(root: HTMLElement): readonly TextNodeSpan[] {
  const lineNodes = Array.from(
    root.querySelectorAll<HTMLElement>("[data-line][data-line-index]"),
  );
  if (lineNodes.length > 0) return collectLineSeparatedTextSpans(lineNodes);
  return collectFlatTextSpans(root, 0).spans;
}

function collectLineSeparatedTextSpans(
  lineNodes: readonly HTMLElement[],
): readonly TextNodeSpan[] {
  const spans: TextNodeSpan[] = [];
  let offset = 0;
  for (const line of lineNodes) {
    const collected =
      line.textContent === "\n"
        ? { spans: [], endOffset: offset }
        : collectFlatTextSpans(line, offset);
    spans.push(...collected.spans);
    // Diffs renders source lines as sibling grid rows rather than placing a
    // newline text node between them. Account for that virtual separator so
    // raw-file offsets still map to the right token nodes.
    offset = collected.endOffset + 1;
  }
  return spans;
}

function collectFlatTextSpans(
  root: HTMLElement,
  initialOffset: number,
): { readonly spans: readonly TextNodeSpan[]; readonly endOffset: number } {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    null,
  );
  const spans: TextNodeSpan[] = [];
  let offset = initialOffset;
  let node = walker.nextNode() as Text | null;
  while (node !== null) {
    spans.push({ node, start: offset });
    offset += node.data.length;
    node = walker.nextNode() as Text | null;
  }
  return { spans, endOffset: offset };
}

// Resolves an absolute character position to a (text node, in-node offset)
// pair. Positions at a node boundary resolve to the end of the earlier node,
// which is the same DOM point as the start of the next - fine for both range
// endpoints. Positions past the end clamp to the final node so a slightly
// short last text node (e.g. a trailing-newline quirk) never throws.
function resolvePoint(
  spans: readonly TextNodeSpan[],
  position: number,
): { readonly node: Text; readonly offset: number } | null {
  if (spans.length === 0) return null;
  let low = 0;
  let high = spans.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const span = spans[mid];
    if (position <= span.start + span.node.data.length) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  const span = spans[low];
  return {
    node: span.node,
    offset: Math.min(span.node.data.length, Math.max(0, position - span.start)),
  };
}

function buildRange(
  spans: readonly TextNodeSpan[],
  range: SourceFindRange,
): Range | null {
  if (range.length <= 0) return null;
  const start = resolvePoint(spans, range.offset);
  const end = resolvePoint(spans, range.offset + range.length);
  if (start === null || end === null) return null;
  const domRange = new Range();
  domRange.setStart(start.node, start.offset);
  domRange.setEnd(end.node, end.offset);
  return domRange;
}

export function clearSourceFindHighlights(root: HTMLElement): void {
  sourceHighlighters.get(root)?.dispose();
  sourceHighlighters.delete(root);
}

/** Paint token-spanning matches, preserving the source adapter's offsets. */
export function paintSourceFindHighlights(args: {
  readonly root: HTMLElement;
  readonly matches: readonly SourceFindRange[];
  readonly activeOffset: number;
}): void {
  if (getHighlights() === null) return;
  let highlighter = sourceHighlighters.get(args.root);
  if (highlighter === undefined) {
    highlighter = new RangeHighlighter();
    sourceHighlighters.set(args.root, highlighter);
  }
  const spans = collectTextSpans(args.root);
  const ranges: Range[] = [];
  let activeIndex = -1;
  for (const match of args.matches) {
    const range = buildRange(spans, match);
    if (range === null) continue;
    if (match.offset === args.activeOffset && activeIndex === -1) {
      activeIndex = ranges.length;
    }
    ranges.push(range);
  }
  highlighter.paint(args.root, ranges, activeIndex);
}
