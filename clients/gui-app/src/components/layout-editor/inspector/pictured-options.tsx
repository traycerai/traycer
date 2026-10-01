import type { ReactNode } from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export interface PicturedOption {
  readonly id: string;
  readonly label: string;
  /** The option drawn as the real thing: a leaf from the app itself, with sample data. */
  readonly picture: ReactNode;
}

/**
 * Pick one of a few values, each drawn as the real thing rather than named: a
 * radio group of pictures (Context usage's Style, Model's Reasoning control,
 * Side tab view). Radix supplies the radio semantics and the keyboard, as it
 * does for `SegmentedControl`: one Tab stop, arrows move and select.
 */
export function PicturedOptions(props: {
  readonly label: string;
  readonly options: ReadonlyArray<PicturedOption>;
  /** The checked option's id, or `null` when none matches. */
  readonly value: string | null;
  readonly onChange: (id: string) => void;
  /** Every option inert, while the setting does not apply. */
  readonly disabled: boolean;
  /**
   * `end` names a small picture beside it, in a column every option shares so
   * the pictures line up; `above` names a tall one over it, which then has
   * the card's whole width (the side strip is drawn at its real width).
   */
  readonly labelPlacement: "end" | "above";
}): ReactNode {
  const { label, options, value, onChange, disabled } = props;
  const above = props.labelPlacement === "above";
  return (
    <>
      <span className="mb-1.5 block text-micro text-muted-foreground uppercase">
        Sample
      </span>
      {/* The radios need an owner, or a screen reader announces orphans with
        no group name and no position in a set (G1-16). */}
      <RadioGroupPrimitive.Root
        aria-label={label}
        value={value ?? ""}
        onValueChange={onChange}
        disabled={disabled}
        className={cn(
          "gap-1.5",
          above ? "flex flex-col" : "grid grid-cols-[auto_minmax(0,1fr)_auto]",
        )}
      >
        {options.map((option) => {
          const checked = option.id === value;
          return (
            <RadioGroupPrimitive.Item
              key={option.id}
              value={option.id}
              // The picture is `inert` below, so it is out of the a11y tree and
              // this radio has no name left to take from its content.
              aria-label={option.label}
              className={cn(
                "grid items-center gap-x-2.5 rounded-lg border border-border bg-card px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:press-scrim disabled:opacity-50",
                above
                  ? "grid-cols-[auto_minmax(0,1fr)] gap-y-2"
                  : "col-span-3 grid-cols-subgrid",
                checked && "border-foreground",
              )}
            >
              <span
                className={cn(
                  "relative size-3.5 shrink-0 rounded-full border border-input",
                  checked &&
                    "border-foreground after:absolute after:inset-0.75 after:rounded-full after:bg-foreground after:content-['']",
                )}
              />
              {/* `inert`: an option draws the REAL leaf, and for Model that
                leaf is `HarnessModelTrigger` - a genuine `<button>` nested
                inside a `role="radio"`, which is invalid markup (P-8, P-9).
                `inert` takes the picture out of focus, hit testing and the
                a11y tree in one, which leaves this radio as the row's one
                control. */}
              {above ? optionLabel(option.label) : null}
              <span
                inert
                className={cn(
                  "min-w-0 overflow-hidden",
                  above && "col-start-2",
                )}
              >
                {option.picture}
              </span>
              {above ? null : optionLabel(option.label)}
            </RadioGroupPrimitive.Item>
          );
        })}
      </RadioGroupPrimitive.Root>
    </>
  );
}

function optionLabel(label: string): ReactNode {
  return <span className="text-ui-xs text-muted-foreground">{label}</span>;
}
