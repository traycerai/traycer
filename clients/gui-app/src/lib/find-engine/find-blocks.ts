/**
 * The contract between chat find and a block that renders its text as
 * something other than text: a mermaid diagram, a wireframe frame.
 *
 * Find counts hits on a text projection of the transcript and paints them by
 * walking the rendered text nodes, so the two only agree where the projected
 * text is also on the page as text. A block that draws its content instead
 * carries a MIRROR: the exact text it was counted on, laid out but invisible,
 * inside the block. Every counted hit then has a home in the DOM, the counter
 * and the painter stay aligned, and the painter can ask the block for a
 * visible word to colour. When it finds one it paints that word; when it
 * cannot (a diagram keyword, anything inside a wireframe's frame) it marks the
 * block itself so the counter always points at something on screen.
 */

/** On a block's root: which kind of block it is. */
export const FIND_BLOCK_ATTR = "data-find-block";

/** On the element holding the text the block was counted on. */
export const FIND_MIRROR_ATTR = "data-find-mirror";

/**
 * On the region of a block whose text nodes are drawn and can take a
 * highlight. A block without one (a wireframe, whose words live in a frame)
 * shows every hit through the block mark instead.
 */
export const FIND_VISIBLE_ATTR = "data-find-visible";

/**
 * Set by the chat find highlighter on a block that holds a hit it could not
 * paint as a word: `match` for a hit somewhere in the block, `active` for the
 * hit the counter is on. Styled like the word highlights, one level up.
 */
export const FIND_HIT_ATTR = "data-find-hit";

export type FindBlockHit = "match" | "active";
