/**
 * Chat find counts every occurrence in a fence's SOURCE, including Mermaid
 * syntax and wireframe HTML/CSS/scripts. This preserves ordinary code-fence
 * search and does not attempt to infer what an HTML document will display.
 *
 * A rendered block carries the normalized source in an inert MIRROR so the
 * unit's DOM walk can locate those occurrences in the same order. The block
 * is their target: tinted when it holds hits, outlined when it holds the
 * current hit, briefly pulsed on deliberate navigation. Diagram labels may
 * also be tinted as context, but are never paired to source occurrences.
 */

/** On a block's root: which kind of block it is. */
export const FIND_BLOCK_ATTR = "data-find-block";

/** On the element holding the text the block was counted on. */
export const FIND_MIRROR_ATTR = "data-find-mirror";

/**
 * On the region of a block whose text nodes are drawn and can take a
 * supplementary highlight. A wireframe has no such region in the parent
 * document; its source matches are shown through the block mark alone.
 */
export const FIND_VISIBLE_ATTR = "data-find-visible";

/**
 * Set by the chat find highlighter: `match` for source hits in the block,
 * `active` when the current source occurrence is in this block. Label tints
 * are independent of this active-source indication.
 */
export const FIND_HIT_ATTR = "data-find-hit";

export type FindBlockHit = "match" | "active";
