import type { ReactNode } from "react";
import { useSettingsRowDescriptionId } from "@/components/settings/settings-row-description";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export interface SettingsCheckboxListItem<Value> {
  /**
   * Stable per-item identity, for React and for anything keying off a row.
   * Carried beside `value` rather than derived from it, so `value` can be a
   * shape a call site can switch on exhaustively instead of a string it has to
   * recognise by spelling.
   */
  readonly key: string;
  readonly value: Value;
  readonly label: string;
  readonly checked: boolean;
  /**
   * Held in its current state. A disabled item stays in the list and stays
   * announced - it is the one entry the configuration cannot do without - and
   * the rule it enforces is said in the row's description, which this control
   * points `aria-describedby` at for exactly that reason.
   */
  readonly disabled: boolean;
}

interface SettingsCheckboxListProps<Value> {
  readonly items: ReadonlyArray<SettingsCheckboxListItem<Value>>;
  readonly onToggle: (value: Value) => void;
  /** Names the LIST, not an item - each item's own label names itself. */
  readonly ariaLabel: string;
}

/**
 * A set of independent on/off choices as one column of labelled checkboxes.
 *
 * The chip row (`settings-toggle-chips.tsx`) is the right shape while every
 * label is a token - `5h` / `wk` / `Fable` - and the choices are peers. It is
 * the wrong shape once one entry is a sentence rather than a token and the
 * rest are its alternatives: `Tightest limit (automatic)` beside `5h` reads as
 * two kinds of thing on one line, and a column with a box per row reads as one
 * list with one rule.
 *
 * Each row is a `<label>` wrapping the box, so its text is a click target and
 * the box takes its accessible name from it. A disabled row is genuinely
 * `disabled` rather than `aria-disabled`, which takes it out of the tab order -
 * so the group carries `aria-describedby` to its `SettingsRow` description,
 * where the rule that held it is stated. `SettingsToggleChips` makes the
 * opposite call because a chip has a row HINT to keep reachable; here the rule
 * is in the description, and an entry that cannot be clicked should not invite
 * the attempt.
 */
export function SettingsCheckboxList<Value>(
  props: SettingsCheckboxListProps<Value>,
): ReactNode {
  const describedById = useSettingsRowDescriptionId();
  return (
    <div
      role="group"
      aria-label={props.ariaLabel}
      aria-describedby={describedById}
      className="flex max-w-full flex-col items-start gap-1.5"
    >
      {props.items.map((item) => (
        <label
          key={item.key}
          className={cn(
            "flex items-center gap-2 text-ui-sm",
            item.disabled
              ? "cursor-default text-muted-foreground"
              : "cursor-pointer text-foreground",
          )}
        >
          <Checkbox
            checked={item.checked}
            disabled={item.disabled}
            onCheckedChange={(next) => {
              if (next === "indeterminate") return;
              props.onToggle(item.value);
            }}
          />
          <span>{item.label}</span>
        </label>
      ))}
    </div>
  );
}
