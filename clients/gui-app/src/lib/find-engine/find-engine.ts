import { findTextMatches } from "./find-text";
import { getHighlights, RangeHighlighter } from "./range-highlighter";
export { getHighlights } from "./range-highlighter";

const FIND_SKIP_ATTR = "data-find-skip";

export interface FindResult {
  readonly current: number;
  readonly total: number;
}

export function isFindEngineSupported(): boolean {
  return typeof window !== "undefined" && getHighlights() !== null;
}

/**
 * Marks an element subtree as off-limits to the find engine (e.g., the
 * find bar itself, modal popovers we don't want highlighted). Applied
 * via attribute so it survives React re-renders without us threading
 * refs through every consumer.
 */
export function getFindSkipAttribute(): string {
  return FIND_SKIP_ATTR;
}

export interface FindEngineOptions {
  readonly root: HTMLElement;
  readonly matchCase: boolean;
}

export class FindEngine {
  private readonly root: HTMLElement;
  private readonly matchCase: boolean;
  private ranges: Range[] = [];
  private activeIndex = 0;
  private readonly highlighter = new RangeHighlighter();

  constructor(options: FindEngineOptions) {
    this.root = options.root;
    this.matchCase = options.matchCase;
  }

  /**
   * Re-scans the DOM for `query`, replacing any previous match set.
   * Returns the new total count. Highlights are painted as a side effect.
   * Caller must then call `scrollActiveIntoView()` to bring match 1 into
   * view (kept separate so navigation calls can skip the scan).
   */
  search(query: string): number {
    this.highlighter.clear();
    this.ranges = [];
    this.activeIndex = 0;
    if (query.length === 0) return 0;

    const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (parent === null) return NodeFilter.FILTER_REJECT;
        if (parent.closest(`[${FIND_SKIP_ATTR}]`) !== null) {
          return NodeFilter.FILTER_REJECT;
        }
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode() as Text | null;
    while (node !== null) {
      for (const match of findTextMatches(node.data, query, this.matchCase)) {
        const range = new Range();
        range.setStart(node, match.offset);
        range.setEnd(node, match.offset + match.length);
        this.ranges.push(range);
      }
      node = walker.nextNode() as Text | null;
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

  getResult(): FindResult | null {
    if (this.ranges.length === 0) return null;
    return {
      current: this.activeIndex + 1,
      total: this.ranges.length,
    };
  }

  scrollActiveIntoView(): void {
    if (this.activeIndex >= this.ranges.length) return;
    const range = this.ranges[this.activeIndex];
    const node = range.startContainer;
    const target =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    target?.scrollIntoView({ block: "center", inline: "nearest" });
  }

  dispose(): void {
    this.highlighter.dispose();
    this.ranges = [];
  }

  private paint(): void {
    this.highlighter.paint(this.root, this.ranges, this.activeIndex);
  }
}
