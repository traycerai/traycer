import type { ComponentPropsWithoutRef, Ref } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EpicsFilterTriggerProps extends ComponentPropsWithoutRef<
  typeof Button
> {
  readonly selectedCount: number;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function EpicsFilterTrigger(props: EpicsFilterTriggerProps) {
  const { selectedCount, className, ...buttonProps } = props;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      {...buttonProps}
      className={cn(
        "gap-1.5 overflow-visible text-ui-sm text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <SlidersHorizontal className="size-4" />
      Filter
      {selectedCount > 0 ? (
        <span className="ml-0.5 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-badge leading-4 text-primary-foreground">
          {selectedCount}
        </span>
      ) : null}
    </Button>
  );
}
