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

/** data-active / data-disabled only; consumers supply tokens. Utility styles live in editor.css under tc-editor-toolbar. */
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
