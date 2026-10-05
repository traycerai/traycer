import { useId, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { RevertButton } from "@/components/layout-editor/inspector/inspector-row";
import { useLayoutFormHost } from "@/components/layout-editor/inspector/layout-form-host";
import { RowAvailabilityLine } from "@/components/layout-editor/inspector/rows/row-availability-line";
import { useSortableRowPadding } from "@/components/layout-editor/inspector/sortable-row-padding";
import {
  rowAvailabilityText,
  type ShownRowAvailability,
} from "@/components/layout-editor/regions/row-availability";
import { cn } from "@/lib/utils";

/**
 * A form row that is not a member of a list: an area's own settings (Placement,
 * Side) and the rows a list row's disclosure opens (Location, Style, Limits).
 * The same columns a list row draws - grip slot, icon slot, label with its
 * revert and description, then the control and the chevron slot -
 * so every row of an area lines up, in both hosts.
 *
 * One line: the label on the left, the control on the right, vertically
 * centred. `stacked` is for a control that is a list of its own (a checklist,
 * the Limits picker): it sits under the label, starting in the label column.
 *
 * It is also the row shell for what a row depends on (P1): `depth` 1 indents
 * it under the row that controls it, and `availability` is drawn in the
 * description slot (`RowAvailabilityLine`). The control sits in a `fieldset`,
 * so a disabled row's control is really disabled - out of the tab order and
 * announced as unavailable - while the group stays named by the label and
 * described by the reason. The label greys under ANY disabled fieldset, which
 * is how a row greys with its Hidden region too.
 */
export function LayoutFormRow(props: {
  /** The Settings-search anchor this row answers to, or `null`. */
  readonly anchor: string | null;
  /** The row's icon, or `null` for a detail row, whose icon column stays empty. */
  readonly icon: LucideIcon | null;
  readonly label: string;
  /** Text, or text carrying an inline link; `null` for none. */
  readonly description: ReactNode;
  readonly control: ReactNode;
  /** Present only while the row differs from what shipped: the revert after its label. */
  readonly onRevert: (() => void) | null;
  readonly revertLabel: string;
  readonly stacked: boolean;
  /** The row the editor's canvas has selected, highlighted as a selected list row is. */
  readonly selected: boolean;
  readonly availability: ShownRowAvailability;
  /** 1 under the row that controls it (`orderedRows`), else 0. */
  readonly depth: 0 | 1;
}): ReactNode {
  const { anchor, label, description, control, onRevert, stacked } = props;
  const { availability, depth } = props;
  const page = useLayoutFormHost() === "page";
  const gutter = useSortableRowPadding();
  const labelId = useId();
  const lineId = useId();
  const disabled = availability.kind === "disabled";
  const described = rowAvailabilityText(availability) !== null;
  return (
    <div
      data-settings-anchor={anchor ?? undefined}
      data-layout-form-row
      data-row-depth={depth}
      data-row-availability={availability.kind}
      className={cn(
        "flex items-center gap-2 border-b border-border/40 last:border-b-0",
        stacked
          ? "flex-wrap gap-y-2"
          : page && "max-md:flex-wrap max-md:gap-y-3",
        gutter.row,
        props.selected && "bg-foreground/6 shadow-[inset_2px_0_0_var(--ring)]",
      )}
    >
      <div
        className={cn(
          // Top-aligned, so the icon sits on the label's line rather than in
          // the middle of the label and its description.
          "flex min-w-0 flex-1 items-start gap-2",
          stacked ? "basis-full" : page && "max-md:basis-full",
          // One level in, under the row that controls it.
          depth === 1 && "pl-5",
        )}
      >
        <span aria-hidden className="size-3.5 shrink-0" />
        <span aria-hidden className="flex h-lh shrink-0 items-center">
          {props.icon === null ? (
            <span className="size-3.5" />
          ) : (
            <props.icon className="size-3.5 text-muted-foreground" />
          )}
        </span>
        <RowLabelColumn
          labelId={labelId}
          lineId={lineId}
          label={label}
          description={description}
          onRevert={onRevert}
          revertLabel={props.revertLabel}
          availability={availability}
          page={page}
        />
      </div>
      <RowControlGroup
        disabled={disabled}
        labelId={described ? labelId : null}
        lineId={described ? lineId : null}
        className={
          stacked
            ? cn("basis-full", depth === 1 ? "pl-16" : "pl-11")
            : cn("flex shrink-0 items-center", page && "max-md:ml-auto")
        }
      >
        {control}
      </RowControlGroup>
      {stacked ? null : <span aria-hidden className="size-3.5 shrink-0" />}
    </div>
  );
}

/**
 * The label column: the name with its revert, the description, and what the
 * row depends on, in that order and one type size.
 */
function RowLabelColumn(props: {
  readonly labelId: string;
  readonly lineId: string;
  readonly label: string;
  readonly description: ReactNode;
  readonly onRevert: (() => void) | null;
  readonly revertLabel: string;
  readonly availability: ShownRowAvailability;
  readonly page: boolean;
}): ReactNode {
  const { onRevert, description, availability, page } = props;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1">
        <span
          id={props.labelId}
          className={cn(
            "min-w-0 in-[fieldset:disabled]:text-muted-foreground",
            availability.kind === "disabled" && "text-muted-foreground",
          )}
        >
          {props.label}
        </span>
        {/* The revert follows the name it puts back; its negative margin
          keeps a 24px button from making this line taller than the text
          and nudging the description down when a value changes. */}
        {onRevert === null ? null : (
          <span className="-my-1 flex shrink-0">
            <RevertButton onRevert={onRevert} label={props.revertLabel} />
          </span>
        )}
      </div>
      {description === null ? null : (
        <p
          className={cn(
            "mt-0.5 max-w-[72ch] text-pretty text-muted-foreground",
            page ? "text-ui-sm" : "text-ui-xs",
          )}
        >
          {description}
        </p>
      )}
      <RowAvailabilityLine
        id={props.lineId}
        availability={availability}
        layoutClassName={null}
      />
    </div>
  );
}

/**
 * The control's group: disabled with the row, named by its label and
 * described by its reason while it has one. The four utilities undo the UA's
 * own fieldset box, which Tailwind's preflight does not reset.
 */
function RowControlGroup(props: {
  readonly disabled: boolean;
  readonly labelId: string | null;
  readonly lineId: string | null;
  readonly className: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <fieldset
      disabled={props.disabled}
      aria-labelledby={props.labelId ?? undefined}
      aria-describedby={props.lineId ?? undefined}
      className={cn("m-0 min-w-0 border-0 p-0", props.className)}
    >
      {props.children}
    </fieldset>
  );
}
