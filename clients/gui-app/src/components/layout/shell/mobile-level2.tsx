import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { useKeyboardOverlayInset } from "@/hooks/ui/use-keyboard-focus-layout";
import { cn } from "@/lib/utils";

/**
 * What a task's tile list and Tracy's bots list share when level 2 draws beside
 * the content or under the current item's name. The width is the resolver's
 * answer in CSS pixels, never a choice made here.
 */
export function MobileLevel2Column(props: {
  readonly width: number;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      style={{ width: props.width }}
      className="flex min-h-0 shrink-0 flex-col border-r border-canvas-border/70"
    >
      {props.children}
    </div>
  );
}

/** The current item's name as the control that opens the menu under it. */
export function MobileLevel2MenuTrigger(props: {
  readonly testId: string;
  readonly className: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <PopoverTrigger asChild>
      <Button
        type="button"
        variant="muted"
        size="sm"
        data-testid={props.testId}
        // `shrink` undoes the button's own `shrink-0`, and the cap gives a long
        // name a width to truncate at, so what trails it stays in the row.
        className={cn(
          "min-w-0 max-w-full shrink justify-start",
          props.className,
        )}
      >
        {props.children}
        <ChevronDown aria-hidden="true" />
      </Button>
    </PopoverTrigger>
  );
}

/**
 * The menu's plate, within the height left between its trigger and the
 * keyboard. `tall` is for a list that scrolls inside itself and so has no
 * height of its own to size the plate by: the sheet's height, which it
 * replaces. Opening does not move focus: the first control in a list is a
 * search field, and focusing it raises the keyboard over the list the person
 * just asked to see.
 */
export function MobileLevel2MenuContent(props: {
  readonly label: string;
  readonly testId: string;
  readonly tall: boolean;
  readonly children: ReactNode;
}): ReactNode {
  // The installed iOS app's keyboard covers a window that keeps its height, so
  // it comes off the bottom of the plate's room as the home indicator does; it
  // covers that strip, hence the larger of the two.
  const insets = useSafeAreaCollisionPadding();
  const keyboard = useKeyboardOverlayInset();
  return (
    <PopoverContent
      side="bottom"
      align="start"
      layout="bare"
      collisionPadding={{
        ...insets,
        bottom: Math.max(insets.bottom, keyboard),
      }}
      aria-label={props.label}
      data-testid={props.testId}
      className={cn(
        "max-h-(--radix-popover-content-available-height)",
        props.tall && "h-[70dvh]",
      )}
      onOpenAutoFocus={(event) => event.preventDefault()}
    >
      {props.children}
    </PopoverContent>
  );
}
