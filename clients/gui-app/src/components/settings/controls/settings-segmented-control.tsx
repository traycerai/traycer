import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsSegmentedOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

interface SettingsSegmentedControlProps<Value extends string> {
  readonly value: Value;
  readonly options: ReadonlyArray<SettingsSegmentedOption<Value>>;
  readonly onChange: (next: Value) => void;
  /** Names the CHOICE, not the option - the pressed state names the option. */
  readonly ariaLabel: string;
}

/**
 * A two-or-three-way choice rendered as one pressed segment among its
 * alternatives - the shape `ThemeModeToggle` already uses for light/dark/system,
 * generalised over the value union so a panel does not need a bespoke control
 * per setting.
 *
 * A segmented control rather than a `Select` wherever every alternative is one
 * short word: the options are then readable without opening anything, and the
 * current one is visible in the row rather than behind a trigger.
 */
export function SettingsSegmentedControl<Value extends string>(
  props: SettingsSegmentedControlProps<Value>,
): ReactNode {
  const { value, options, onChange, ariaLabel } = props;
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-foreground/3 p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (active) return;
              onChange(option.value);
            }}
            className={cn(
              "inline-flex items-center rounded-sm px-3 py-1 text-ui-sm transition-colors",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
