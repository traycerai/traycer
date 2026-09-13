"use client";

import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * The Radix slider, in four wrappers rather than one component, because a
 * caller that draws something ON the track - stop dots, a scale - needs to put
 * its own children between the track and the thumb.
 *
 * The track is an alpha of the foreground rather than `bg-muted`: this renders
 * inside a popover, and every preset theme's dark variant collapses `--muted`
 * into the popover's own fill.
 *
 * Two sizes. `default` is the hairline rail a settings row wants. `pill` is the
 * thick capsule the model picker's reasoning control wants: the track becomes a
 * surface the fill, the stops and the thumb all live INSIDE, so the control
 * reads as one object rather than as a rail with furniture on it. The size is
 * declared on the track and the thumb independently - they are siblings under
 * the root, not a pair a context could couple - so a caller that changes one
 * must change the other; the two `data-size` attributes are what a test reads
 * to check it did.
 */
type SliderSize = "default" | "pill";

function Slider({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        "relative flex w-full touch-none select-none items-center data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
        className,
      )}
      {...props}
    />
  );
}

function SliderTrack({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Track> & {
  size?: SliderSize;
}) {
  return (
    <SliderPrimitive.Track
      data-slot="slider-track"
      data-size={size}
      className={cn(
        "relative h-1 w-full grow overflow-hidden rounded-full bg-foreground/8 data-[size=pill]:h-9",
        className,
      )}
      {...props}
    />
  );
}

function SliderRange({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Range>) {
  return (
    <SliderPrimitive.Range
      data-slot="slider-range"
      className={cn("absolute h-full bg-primary/70", className)}
      {...props}
    />
  );
}

/**
 * At `default` size, `after:` is the touch target, not decoration: the thumb
 * draws at 16px so it sits on a 4px track without swallowing it, while the
 * pseudo-element takes the pointer out to 24 × 32, which is the floor a coarse
 * pointer needs. It grows further vertically than horizontally on purpose -
 * there is nothing above or below to steal, and a wide one would eat the
 * neighbouring stop.
 *
 * At `pill` the disc is 28px, already past that floor on both axes, so the
 * pseudo-element collapses back onto the thumb (`after:inset-0`) rather than
 * reaching 36 × 44 and swallowing the stops on either side.
 *
 * The pill disc is `--foreground` inside a `--popover` ring rather than the
 * hairline's `--background` inside `--primary`, because it has to read against
 * BOTH halves of the track it sits astride. `--primary-foreground` is the
 * colour meant to sit on the fill and does that half well, but at the lowest
 * stop the disc is entirely over the UNFILLED remainder, which is the popover
 * plus a foreground alpha - and in the default achromatic themes
 * `--primary-foreground` is within a few percent of it. `--foreground` is the
 * maximum contrast against the remainder by construction, and the popover ring
 * is what separates it from the fill in the one theme where the fill is nearly
 * `--foreground` too.
 */
function SliderThumb({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Thumb> & {
  size?: SliderSize;
}) {
  return (
    <SliderPrimitive.Thumb
      data-slot="slider-thumb"
      data-size={size}
      className={cn(
        "relative block size-4 shrink-0 rounded-full border border-primary/60 bg-background shadow-sm outline-none transition-colors after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] hover:border-primary focus-visible:ring-2 focus-visible:ring-ring/60 data-[disabled]:pointer-events-none data-[size=pill]:size-7 data-[size=pill]:border-2 data-[size=pill]:border-popover data-[size=pill]:bg-foreground data-[size=pill]:shadow-md data-[size=pill]:after:inset-0 data-[size=pill]:hover:border-popover",
        className,
      )}
      {...props}
    />
  );
}

export { Slider, SliderTrack, SliderRange, SliderThumb };
export type { SliderSize };
