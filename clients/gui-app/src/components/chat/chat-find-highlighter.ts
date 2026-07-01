interface SupportedHighlightsAPI {
  set(name: string, highlight: Highlight): void;
  delete(name: string): void;
}

interface HighlightNames {
  readonly match: string;
  readonly active: string;
}

const SKIPPED_HIGHLIGHT_ANCESTOR_SELECTOR = [
  "[data-find-skip]",
  "input",
  "textarea",
  "select",
  "script",
  "style",
  "noscript",
  "svg",
  "title",
  "[hidden]",
  "[data-slot='collapsible-content'][data-state='closed']",
  ".sr-only",
  "[aria-hidden='true']",
].join(",");
const INCLUDED_BUTTON_HIGHLIGHT_SELECTOR = "button[data-find-include='true']";

// Resolve a mounted find-unit anchor by scanning `[data-chat-find-unit]`
// descendants and comparing the parsed dataset value, rather than interpolating
// the unit id into a `[data-chat-find-unit="..."]` selector. Unit ids embed
// persisted message/segment ids behind a plain `string` boundary, so a quote,
// backslash, or bracket in an otherwise valid id would break (or mis-target) a
// raw attribute-selector lookup in the virtualized list. `dataset` comparison is
// selector-safe and avoids `CSS.escape`, which jsdom does not implement.
export function queryMountedChatFindUnit(
  messageRoot: ParentNode,
  unitId: string,
): HTMLElement | null {
  for (const element of messageRoot.querySelectorAll<HTMLElement>(
    "[data-chat-find-unit]",
  )) {
    if (element.dataset.chatFindUnit === unitId) return element;
  }
  return null;
}

export class ChatFindHighlighter {
  private readonly names: HighlightNames;
  private styleElement: HTMLStyleElement | null = null;

  constructor(tileInstanceId: string) {
    const suffix = stableCssIdentSuffix(tileInstanceId);
    this.names = {
      match: `traycer-chat-find-match-${suffix}`,
      active: `traycer-chat-find-active-${suffix}`,
    };
  }

  paint(input: {
    readonly root: HTMLElement;
    readonly query: string;
    readonly matchCase: boolean;
    readonly activeMatchIndex: number;
    readonly scrollActiveIntoView: boolean;
  }): boolean {
    const highlights = getHighlights();
    if (highlights === null || typeof Highlight === "undefined") return false;
    const ranges = collectTextRanges(input);
    if (ranges.length === 0) {
      this.clear();
      return false;
    }
    const active = ranges.at(input.activeMatchIndex);
    if (active === undefined) {
      this.clear();
      return false;
    }
    this.ensureStyleElement();
    const others = ranges.filter(
      (_range, index) => index !== input.activeMatchIndex,
    );
    if (others.length > 0) {
      highlights.set(this.names.match, new Highlight(...others));
    } else {
      highlights.delete(this.names.match);
    }
    highlights.set(this.names.active, new Highlight(active));
    // The active match may sit below the fold of a card's own height-capped
    // scroll container (subagent/A2A bodies use `max-h` + `overflow-auto`).
    // Scrolling the match's element walks every scroll ancestor, so the inner
    // container reveals the match in addition to the chat row scroll the reveal
    // controller already did. Only the navigation paint passes this; passive
    // streaming/sync repaints must never yank the scroll position.
    if (input.scrollActiveIntoView) {
      active.startContainer.parentElement?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }
    return true;
  }

  clear(): void {
    const highlights = getHighlights();
    if (highlights === null) return;
    highlights.delete(this.names.match);
    highlights.delete(this.names.active);
  }

  dispose(): void {
    this.clear();
    this.styleElement?.remove();
    this.styleElement = null;
  }

  private ensureStyleElement(): void {
    if (this.styleElement !== null) return;
    const style = document.createElement("style");
    style.dataset.traycerChatFindHighlight = this.names.match;
    style.textContent = [
      `::highlight(${this.names.match}) {`,
      "background-color: color-mix(in srgb, var(--primary) 35%, transparent);",
      "color: inherit;",
      "}",
      `::highlight(${this.names.active}) {`,
      "background-color: color-mix(in srgb, var(--primary) 75%, transparent);",
      "color: var(--primary-foreground);",
      "}",
    ].join("\n");
    document.head.append(style);
    this.styleElement = style;
  }
}

function getHighlights(): SupportedHighlightsAPI | null {
  if (typeof CSS === "undefined") return null;
  const registry = (CSS as { highlights?: SupportedHighlightsAPI }).highlights;
  return registry ?? null;
}

function collectTextRanges(input: {
  readonly root: HTMLElement;
  readonly query: string;
  readonly matchCase: boolean;
  readonly activeMatchIndex: number;
}): ReadonlyArray<Range> {
  const needle = input.matchCase ? input.query : input.query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(input.root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (parent === null) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SKIPPED_HIGHLIGHT_ANCESTOR_SELECTOR) !== null) {
        return NodeFilter.FILTER_REJECT;
      }
      const button = parent.closest("button");
      if (
        button !== null &&
        button.closest(INCLUDED_BUTTON_HIGHLIGHT_SELECTOR) === null
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node = walker.nextNode() as Text | null;
  while (node !== null) {
    const haystack = input.matchCase ? node.data : node.data.toLowerCase();
    const step = Math.max(input.query.length, 1);
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      const range = new Range();
      range.setStart(node, index);
      range.setEnd(node, index + input.query.length);
      ranges.push(range);
      index = haystack.indexOf(needle, index + step);
    }
    node = walker.nextNode() as Text | null;
  }
  return ranges;
}

function stableCssIdentSuffix(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
