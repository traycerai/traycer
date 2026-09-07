import type { ComponentProps, ReactNode } from "react";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

export interface ToolbarActionButtonProps extends Omit<
  ComponentProps<"button">,
  "children" | "title"
> {
  readonly icon: ReactNode;
  /** The visible words. Also the accessible name unless `tooltip` adds to it. */
  readonly label: string;
  /**
   * Hover text when it says more than the label - a shortcut chord, usually.
   * `null` shows no tooltip; the visible label already says everything.
   */
  readonly tooltip: string | null;
}

/**
 * A labeled command in the bubble toolbar: icon plus visible words.
 *
 * `ToolbarButton` is the icon-only formatting TOGGLE - its label is a tooltip
 * and an `aria-label`, and it always reports `aria-pressed`. Two speech-bubble
 * icons side by side ("Comment", "Send to chat") are not tellable apart at a
 * glance or on touch, so the actions that leave a mark on something other
 * than the text get their words on screen. No pressed state: these are
 * commands, not toggles. Menu ARIA (`aria-haspopup`, `aria-expanded`) is the
 * caller's to add when the action opens one.
 *
 * `ComponentProps` rather than `ComponentPropsWithoutRef`: React 19 passes a
 * ref as an ordinary prop, and everything here - handlers, `ref`, the
 * `data-state` a menu trigger sets - reaches the real `<button>` through the
 * rest spread. That is what lets a Radix `asChild` trigger compose with this
 * component; the tooltip wrapper sits outside the button, not between the
 * trigger and it.
 */
export function ToolbarActionButton(props: ToolbarActionButtonProps) {
  const { icon, label, tooltip, type, className, ...rest } = props;
  const button = (
    <button
      type={type ?? "button"}
      className={className}
      data-toolbar-action=""
      {...rest}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
  if (tooltip === null) return <span className="inline-flex">{button}</span>;
  return (
    <TooltipWrapper
      label={tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">{button}</span>
    </TooltipWrapper>
  );
}
