import {
  BASE_PAD_LEFT,
  INDENT_PX,
  TREE_GUIDE_OFFSET_PX,
} from "./epic-sidebar-tree-shared";

/** The host `<ul>` must be `relative` for the rail to position against it. */
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
