import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsToggleChip<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly pressed: boolean;
  /**
   * Togglable here, or not. A disabled chip stays in the row and stays
   * announced - it is a choice the current configuration rules out, and
   * removing it would leave nothing for the row's hint to be about.
   */
  readonly disabled: boolean;
}

interface SettingsToggleChipsProps<Value extends string> {
  readonly chips: ReadonlyArray<SettingsToggleChip<Value>>;
  readonly onToggle: (value: Value) => void;
  /** Names the SET, not a chip - each chip's own label names itself. */
  readonly ariaLabel: string;
  /** Stands in for an empty set, which is a state and not an error. */
  readonly emptyLabel: string;
}

/**
 * A set of independent on/off choices as one row of chips.
 *
 * A switch per choice is the right shape while there are three of them and a
 * sentence to say about each; it is the wrong shape for a provider's rolling
 * windows, where the labels are `5h` / `wk` / `Opus wk` and the row count is
 * whatever the account happens to report. Chips put the whole set on one line,
 * which is also how the strip draws it.
 *
 * They are real toggle buttons, not checkboxes styled flat: `aria-pressed`
 * carries the state and a `<button>` brings Enter and Space with it, so
 * keyboard operation needs no handler of its own. A disabled chip is
 * `aria-disabled` rather than `disabled` - it keeps its place in the tab order
 * and can still be read, which is what makes the row's hint reachable.
 */
export function SettingsToggleChips<Value extends string>(
  props: SettingsToggleChipsProps<Value>,
): ReactNode {
  if (props.chips.length === 0) {
    return (
      <span className="text-ui-sm text-muted-foreground">
        {props.emptyLabel}
      </span>
    );
  }
  return (
    <div
      role="group"
      aria-label={props.ariaLabel}
      className="flex max-w-full flex-wrap items-center justify-end gap-1"
    >
      {props.chips.map((chip) => (
        <button
          key={chip.value}
          type="button"
          aria-pressed={chip.pressed}
          aria-disabled={chip.disabled}
          onClick={() => {
            if (chip.disabled) return;
            props.onToggle(chip.value);
          }}
          className={cn(
            "inline-flex items-center rounded-md border px-2 py-1 text-ui-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            chip.pressed
              ? "border-primary/40 bg-primary/15 text-foreground"
              : "border-border bg-foreground/3 text-muted-foreground hover:text-foreground",
            chip.disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
