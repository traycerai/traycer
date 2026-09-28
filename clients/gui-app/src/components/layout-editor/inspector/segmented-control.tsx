import type { ReactNode } from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";

export interface SegmentedControlOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly describedBy?: string;
}

interface SegmentedControlProps {
  readonly options: ReadonlyArray<SegmentedControlOption>;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ariaLabel: string;
  /** Every option inert, e.g. while the setting does not apply. */
  readonly disabled?: boolean;
}

/**
 * The pick-one-of-a-few control the grammar's Position/Style/Fine-tune rows
 * share (L-08): `.seg` in the prototype. Radix's radio group supplies the
 * radio semantics and the keyboard (one Tab stop, arrows move and select,
 * Home/End move), with each item drawn as a `Button` rather than the
 * `RadioGroupItem` dot: a native-looking radio has no home in a row this
 * narrow, and `Button`'s `aria-checked` state already paints the "on" fill
 * (`ui/button.tsx`'s `ON_STATE`).
 */
export function SegmentedControl(props: SegmentedControlProps): ReactNode {
  const { options, value, onChange, ariaLabel, disabled } = props;
  return (
    <RadioGroupPrimitive.Root
      aria-label={ariaLabel}
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5"
    >
      {options.map((option) => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          aria-describedby={option.describedBy}
          asChild
        >
          <Button type="button" variant="muted" size="segment">
            {option.label}
          </Button>
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
