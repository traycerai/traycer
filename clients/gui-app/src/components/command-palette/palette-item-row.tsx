/**
 * Palette-specific row wrapper around cmdk's raw
 * `Command.Item`. The shadcn `CommandItem` primitive renders a
 * hidden `CheckIcon` with `ml-auto` that, even with `opacity-0`,
 * still takes layout width - visible as a ~16px gap at the right
 * edge of every palette row that has no `CommandShortcut`. The
 * palette never uses the check behavior, so we skip the primitive
 * and apply its className directly here.
 */
import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "@/lib/utils";

const ROW_CLASSNAME =
  "group/command-item relative flex cursor-default items-center gap-2 rounded-sm border border-transparent px-2 py-1.5 text-ui-sm outline-hidden select-none transition-[background-color,border-color,box-shadow,color] duration-150 in-data-[slot=dialog-content]:rounded-lg hover:bg-muted/55 hover:text-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:border-primary/35 data-selected:bg-primary/12 data-selected:text-foreground data-selected:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-selected:*:[svg]:text-primary";

export function PaletteItemRow({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(ROW_CLASSNAME, className)}
      {...props}
    />
  );
}
