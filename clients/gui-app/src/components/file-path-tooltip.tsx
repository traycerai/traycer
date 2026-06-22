import type { ReactElement } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface FilePathTooltipProps {
  /** The trigger element (typically a truncated path span). Must accept a
   * forwarded ref since `TooltipTrigger asChild` clones the child. */
  readonly children: ReactElement;
  /** Full text to display in the tooltip - usually the un-truncated path,
   * but any string works (e.g., `"Open <path> in editor"`). */
  readonly content: string;
  /** Placement relative to the trigger. */
  readonly side: "bottom" | "right";
}

/**
 * Hover-tooltip for a (potentially truncated) file path. Renders content
 * via Radix's portal so the trigger's `direction: rtl` (used for left-
 * side ellipsis truncation) doesn't leak into the tooltip's bidi context
 * - Unicode neutrals like `/` would otherwise be reordered into the
 * wrong position.
 *
 * Font-size is delivered through inline `style` rather than a `text-*`
 * className: shadcn's `TooltipContent` already sets `text-ui-xs
 * text-background`, and adding a second `text-*` class would make
 * `tailwind-merge` collapse the group and drop the color, leaving the
 * tooltip invisible against its own background.
 */
export function FilePathTooltip(props: FilePathTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{props.children}</TooltipTrigger>
      <TooltipContent
        side={props.side}
        align="start"
        className="max-w-md px-2 py-1 font-mono"
        style={{
          fontSize: "var(--text-code-xs)",
          overflowWrap: "anywhere",
        }}
      >
        {props.content}
      </TooltipContent>
    </Tooltip>
  );
}
