import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface BlockFloatingToolbarProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  readonly label: string;
  readonly children: ReactNode;
}

/**
 * Shared chrome for the per-block floating toolbar used by mermaid and
 * wireframe NodeViews. The toolbar is an `role="toolbar"` absolutely
 * positioned above the top-right corner of its parent NodeView. It remains
 * hidden by default and becomes visible when the NodeView is hovered,
 * focused, or ProseMirror-selected. All of that transition logic lives in
 * `editor.css` (`.tc-node-block-toolbar`) so the JSX stays semantic and
 * identical across both block types.
 *
 * We deliberately avoid Floating UI here: the target is always the immediate
 * NodeView container, so CSS absolute positioning is sufficient and keeps
 * the bundle smaller. The selection-driven BubbleMenu in
 * `artifact-toolbar.tsx` is the right surface for a caret-following menu;
 * block actions follow the block.
 */
export function BlockFloatingToolbar(props: BlockFloatingToolbarProps) {
  const { label, children, className, ...rest } = props;
  return (
    <div
      role="toolbar"
      aria-label={label}
      tabIndex={-1}
      className={cn("tc-node-block-toolbar", className)}
      // The NodeView renders as `contentEditable={false}` via Tiptap's atom
      // semantics, but we still stop mousedown so clicking a toolbar button
      // does not collapse the editor selection through the NodeView root.
      onMouseDown={(event) => event.preventDefault()}
      {...rest}
    >
      {children}
    </div>
  );
}
