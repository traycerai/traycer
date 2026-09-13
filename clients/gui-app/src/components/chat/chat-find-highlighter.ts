import { findTextMatches } from "@/lib/find-engine/find-text";
import {
  getHighlights,
  RangeHighlighter,
} from "@/lib/find-engine/range-highlighter";

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
  private readonly highlighter = new RangeHighlighter();

  paint(input: {
    readonly root: HTMLElement;
    readonly query: string;
    readonly matchCase: boolean;
    readonly activeMatchIndex: number;
    readonly scrollActiveIntoView: boolean;
  }): boolean {
    if (getHighlights() === null) return false;
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
    this.highlighter.paint(input.root, ranges, input.activeMatchIndex);
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
    this.highlighter.clear();
  }

  dispose(): void {
    this.highlighter.dispose();
  }
}

function collectTextRanges(input: {
  readonly root: HTMLElement;
  readonly query: string;
  readonly matchCase: boolean;
  readonly activeMatchIndex: number;
}): ReadonlyArray<Range> {
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
    for (const match of findTextMatches(
      node.data,
      input.query,
      input.matchCase,
    )) {
      const range = new Range();
      range.setStart(node, match.offset);
      range.setEnd(node, match.offset + match.length);
      ranges.push(range);
    }
    node = walker.nextNode() as Text | null;
  }
  return ranges;
}
