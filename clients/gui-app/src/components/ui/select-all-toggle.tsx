import type { ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

export function SelectAllToggle(props: {
  readonly accessibleLabel: string;
  readonly selectableCount: number;
  readonly selectedCount: number;
  readonly disabled: boolean;
  readonly testId: string | undefined;
  readonly onToggle: () => void;
}): ReactNode {
  const allSelected =
    props.selectableCount > 0 && props.selectedCount === props.selectableCount;
  const indeterminate =
    props.selectedCount > 0 && props.selectedCount < props.selectableCount;
  let checkedState: "false" | "mixed" | "true" = "false";
  if (allSelected) checkedState = "true";
  else if (indeterminate) checkedState = "mixed";
  let indicator: ReactNode = null;
  if (allSelected) indicator = <Check className="size-3" />;
  else if (indeterminate) indicator = <Minus className="size-3" />;

  return (
    <TooltipWrapper
      label={props.accessibleLabel}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="checkbox"
          aria-checked={checkedState}
          aria-label={props.accessibleLabel}
          data-testid={props.testId}
          disabled={props.disabled || props.selectableCount === 0}
          onClick={props.onToggle}
          className={cn(
            "text-ui-xs text-foreground",
            // Checked fill per `ui/skeleton.tsx` - this toggle rides
            // popover/card surfaces where `bg-muted` is the surface itself.
            allSelected || indeterminate ? "bg-foreground/8" : null,
          )}
        >
          <span
            aria-hidden
            className={cn(
              "flex size-3.5 items-center justify-center rounded-[0.1875rem] border",
              allSelected || indeterminate
                ? "border-foreground/70 bg-foreground text-background"
                : "border-muted-foreground/50",
            )}
          >
            {indicator}
          </span>
          <span>Select all</span>
        </Button>
      </span>
    </TooltipWrapper>
  );
}
