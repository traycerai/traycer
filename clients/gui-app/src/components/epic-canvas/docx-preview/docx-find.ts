/**
 * In-document search for the rendered Word document, painted with the CSS
 * Custom Highlight API (the same mechanism as `lib/find-engine`, under its
 * own highlight names so a global Find pass and a document search never
 * repaint each other's ranges).
 *
 * Unlike `FindEngine`, matches may SPAN text nodes. Word splits a paragraph
 * into runs at every formatting or revision boundary - "Hel" + "lo world"
 * is an ordinary paragraph, not an edge case - and docx-preview renders each
 * run as its own `<span>`, so a per-node search would miss most phrases.
 * The engine flattens each block's text nodes into one string, searches
 * that, and maps hits back onto the nodes they cover. Blocks (paragraphs,
 * table cells) are separated by a newline so a phrase never matches across
 * a paragraph boundary.
 */
import { getHighlights } from "@/lib/find-engine/find-engine";

const MATCH_HIGHLIGHT_NAME = "traycer-docx-find-match";
const ACTIVE_HIGHLIGHT_NAME = "traycer-docx-find-active";

/** Selector for the elements whose text is searched as one unit. */
const BLOCK_SELECTOR = "p, td, th, li, h1, h2, h3, h4, h5, h6";

/** The `::highlight()` rules a stylesheet must carry for the two names above. */
export const DOCX_FIND_HIGHLIGHT_CSS = `
::highlight(${MATCH_HIGHLIGHT_NAME}) {
  background-color: color-mix(in srgb, var(--primary) 35%, transparent);
  color: inherit;
}
::highlight(${ACTIVE_HIGHLIGHT_NAME}) {
  background-color: color-mix(in srgb, var(--primary) 75%, transparent);
  color: var(--primary-foreground);
}
`;

export interface DocxFindResult {
  readonly current: number;
  readonly total: number;
}

/** One text node's place in the flattened text: its first character's offset. */
interface TextSegment {
  readonly node: Text;
  readonly start: number;
}

interface FlattenedText {
  readonly text: string;
  readonly segments: readonly TextSegment[];
}

function flattenText(root: Node): FlattenedText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (parent === null) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "STYLE" || tag === "SCRIPT") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts: string[] = [];
  const segments: TextSegment[] = [];
  let offset = 0;
  let previousBlock: Element | null = null;
  let node = walker.nextNode();
  while (node !== null) {
    const textNode = node as Text;
    const block = textNode.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    if (previousBlock !== null && block !== previousBlock) {
      parts.push("\n");
      offset += 1;
    }
    previousBlock = block;
    segments.push({ node: textNode, start: offset });
    parts.push(textNode.data);
    offset += textNode.data.length;
    node = walker.nextNode();
  }
  return { text: parts.join(""), segments };
}

/** The segment containing `offset` - the last one starting at or before it. */
function segmentAt(
  segments: readonly TextSegment[],
  offset: number,
): TextSegment {
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (segments[mid].start <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return segments[low];
}

function rangeFor(
  segments: readonly TextSegment[],
  start: number,
  end: number,
): Range {
  const startSegment = segmentAt(segments, start);
  const endSegment = segmentAt(segments, end);
  const range = new Range();
  range.setStart(startSegment.node, start - startSegment.start);
  range.setEnd(endSegment.node, end - endSegment.start);
  return range;
}

export class DocxFindEngine {
  private readonly root: Node;
  private ranges: Range[] = [];
  private activeIndex = 0;

  constructor(root: Node) {
    this.root = root;
  }

  /** Re-scans the document for `query` (case-insensitive) and paints; returns the match count. */
  search(query: string): number {
    this.clearHighlights();
    this.ranges = [];
    this.activeIndex = 0;
    if (query.length === 0) return 0;

    const { text, segments } = flattenText(this.root);
    if (segments.length === 0) return 0;
    const haystack = text.toLowerCase();
    const needle = query.toLowerCase();
    let hit = haystack.indexOf(needle);
    while (hit !== -1) {
      this.ranges.push(rangeFor(segments, hit, hit + needle.length));
      hit = haystack.indexOf(needle, hit + needle.length);
    }
    this.paint();
    return this.ranges.length;
  }

  next(): void {
    if (this.ranges.length === 0) return;
    this.activeIndex = (this.activeIndex + 1) % this.ranges.length;
    this.paint();
  }

  previous(): void {
    if (this.ranges.length === 0) return;
    this.activeIndex =
      (this.activeIndex - 1 + this.ranges.length) % this.ranges.length;
    this.paint();
  }

  result(): DocxFindResult | null {
    if (this.ranges.length === 0) return null;
    return { current: this.activeIndex + 1, total: this.ranges.length };
  }

  scrollActiveIntoView(): void {
    if (this.ranges.length === 0) return;
    const range = this.ranges[this.activeIndex];
    range.startContainer.parentElement?.scrollIntoView({
      block: "center",
      inline: "nearest",
    });
  }

  dispose(): void {
    this.clearHighlights();
    this.ranges = [];
  }

  private paint(): void {
    const registry = getHighlights();
    if (registry === null) return;
    const others = this.ranges.filter((_, index) => index !== this.activeIndex);
    if (others.length > 0) {
      registry.set(MATCH_HIGHLIGHT_NAME, new Highlight(...others));
    } else {
      registry.delete(MATCH_HIGHLIGHT_NAME);
    }
    if (this.ranges.length > 0) {
      const active = this.ranges[this.activeIndex];
      registry.set(ACTIVE_HIGHLIGHT_NAME, new Highlight(active));
    } else {
      registry.delete(ACTIVE_HIGHLIGHT_NAME);
    }
  }

  private clearHighlights(): void {
    const registry = getHighlights();
    if (registry === null) return;
    registry.delete(MATCH_HIGHLIGHT_NAME);
    registry.delete(ACTIVE_HIGHLIGHT_NAME);
  }
}
