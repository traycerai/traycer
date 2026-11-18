import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSettingsRowDescriptionId } from "@/components/settings/settings-row-description";

const TRIGGER_CLASS = "w-[min(60vw,12rem)]";

/**
 * One `Select` over a string-union setting: the labels record supplies both
 * the options and their order, and the union's own store guard narrows what
 * Radix hands back. Shared by Browser and Opening behavior.
 */
export function EnumSelect<T extends string>(props: {
  /**
   * Options and their order. Each caller declares its own constant as
   * `Record<Union, string>`, so member coverage is checked there.
   */
  readonly labels: Readonly<Record<string, string>>;
  readonly value: T;
  readonly isValue: (value: string) => value is T;
  readonly onValueChange: (value: T) => void;
  /** Verbatim the row's visible label - a spoken name that matches what is read. */
  readonly ariaLabel: string;
}): ReactNode {
  // The row's description, spoken after the name instead of being lost.
  const describedById = useSettingsRowDescriptionId();
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        if (props.isValue(value)) props.onValueChange(value);
      }}
    >
      <SelectTrigger
        aria-label={props.ariaLabel}
        aria-describedby={describedById}
        className={TRIGGER_CLASS}
        size="sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(props.labels).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
