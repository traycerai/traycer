import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * One of a few peer choices drawn as a tile: a bordered box with a title, a
 * sentence about what the choice means, and whatever the choice carries (a
 * control, a status line at its foot).
 *
 * The tile is not the control. It holds a `RadioGroupItem` as a direct child,
 * pinned to its top-right corner, and every state it draws is read off that
 * radio, so the tile can never say "chosen" while the radio says otherwise:
 *
 * - **Chosen** (`data-state=checked` on the radio): the accent border and a
 *   primary tint. `bg-primary/5` is an alpha of the accent, not `bg-muted`,
 *   so it survives every preset's raised surface.
 * - **Focused** (the radio is `:focus-visible`): the radio's own ring,
 *   repeated on the tile, since the radio is a 16px circle in its corner.
 * - **Disabled** (the radio is): no pointer cursor.
 *
 * A caller that makes the tile's body clickable does so for the pointer only;
 * the radio stays the keyboard's way in, and nothing interactive may be
 * nested inside the radio itself.
 */
function ChoiceTile({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="choice-tile"
      className={cn(
        "relative flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg border border-border/60 p-3.5 transition-colors",
        "*:data-[slot=radio-group-item]:absolute *:data-[slot=radio-group-item]:top-3.5 *:data-[slot=radio-group-item]:right-3.5",
        "has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5",
        "has-[[data-slot=radio-group-item]:focus-visible]:ring-3 has-[[data-slot=radio-group-item]:focus-visible]:ring-ring/50",
        "has-[[data-slot=radio-group-item]:disabled]:cursor-default",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The tile's name, with room on the right for the radio in the corner. An
 * icon or a badge beside the words is the caller's to put inside.
 */
function ChoiceTileTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="choice-tile-title"
      className={cn(
        "flex min-w-0 items-center gap-2 pr-6 text-ui-sm font-medium text-foreground [&>svg]:size-4 [&>svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function ChoiceTileDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="choice-tile-description"
      className={cn("text-pretty text-ui-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

/**
 * The status line at the tile's foot, under a rule. A foot with nothing in it
 * draws nothing, rule included, so a caller renders it unconditionally and
 * lets its content decide.
 */
function ChoiceTileFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="choice-tile-footer"
      className={cn(
        "mt-1 flex min-w-0 flex-col gap-1 border-t border-border/60 pt-2.5 text-ui-sm text-muted-foreground empty:hidden",
        className,
      )}
      {...props}
    />
  );
}

export { ChoiceTile, ChoiceTileTitle, ChoiceTileDescription, ChoiceTileFooter };
