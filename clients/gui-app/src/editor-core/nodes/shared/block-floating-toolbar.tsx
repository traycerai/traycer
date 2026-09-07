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
 * Per-block floating toolbar. Visibility lives in `editor.css`. CSS absolute positioning, not Floating UI: the target is always the NodeView container.
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
