"use client";

import * as React from "react";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { Circle } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * `default` is a form's stack of dot radios. The rest group
 * `RadioGroupButtonItem`s: `segmented` is the pick-one-of-a-few track (the
 * layout editor's `.seg`), `row` a bare row of icon buttons, `cards` a stack
 * of picture cards whose row or column layout the call site chooses.
 */
const RADIO_GROUP_VARIANT_CLASS = {
  default: "grid gap-2",
  segmented:
    "inline-flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5",
  row: "flex items-center gap-0.5",
  cards: "gap-1.5",
} as const;

function RadioGroup<Value>({
  className,
  variant = "default",
  ...props
}: RadioGroupPrimitive.Props<Value> & {
  readonly variant?: keyof typeof RADIO_GROUP_VARIANT_CLASS;
}) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      data-variant={variant}
      className={cn(RADIO_GROUP_VARIANT_CLASS[variant], className)}
      {...props}
    />
  );
}

/** Outlined like `Checkbox`'s unchecked box, for the same contrast reason. */
function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioPrimitive.Root>) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "relative flex aspect-square size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-disabled:cursor-not-allowed data-disabled:opacity-50 data-checked:border-primary",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="absolute inset-0 flex items-center justify-center"
      >
        <Circle className="size-2 fill-primary text-primary" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

/**
 * A radio the rendered element draws - a `Button` segment, a picture card -
 * for a group whose options are not dots. The group's semantics and keyboard
 * stay Base's (one Tab stop, arrows move and select); the look, the checked
 * state included (`aria-checked`, `data-checked`), is the element's own.
 * `render` must be a native `<button>`; it defaults to a bare one.
 */
function RadioGroupButtonItem({
  render,
  className,
  variant = "bare",
  ...props
}: Omit<React.ComponentProps<typeof RadioPrimitive.Root>, "nativeButton"> & {
  /** `bare` leaves the look to `render`; `card` is a picture card that
   *  outlines itself when checked (`PicturedOptions`). */
  readonly variant?: "bare" | "card";
}) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-button-item"
      data-variant={variant}
      nativeButton
      render={render ?? <button type="button" />}
      className={(state) =>
        cn(
          variant === "card" &&
            "grid items-center gap-x-2.5 gap-y-2 rounded-lg border border-border bg-card px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:press-scrim data-checked:border-foreground data-disabled:opacity-50",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export { RadioGroup, RadioGroupItem, RadioGroupButtonItem };
