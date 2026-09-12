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
 */
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
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Track>) {
  return (
    <SliderPrimitive.Track
      data-slot="slider-track"
      className={cn(
        "relative h-1 w-full grow overflow-hidden rounded-full bg-foreground/8",
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
 * `after:` is the touch target, not decoration: the thumb draws at 16px so it
 * sits on a 4px track without swallowing it, while the pseudo-element takes
 * the pointer out to 24 × 32, which is the floor a coarse pointer needs. It
 * grows further vertically than horizontally on purpose - there is nothing
 * above or below to steal, and a wide one would eat the neighbouring stop.
 */
function SliderThumb({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Thumb>) {
  return (
    <SliderPrimitive.Thumb
      data-slot="slider-thumb"
      className={cn(
        "relative block size-4 shrink-0 rounded-full border border-primary/60 bg-background shadow-sm outline-none transition-colors after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] hover:border-primary focus-visible:ring-2 focus-visible:ring-ring/60 data-[disabled]:pointer-events-none",
        className,
      )}
      {...props}
    />
  );
}

export { Slider, SliderTrack, SliderRange, SliderThumb };
