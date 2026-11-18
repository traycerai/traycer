import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
export interface ToolbarButtonProps extends Omit<
  ComponentPropsWithoutRef<"button">,
  "children" | "title"
> {
  readonly icon: ReactNode;
  readonly label: string;
  readonly active: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * Structural-only formatting button. The package does not ship its own
 * shadcn or Tailwind classes because consumers wire in their own design
 * tokens - we only supply the `data-active` / `data-disabled` hooks and
 * the semantic markup. A small utility style lives in `editor.css` via the
 * `tc-editor-toolbar` scope.
 */
export function ToolbarButton(props: ToolbarButtonProps) {
  const { icon, label, active, disabled, type, className, ...rest } = props;
  return (
    <TooltipWrapper
      label={label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <button
          type={type ?? "button"}
          aria-label={label}
          aria-pressed={active}
          data-active={active ? "true" : "false"}
          disabled={disabled}
          className={className}
          {...rest}
        >
          {icon}
        </button>
      </span>
    </TooltipWrapper>
  );
}
