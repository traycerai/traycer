import type { HarnessModelRow } from "@/components/home/data/harness-model-search";
import { Badge } from "@/components/ui/badge";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

interface HarnessModelPickerItemProps {
  readonly idPrefix: string;
  readonly row: HarnessModelRow;
  readonly selected: boolean;
  readonly active: boolean;
  readonly showCapacity: boolean;
  readonly onHover: (rowId: string) => void;
  readonly onActive: (rowId: string) => void;
  readonly onSelect: (row: HarnessModelRow) => void;
}

export function HarnessModelPickerItem(props: HarnessModelPickerItemProps) {
  const {
    idPrefix,
    row,
    selected,
    active,
    showCapacity,
    onHover,
    onActive,
    onSelect,
  } = props;

  // Search is scoped to the active harness, so rows render identically whether
  // browsing or searching: the `browseLabel` (which drops the OpenCode upstream
  // prefix now carried by the group header) and no redundant harness context.
  const capacityLabel =
    showCapacity && row.capacityLabel !== null ? row.capacityLabel : null;
  // Same "has a notice" predicate TooltipWrapper uses (null or empty string is
  // no notice), so the badge never renders without the tooltip behind it.
  const hasDeprecationNotice =
    row.deprecationNotice !== null && row.deprecationNotice.length > 0;

  return (
    // Anchored to the row button itself (not the inner Badge) so the notice is
    // reachable by keyboard: the button is natively focusable and Radix merges
    // the tooltip's hover/focus handlers with the button's own via `asChild`,
    // whereas a span nested inside it never receives Tab focus. `label={null}`
    // for non-deprecated rows makes this a transparent pass-through (see
    // TooltipWrapper) - never add tabIndex to the Badge to "fix" this instead,
    // that nests a focusable element inside the button, which is invalid.
    <TooltipWrapper
      label={row.deprecationNotice}
      side="top"
      sideOffset={6}
      align="center"
    >
      <button
        id={modelRowElementId(idPrefix, row.id)}
        type="button"
        role="option"
        aria-selected={selected}
        data-active={active}
        data-selected={selected}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
          // Hover/keyboard active: subtle, transient feedback.
          active && "bg-accent/30",
          // Selected: the prominent persistent state (matches the primary Check).
          // Listed last so tailwind-merge lets it win when you hover the selected
          // row - the selection stays loud, hover just adds nothing extra.
          selected && "bg-accent/70",
        )}
        onMouseEnter={() => {
          onHover(row.id);
          onActive(row.id);
        }}
        onFocus={() => {
          onActive(row.id);
        }}
        onClick={() => {
          onSelect(row);
        }}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium leading-5">
            {row.browseLabel}
          </span>
        </span>
        {hasDeprecationNotice ? (
          <Badge variant="destructive" className="shrink-0">
            Deprecated
          </Badge>
        ) : null}
        {capacityLabel === null ? null : (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-ui-xs text-muted-foreground">
            {capacityLabel}
          </span>
        )}
        {selected ? (
          <Check className="size-4 shrink-0 text-primary" />
        ) : (
          <span className="size-4 shrink-0" />
        )}
      </button>
    </TooltipWrapper>
  );
}

function modelRowElementId(idPrefix: string, rowId: string): string {
  return `${idPrefix}-row-${rowId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
