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

/** Hits a block holds behind its mirror, in the order the counter saw them. */
interface BlockHits {
  count: number;
  /** This block's ordinal of the active hit, when the active hit is here. */
  activeOrdinal: number | null;
}

/**
 * Paints the chat find matches of one unit.
 *
 * The aligned walk over the unit's text nodes yields one range per counted
 * hit, in the counter's order, because a block that draws its text carries a
 * mirror of the text it was counted on (`lib/find-engine/find-blocks.ts`). A
 * hit whose range lands in a mirror is then shown through the block: as a
 * painted word when the block's visible region has one for it, else as a mark
 * on the block itself.
 */
export class ChatFindHighlighter {
  private readonly highlighter = new RangeHighlighter();
  private markedBlocks: HTMLElement[] = [];

  paint(input: {
    readonly root: HTMLElement;
    readonly query: string;
    readonly matchCase: boolean;
    readonly activeMatchIndex: number;
    readonly scrollActiveIntoView: boolean;
  }): boolean {
    if (getHighlights() === null) return false;
    const aligned = collectTextRanges(input.root, input.query, input.matchCase);
    if (aligned.at(input.activeMatchIndex) === undefined) {
      this.clear();
      return false;
    }

    const painted: Range[] = [];
    let activeRange: Range | null = null;
    let activeBlock: HTMLElement | null = null;
    const blocks = new Map<HTMLElement, BlockHits>();
    for (const [index, range] of aligned.entries()) {
      const isActive = index === input.activeMatchIndex;
      const block = mirrorBlockOf(range);
      if (block === null) {
        painted.push(range);
        if (isActive) activeRange = range;
        continue;
      }
      const hits = blocks.get(block) ?? { count: 0, activeOrdinal: null };
      if (isActive) hits.activeOrdinal = hits.count;
      hits.count += 1;
      blocks.set(block, hits);
    }

    this.unmarkBlocks();
    for (const [block, hits] of blocks) {
      // A drawing can repeat a word its source holds once (a sequence
      // diagram draws each participant top and bottom), so only as many
      // drawn words as counted hits are painted and the counter adds up.
      const visible = collectVisibleRanges(
        block,
        input.query,
        input.matchCase,
      ).slice(0, hits.count);
      painted.push(...visible);
      if (hits.activeOrdinal !== null) {
        // The k-th hit in the block's mirror is shown as the k-th word the
        // block draws. A diagram whose source holds more hits than its drawing
        // shows (a keyword) runs out of words, and the block stands in.
        const word = visible.at(hits.activeOrdinal);
        if (word === undefined) activeBlock = block;
        else activeRange = word;
      }
      const mark = blockMark(
        block === activeBlock,
        hits.count - visible.length,
      );
      if (mark !== null) this.markBlock(block, mark);
    }

    this.highlighter.paintRanges(input.root, painted, activeRange);
    // The active match may sit below the fold of a card's own height-capped
    // scroll container (subagent/A2A bodies use `max-h` + `overflow-auto`).
    // Scrolling the match's element walks every scroll ancestor, so the inner
    // container reveals the match in addition to the chat row scroll the reveal
    // controller already did. Only the navigation paint passes this; passive
    // streaming/sync repaints must never yank the scroll position.
    if (input.scrollActiveIntoView) {
      if (activeRange !== null) {
        activeRange.startContainer.parentElement?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
      } else {
        // The mark is the whole block, so bring the whole block in: "nearest"
        // would stop at its top edge and leave most of the outline below the
        // fold.
        activeBlock?.scrollIntoView({ block: "center", inline: "nearest" });
      }
    }
    return true;
  }

  clear(): void {
    this.unmarkBlocks();
    this.highlighter.clear();
  }

  dispose(): void {
    this.unmarkBlocks();
    this.highlighter.dispose();
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

function blockMark(isActive: boolean, hiddenHits: number): FindBlockHit | null {
  if (isActive) return "active";
  return hiddenHits > 0 ? "match" : null;
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
