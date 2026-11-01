import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  DropdownMenuItem,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";

/**
 * A verb at the end of a row (`Move to Personal`), drawn after the row's
 * secondary text and still its own menu item, so the keyboard reaches it.
 */
export interface EnvironmentPickerRowVerb {
  readonly label: string;
  readonly testId: string;
  readonly onSelect: () => void;
}

/**
 * A radio item keeps a right gutter for the check it may show. A row that is
 * disabled can never be the current pick, so on one that carries a verb the
 * gutter would only push that verb away from the line it continues.
 */
function rowClassName(hasVerb: boolean, disabled: boolean): string {
  if (!hasVerb) return "min-w-0 flex-1 flex-col items-start gap-0.5";
  return disabled
    ? "min-w-0 flex-col items-start gap-0.5 pr-1.5"
    : "min-w-0 flex-col items-start gap-0.5";
}

/**
 * One row of the Environment dropdown: a name, an optional badge, the line
 * under it, and an optional verb that continues that line. Shared by the picker's own rows
 * and the rows its slots fill (the team rows), so every row reads the same.
 * A radio item inside the picker's radio group, keyed by
 * `environmentPickValue`, so the current pick is checked by the menu itself.
 */
export function EnvironmentPickerRow(props: {
  readonly value: string;
  readonly label: string;
  readonly badge: string | null;
  /** What the badge means, on hover; `null` for none. */
  readonly badgeTooltip: string | null;
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
      className={rowClassName(props.verb !== null, props.disabled)}
    >
      <span className="flex min-w-0 items-center gap-1.5 font-medium">
        <span className="truncate">{props.label}</span>
        {props.badge === null ? null : (
          <TooltipWrapper
            label={props.badgeTooltip}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Badge variant="secondary" size="xs">
              {props.badge}
            </Badge>
          </TooltipWrapper>
        )}
      </span>
      <span className="text-ui-xs text-muted-foreground">{props.subtitle}</span>
    </DropdownMenuRadioItem>
  );
  if (props.verb === null) return row;
  // Bottom-aligned beside a row sized to its text, the verb sits on the
  // secondary line: `<subtitle> · Move to Personal`. The two stay separate
  // items, so the keyboard reaches the verb, and the row draws one highlight
  // under both when either is highlighted: the verb reads as part of the row.
  return (
    <div className="flex flex-wrap items-end rounded-md has-[[data-highlighted]]:bg-accent">
      {row}
      <DropdownMenuItem
        data-testid={props.verb.testId}
        onSelect={props.verb.onSelect}
        className="shrink-0"
      >
        <span className="text-ui-xs">
          <span aria-hidden className="text-muted-foreground">
            ·{" "}
          </span>
          <span className="text-primary underline-offset-2 group-focus/dropdown-menu-item:underline hover:underline">
            {props.verb.label}
          </span>
        </span>
      </DropdownMenuItem>
    </div>
  );
}
