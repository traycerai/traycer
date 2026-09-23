import {
  FIND_BLOCK_ATTR,
  FIND_HIT_ATTR,
  FIND_MIRROR_ATTR,
  FIND_VISIBLE_ATTR,
  type FindBlockHit,
} from "@/lib/find-engine/find-blocks";
import { findTextMatches } from "@/lib/find-engine/find-text";
import {
  getHighlights,
  RangeHighlighter,
} from "@/lib/find-engine/range-highlighter";

// `svg` stays skipped here on purpose: icons carry no findable text, and a
// diagram's labels are reached through its block's visible region below, so
// that a hit in the diagram's source is painted once, never twice.
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

// Inside a block's visible region the drawing itself is the text worth
// painting, so the button and svg rules above do not apply; what a drawing
// embeds but never shows (its own styles, accessible names) still does not.
const SKIPPED_VISIBLE_ANCESTOR_SELECTOR = [
  "script",
  "style",
  "title",
  "desc",
  "[hidden]",
  "[aria-hidden='true']",
  `[${FIND_MIRROR_ATTR}]`,
].join(",");

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

/**
 * Resolve a mounted transcript row by comparing `dataset.messageId`, not an
 * attribute selector: persisted ids can carry quotes/brackets that would
 * break interpolation, and jsdom does not implement `CSS.escape`.
 */
export function queryMountedChatMessageRoot(
  scroller: ParentNode,
  messageId: string,
): HTMLElement | null {
  for (const row of scroller.querySelectorAll<HTMLElement>(
    "[data-message-id]",
  )) {
    if (row.dataset.messageId === messageId) return row;
  }
  return null;
}

export function queryMountedChatBlock(
  root: ParentNode,
  blockId: string,
): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>("[data-block-id]")) {
    if (element.dataset.blockId === blockId) return element;
  }
  return null;
}

/**
 * Paints one chat find unit. Fence matches are counted on source, exactly like
 * ordinary code fences. Their block is the active target; visible diagram
 * labels are supplementary highlights, never mapped to source ordinals.
 */
export class ChatFindHighlighter {
  private readonly highlighter = new RangeHighlighter();
  private markedBlocks: HTMLElement[] = [];
  private lastNavigatedBlock: HTMLElement | null = null;
  private pulseTarget: HTMLElement | null = null;
  private pulseAnimation: Animation | null = null;

  paint(input: {
    readonly root: HTMLElement;
    readonly query: string;
    readonly matchCase: boolean;
    readonly activeMatchIndex: number;
    readonly scrollActiveIntoView: boolean;
  }): boolean {
    if (getHighlights() === null) {
      this.clear();
      return false;
    }
    const aligned = collectTextRanges(input.root, input.query, input.matchCase);
    if (aligned.at(input.activeMatchIndex) === undefined) {
      this.clear();
      return false;
    }

    const painted: Range[] = [];
    let activeRange: Range | null = null;
    let activeBlock: HTMLElement | null = null;
    const blocks = new Set<HTMLElement>();
    for (const [index, range] of aligned.entries()) {
      const isActive = index === input.activeMatchIndex;
      const block = mirrorBlockOf(range);
      if (block === null) {
        painted.push(range);
        if (isActive) activeRange = range;
      } else {
        blocks.add(block);
        if (isActive) activeBlock = block;
      }
    }

    if (this.pulseTarget !== activeBlock) this.stopPulse();
    this.unmarkBlocks();
    for (const block of blocks) {
      this.markBlock(block, block === activeBlock ? "active" : "match");
      // A label may appear several times in a drawing or share its text with
      // source syntax. Tint every drawn match as context; only the block
      // identifies the active source occurrence, so no ordinal pairing is needed.
      painted.push(
        ...collectVisibleRanges(block, input.query, input.matchCase),
      );
    }

    this.highlighter.paintRanges(input.root, painted, activeRange);
    if (input.scrollActiveIntoView) {
      if (activeBlock !== null) {
        this.pulseBlock(activeBlock);
        activeBlock.scrollIntoView({
          block: this.lastNavigatedBlock === activeBlock ? "nearest" : "center",
          inline: "nearest",
        });
      } else {
        // Also reveal matches inside a card's own height-capped scroller.
        activeRange?.startContainer.parentElement?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
      }
      this.lastNavigatedBlock = activeBlock;
    }
    return true;
  }

