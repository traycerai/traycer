import {
  BASE_PAD_LEFT,
  INDENT_PX,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";

/**
 * The one row metric the dock's list panels share (L-171, L-172).
 *
 * The pills above the composer are a one-at-a-time switcher: clicking another
 * one REPLACES the attached panel (L-141). So a one-line row in Files changed
 * and a one-line row in Background have to measure the same, or every switch
 * between two one-line panels moves the composer's whole upper edge. They did
 * not. The five lists had five recipes, and a row's height was decided by
 * whatever happened to be tallest inside it - a `h-6` Undo button here, a
 * `py-0.5` badge there, an inherited `text-ui` line box in Todo, a `size-7`
 * drag handle and a floated toolbar in the queue.
 *
 * Measured at the app's 15px root, in this file's own panel order, one row
 * each: changed files 41.25px, active agents 37.5px, background 37.5px, the
 * queue 47px (a `py-1.5` row around a float whose margin box was a `size-7`
 * button plus `p-0.5` plus 2px of border plus `mb-1`), todo 41.25px. The
 * queue was the outlier and the one a pill switch made most visible.
 *
 * So the height is stated rather than emergent. {@link CHAT_DOCK_PANEL_ROW}
 * pins it with `min-h-8` - 2rem, 30px - and every row's content is smaller
 * than the 26.25px that leaves inside the padding, so nothing INSIDE a row can
 * decide its height any more. The tallest thing any of them puts in a row is a
 * `size="xs"` button (`h-6`, 22.5px), which is also the one control they all
 * share; the queue's floated toolbar is held to 24.5px by a `-my-0.5` that
 * cancels its frame's padding.
 *
 * `min-h`, not `h`: a row whose content genuinely needs two lines (a queued
 * message long enough to wrap) still grows. The ruling binds the ONE-LINE
 * case, which is the case a pill switch moves between, and L-172 narrowed the
 * exemption L-171 granted - a queued message's provenance badge is a leading
 * chip the text wraps around rather than a line of its own, so a one-message
 * queue measures 41.25px whoever sent the message.
 *
 * Class constants rather than a `DockPanelRow` component, because the rows
 * agree on their box and on nothing else: one is an `li` with a nested button
 * and a dnd ref, one is a `div` with an inline `paddingLeft` for its tree
 * depth, one carries a drag handle and a drop indicator. A component would be
 * a box with five escape hatches through it. `home-focus-row-style.ts` is the
 * same shape for the same reason.
 *
 * **Not only the dock.** `AgentStopList` is ONE list drawn on two surfaces -
 * the Active agents panel and the TUI agent tile's popover - and both take
 * this metric deliberately (R6H-06): a list does not change its row height
 * because of what is mounted around it, and keying the class off that list's
 * `surface` prop would mean two metrics for one list. The popover's rows grew
 * from 26.25px to 30px with the dock's, which is the point.
 * `chat-dock-panel-row-metric.test.tsx` pins that surface too, so the shared
 * metric cannot quietly become dock-only again.
 */

/**
 * The list the rows sit in: the panel's inner top and bottom inset, and the
 * gap between rows. Both are part of the metric - N one-line rows measure the
 * same in all five only if the inset and the gap do too.
 *
 * `py-1.5` (5.625px each side) and `gap-0.5` (1.875px) put a one-row panel at
 * 41.25px and an N-row panel at `N * 30 + (N - 1) * 1.875 + 11.25`. A resting
 * separator between rows has to be drawn OUT of flow for that to keep holding,
 * which is why the queue's returning hairline is a `before:` pseudo-element in
 * the gap rather than the `divide-y` it used to carry.
 */
export const CHAT_DOCK_PANEL_LIST = "flex flex-col gap-0.5 px-2 py-1.5";

/**
 * One row. 30px tall whatever is in it, up to the point where the content
 * itself needs two lines.
 */
export const CHAT_DOCK_PANEL_ROW =
  "flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 py-0.5";

/**
 * The row's leading cluster - icon, label, trailing badge - as a flex child
 * that takes the row's whole height.
 *
 * `self-stretch` is what keeps a hover fill or a focus ring the size of the
 * row rather than the size of its text, now that the row's height comes from
 * `min-h-8` instead of from padding on this element.
 */
export const CHAT_DOCK_PANEL_ROW_CONTENT =
  "flex min-w-0 flex-1 items-center gap-2 self-stretch text-left";

/** {@link CHAT_DOCK_PANEL_ROW_CONTENT} where the cluster is the row's opener. */
export const CHAT_DOCK_PANEL_ROW_BUTTON = `${CHAT_DOCK_PANEL_ROW_CONTENT} rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`;

/**
 * The row's own text: one size and one line height across the panels (L-171).
 *
 * Todo's rows carried no size at all and inherited the app's `text-ui` (15px
 * on a 22.5px line box) while the panel beside them drew 11.25px, which is the
 * "difference in text sizes" the owner saw when switching pills. The queue's
 * message text was `text-ui-sm leading-5` for the same reason - nobody had
 * compared the two panels side by side - and the changed-files panel's
 * ARTIFACT branch was a third size again.
 *
 * One exception, and it is a face rather than a size: the changed-files row
 * draws its path and its artifact title in `text-code-sm`, because a path is
 * code, it is the same component the transcript and the diff tile draw, and
 * 12px mono beside 11.25px UI text reads as a different KIND of text rather
 * than as a second size. Its 1.375rem line box is well inside the row's
 * budget, so it cannot move a height. Everything else in that row - the verb,
 * the `+/-` deltas - takes a token from this file or the code ramp beside it.
 */
export const CHAT_DOCK_PANEL_ROW_TEXT = "text-ui-xs";

/**
 * The left inset of a row whose left column is shared with the sidebar's tree
 * guide: the Background panel's three row shapes and the port-forward row.
 *
 * These rows sit under `TreeGroupGuide`, whose rail is positioned from
 * `BASE_PAD_LEFT` and `INDENT_PX` in raw pixels. {@link CHAT_DOCK_PANEL_ROW}'s
 * `px-2` is 7.5px at this app's 15px root, so the two disagree by half a
 * pixel. The rail wins, deliberately: a row that is a rem off the rail drawn
 * through it is a visible break, and half a pixel between two panels is not
 * (R6H-11). Stating it here is what makes it a decision rather than an inline
 * style that silently outranks the recipe.
 *
 * The LENGTH rather than a style object, so each row keeps a literal
 * `style={{ paddingLeft }}` the design linter can still read.
 */
export function chatDockPanelRowTreeInset(depth: number): string {
  return `${String(depth * INDENT_PX + BASE_PAD_LEFT)}px`;
}
