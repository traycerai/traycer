import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { RevertButton } from "@/components/layout-editor/inspector/inspector-row";
import { useLayoutFormHost } from "@/components/layout-editor/inspector/layout-form-host";
import { useSortableRowPadding } from "@/components/layout-editor/inspector/sortable-row-padding";
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
}): ReactNode {
  const { anchor, label, description, control, onRevert, stacked } = props;
  const page = useLayoutFormHost() === "page";
  const gutter = useSortableRowPadding();
  return (
    <div
      data-settings-anchor={anchor ?? undefined}
      data-layout-form-row
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
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="min-w-0">{label}</span>
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
        </div>
      </div>
      {stacked ? (
        <div className="basis-full pl-11">{control}</div>
      ) : (
        <>
          <div
            className={cn(
              "flex shrink-0 items-center",
              page && "max-md:ml-auto",
            )}
          >
            {control}
          </div>
          <span aria-hidden className="size-3.5 shrink-0" />
        </>
      )}
    </div>
  );
}
