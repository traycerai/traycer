"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Off is drawn like `Checkbox`'s unchecked box: an outlined track with a
 * `--muted-foreground` thumb. The `--input` fill alone was about 1:1 against
 * the surface it sits on, so an off switch read as a stray dot; every palette
 * tunes `--muted-foreground` to clear the 3:1 a control needs on every surface
 * (`unchecked-control-border-contrast.test.ts`). On stays the filled track.
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:border-muted-foreground data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:size-3 data-[state=unchecked]:translate-x-0.5 dark:data-[state=checked]:bg-primary-foreground data-[state=unchecked]:bg-muted-foreground",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
