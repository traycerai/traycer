import {
  BASE_PAD_LEFT,
  INDENT_PX,
  TREE_GUIDE_OFFSET_PX,
} from "./epic-sidebar-tree-shared";

/**
 * A single vertical indent-guide rail spanning a `<ul role="group">`.
 *
 * One rail is rendered per group, aligned to the chevron column of the group's
 * parent (`parentDepth`). Because groups nest, each ancestor group contributes
 * its own rail, so a deeply nested row sits to the right of a continuous stack
 * of ancestor rails - giving an unambiguous read of what is nested under what.
 *
 * The host `<ul>` must be `relative` for the rail to position against it.
 */
export function TreeGroupGuide({ parentDepth }: { parentDepth: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-px bg-border/70"
      style={{
        left: `${parentDepth * INDENT_PX + BASE_PAD_LEFT + TREE_GUIDE_OFFSET_PX}px`,
      }}
    />
  );
}
