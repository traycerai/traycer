const FIND_HIGHLIGHT_NAME = "traycer-find-match";
const FIND_HIGHLIGHT_ACTIVE_NAME = "traycer-find-match-active";

const FIND_SKIP_ATTR = "data-find-skip";

export interface FindResult {
  readonly current: number;
  readonly total: number;
}

interface SupportedHighlightsAPI {
  set(name: string, highlight: Highlight): void;
  delete(name: string): void;
}

function getHighlights(): SupportedHighlightsAPI | null {
  if (typeof CSS === "undefined") return null;
  const reg = (CSS as { highlights?: SupportedHighlightsAPI }).highlights;
  return reg ?? null;
}

export function isFindEngineSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof Highlight === "undefined") return false;
  return getHighlights() !== null;
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
    this.clearHighlights();
    this.ranges = [];
    this.activeIndex = 0;
    if (query.length === 0) return 0;

    const needle = this.matchCase ? query : query.toLowerCase();
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
      const haystack = this.matchCase ? node.data : node.data.toLowerCase();
      const step = Math.max(query.length, 1);
      let idx = 0;
      let hit = haystack.indexOf(needle, idx);
      while (hit !== -1) {
        const range = new Range();
        range.setStart(node, hit);
        range.setEnd(node, hit + query.length);
        this.ranges.push(range);
        idx = hit + step;
        hit = haystack.indexOf(needle, idx);
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
    this.clearHighlights();
    this.ranges = [];
  }

  private paint(): void {
    const reg = getHighlights();
    if (reg === null) return;
    const others = this.ranges.filter((_, i) => i !== this.activeIndex);
    if (others.length > 0) {
      reg.set(FIND_HIGHLIGHT_NAME, new Highlight(...others));
    } else {
      reg.delete(FIND_HIGHLIGHT_NAME);
    }
    if (this.activeIndex < this.ranges.length) {
      reg.set(
        FIND_HIGHLIGHT_ACTIVE_NAME,
        new Highlight(this.ranges[this.activeIndex]),
      );
    } else {
      reg.delete(FIND_HIGHLIGHT_ACTIVE_NAME);
    }
  }

  private clearHighlights(): void {
    const reg = getHighlights();
    if (reg === null) return;
    reg.delete(FIND_HIGHLIGHT_NAME);
    reg.delete(FIND_HIGHLIGHT_ACTIVE_NAME);
  }
}
