import { createContext, useContext } from "react";

/**
 * Non-null for rows rendered inside the bounded live activity window, where an
 * in-place disclosure cannot be read. The window is four line-heights tall, so
 * a body opened there is clipped to roughly one line AND pushes every sibling
 * row out of the box - the reader loses both the detail they asked for and the
 * run they were watching.
 *
 * A row that finds a promote callback in context therefore does not expand
 * where it stands. It marks itself open and calls this, which opens the whole
 * activity group, so the one click lands the reader in the full-height body
 * with that row already unfolded, scrolled to and focused.
 *
 * "Marks itself open" happens two different ways, and BOTH are needed. Tool and
 * subagent rows keep open state in a store keyed by segment id, so it survives
 * the remount from the window into `CollapsibleContent` on its own. Command,
 * file-change, approval and reasoning rows keep it in local `useState`, which
 * unmounts with the window - the activity group hands those the `revealed`
 * flag, which seeds their disclosure at mount. Adding a new expandable child
 * kind means picking one of the two; picking neither leaves a click that opens
 * the group and does nothing else.
 *
 * The value is pre-bound to one child segment by the activity group, so a
 * consumer never has to know its own id. Null everywhere else - inside an open
 * group a row expands normally, because nothing is capping its height.
 */
export const LiveActivityPromoteContext = createContext<(() => void) | null>(
  null,
);

export function useLiveActivityPromote(): (() => void) | null {
  return useContext(LiveActivityPromoteContext);
}
