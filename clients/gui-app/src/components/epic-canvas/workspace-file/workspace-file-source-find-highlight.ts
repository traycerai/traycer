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
 * The concatenated text content of the code container equals the file content
 * verbatim for both render paths - the plain `<pre>` fallback (a single text
 * node) and Shiki output (line spans joined by `\n` text nodes) - so a flat
 * walk of the container's text nodes yields a faithful offset map.
 */

const FIND_HIGHLIGHT_NAME_PREFIX = "traycer-source-find-match";
const FIND_HIGHLIGHT_ACTIVE_NAME_PREFIX = "traycer-source-find-match-active";

let nextHighlightId = 1;

export interface SourceFindRange {
  readonly offset: number;
  readonly length: number;
}

interface SupportedHighlightsAPI {
  set(name: string, highlight: Highlight): void;
  delete(name: string): void;
}

interface SourceHighlightEntry {
  readonly matchName: string;
  readonly activeName: string;
  readonly styleElement: HTMLStyleElement;
}

const sourceHighlightEntries = new WeakMap<HTMLElement, SourceHighlightEntry>();

function getHighlights(): SupportedHighlightsAPI | null {
  if (typeof CSS === "undefined") return null;
  if (typeof Highlight === "undefined") return null;
  const reg = (CSS as { highlights: SupportedHighlightsAPI | undefined })
    .highlights;
  return reg ?? null;
}

function getOrCreateHighlightEntry(root: HTMLElement): SourceHighlightEntry {
  const existing = sourceHighlightEntries.get(root);
  if (existing !== undefined) return existing;
  const id = nextHighlightId;
  nextHighlightId += 1;
  const entry: SourceHighlightEntry = {
    matchName: `${FIND_HIGHLIGHT_NAME_PREFIX}-${id}`,
    activeName: `${FIND_HIGHLIGHT_ACTIVE_NAME_PREFIX}-${id}`,
    styleElement: createHighlightStyleElement(root.ownerDocument, id),
  };
  sourceHighlightEntries.set(root, entry);
  return entry;
}

function createHighlightStyleElement(
  doc: Document,
  id: number,
): HTMLStyleElement {
  const matchName = `${FIND_HIGHLIGHT_NAME_PREFIX}-${id}`;
  const activeName = `${FIND_HIGHLIGHT_ACTIVE_NAME_PREFIX}-${id}`;
  const style = doc.createElement("style");
  style.dataset.traycerSourceFindHighlight = matchName;
  style.textContent = [
    `::highlight(${matchName}) {`,
    "background-color: color-mix(in srgb, var(--primary) 35%, transparent);",
    "color: inherit;",
    "}",
    `::highlight(${activeName}) {`,
    "background-color: color-mix(in srgb, var(--primary) 75%, transparent);",
    "color: var(--primary-foreground);",
    "}",
  ].join("\n");
  doc.head.append(style);
  return style;
}

interface TextNodeSpan {
  readonly node: Text;
  readonly start: number;
}

function collectTextSpans(root: HTMLElement): readonly TextNodeSpan[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const spans: TextNodeSpan[] = [];
  let offset = 0;
  let node = walker.nextNode() as Text | null;
  while (node !== null) {
    spans.push({ node, start: offset });
    offset += node.data.length;
    node = walker.nextNode() as Text | null;
  }
  return spans;
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
  const entry = sourceHighlightEntries.get(root);
  if (entry === undefined) return;
  const reg = getHighlights();
  if (reg !== null) {
    reg.delete(entry.matchName);
    reg.delete(entry.activeName);
  }
  entry.styleElement.remove();
  sourceHighlightEntries.delete(root);
}

/**
 * Paints every match span under the code container, with the active span in
 * the stronger `*-active` highlight so navigation between same-line matches is
 * visible. No-ops (clearing any prior paint) when the Custom Highlight API is
 * unavailable so unsupported browsers fall back to the gutter line marker.
 */
export function paintSourceFindHighlights(args: {
  readonly root: HTMLElement;
  readonly matches: readonly SourceFindRange[];
  readonly activeOffset: number;
}): void {
  const reg = getHighlights();
  if (reg === null) return;
  const entry = getOrCreateHighlightEntry(args.root);

  const spans = collectTextSpans(args.root);
  const inactive: Range[] = [];
  let active: Range | null = null;
  for (const match of args.matches) {
    const domRange = buildRange(spans, match);
    if (domRange === null) continue;
    if (match.offset === args.activeOffset && active === null) {
      active = domRange;
    } else {
      inactive.push(domRange);
    }
  }

  if (inactive.length > 0) {
    reg.set(entry.matchName, new Highlight(...inactive));
  } else {
    reg.delete(entry.matchName);
  }
  if (active !== null) {
    reg.set(entry.activeName, new Highlight(active));
  } else {
    reg.delete(entry.activeName);
  }
}