  clear(): void {
    this.stopPulse();
    this.lastNavigatedBlock = null;
    this.unmarkBlocks();
    this.highlighter.clear();
  }

  dispose(): void {
    this.clear();
    this.highlighter.dispose();
  }

  private pulseBlock(block: HTMLElement): void {
    // A fresh animation on every deliberate navigation makes consecutive hits
    // in the SAME block perceptible. Passive redraws preserve an ongoing pulse.
    this.stopPulse();
    if (
      typeof block.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    this.pulseTarget = block;
    this.pulseAnimation = block.animate(
      [
        {
          outlineOffset: "2px",
          outlineColor: "color-mix(in srgb, var(--primary) 75%, transparent)",
        },
        { outlineOffset: "5px", outlineColor: "var(--primary)" },
        {
          outlineOffset: "2px",
          outlineColor: "color-mix(in srgb, var(--primary) 75%, transparent)",
        },
      ],
      { duration: 280, easing: "ease-out" },
    );
  }

  private stopPulse(): void {
    this.pulseAnimation?.cancel();
    this.pulseAnimation = null;
    this.pulseTarget = null;
  }

  private markBlock(block: HTMLElement, mark: FindBlockHit): void {
    block.setAttribute(FIND_HIT_ATTR, mark);
    this.markedBlocks.push(block);
  }

  private unmarkBlocks(): void {
    for (const block of this.markedBlocks) block.removeAttribute(FIND_HIT_ATTR);
    this.markedBlocks = [];
  }
}

/** The block whose mirror holds this range, or `null` for ordinary text. */
function mirrorBlockOf(range: Range): HTMLElement | null {
  const mirror = range.startContainer.parentElement?.closest<HTMLElement>(
    `[${FIND_MIRROR_ATTR}]`,
  );
  return mirror?.closest<HTMLElement>(`[${FIND_BLOCK_ATTR}]`) ?? null;
}

function collectTextRanges(
  root: HTMLElement,
  query: string,
  matchCase: boolean,
): ReadonlyArray<Range> {
  return collectRanges(root, query, matchCase, (parent) => {
    if (parent.closest(SKIPPED_HIGHLIGHT_ANCESTOR_SELECTOR) !== null) {
      return false;
    }
    const button = parent.closest("button");
    return (
      button === null ||
      button.closest(INCLUDED_BUTTON_HIGHLIGHT_SELECTOR) !== null
    );
  });
}

/** The words a block draws for its hits, in document order. */
function collectVisibleRanges(
  block: HTMLElement,
  query: string,
  matchCase: boolean,
): ReadonlyArray<Range> {
  const region = block.querySelector<HTMLElement>(`[${FIND_VISIBLE_ATTR}]`);
  if (region === null) return [];
  return collectRanges(
    region,
    query,
    matchCase,
    (parent) => parent.closest(SKIPPED_VISIBLE_ANCESTOR_SELECTOR) === null,
  );
}

function collectRanges(
  root: HTMLElement,
  query: string,
  matchCase: boolean,
  accepts: (parent: Element) => boolean,
): ReadonlyArray<Range> {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (parent === null || !accepts(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node = walker.nextNode() as Text | null;
  while (node !== null) {
    for (const match of findTextMatches(node.data, query, matchCase)) {
      const range = new Range();
      range.setStart(node, match.offset);
      range.setEnd(node, match.offset + match.length);
      ranges.push(range);
    }
    node = walker.nextNode() as Text | null;
  }
  return ranges;
}
