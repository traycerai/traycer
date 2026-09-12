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
  /**
   * A live figure drawn at the row's right edge, or `null` for a row that has
   * none - a gauge and its percentage, in the surfaces where the thing being
   * checked has a current reading.
   *
   * DECORATIVE by construction: the control wraps it `aria-hidden`, so nothing
   * a caller draws here can change what the box is called. `announcement` is
   * how the same fact reaches a screen reader, which is also what keeps the two
   * from being read out twice.
   */
  readonly trailing: ReactNode;
  /**
   * Appended to the box's accessible name as `sr-only` text, or `null`. Starts
   * with its own separator (`, 57% used`) because it is joined to the label
   * with no space - two inline spans inside one `<label>` are one name.
   */
  readonly announcement: string | null;
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
 *
 * Rows are full width and their `trailing` figures are pushed to the right
 * edge, so a column of them reads as one track rather than as a figure trailing
 * each label at whatever width that label happened to be. That is the only
 * reason the rows stretch; with no figures the labels sit exactly where
 * `items-start` used to put them.
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
      className="flex max-w-full flex-col gap-1.5"
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
          {/* The label alone, keyed for anything reading the list's entries in
            order: the box's accessible name and the row's text both carry the
            figures beside it, so neither is the label any more. */}
          <span data-testid="settings-checkbox-list-label">{item.label}</span>
          {item.announcement === null ? null : (
            <span className="sr-only">{item.announcement}</span>
          )}
          {item.trailing === null ? null : (
            <span
              aria-hidden
              className="ml-auto flex min-w-0 items-center gap-1.5 pl-3"
            >
              {item.trailing}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}
