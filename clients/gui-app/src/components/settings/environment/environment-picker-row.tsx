import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenuItem,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";

/** A verb at the end of a row (`Move to Personal`), its own menu item. */
export interface EnvironmentPickerRowVerb {
  readonly label: string;
  readonly testId: string;
  readonly onSelect: () => void;
}

/**
 * One row of the Environment dropdown: a name, an optional badge, the line
 * under it, and an optional verb at its end. Shared by the picker's own rows
 * and the rows its slots fill (P1's team rows), so every row reads the same.
 * A radio item inside the picker's radio group, keyed by
 * `environmentPickValue`, so the current pick is checked by the menu itself.
 */
export function EnvironmentPickerRow(props: {
  readonly value: string;
  readonly label: string;
  readonly badge: string | null;
  readonly subtitle: string;
  /** Indented under Personal, as a Local row is. */
  readonly nested: boolean;
  readonly disabled: boolean;
  readonly testId: string;
  readonly onSelect: () => void;
  readonly verb: EnvironmentPickerRowVerb | null;
}): ReactNode {
  const row = (
    <DropdownMenuRadioItem
      value={props.value}
      inset={props.nested}
      data-testid={props.testId}
      disabled={props.disabled}
      onSelect={props.onSelect}
      className="min-w-0 flex-1 flex-col items-start gap-0.5"
    >
      <span className="flex min-w-0 items-center gap-1.5 font-medium">
        <span className="truncate">{props.label}</span>
        {props.badge === null ? null : (
          <Badge variant="secondary" size="xs">
            {props.badge}
          </Badge>
        )}
      </span>
      <span className="text-ui-xs text-muted-foreground">{props.subtitle}</span>
    </DropdownMenuRadioItem>
  );
  if (props.verb === null) return row;
  return (
    <div className="flex items-center gap-1">
      {row}
      <DropdownMenuItem
        data-testid={props.verb.testId}
        onSelect={props.verb.onSelect}
        className="shrink-0"
      >
        {props.verb.label}
      </DropdownMenuItem>
    </div>
  );
}
