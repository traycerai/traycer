import type { ReactNode } from "react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

interface SidebarRowMenuTestIds {
  readonly dropdown: string;
  readonly context: string;
}

interface SidebarRowMenuItemEntry {
  readonly kind: "item";
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled: boolean;
  /**
   * Why this entry is unavailable, shown on hover. `null` for every entry whose
   * disabled state is self-explanatory from context (a viewer cannot mutate
   * anything, so every entry greys out at once) - a tooltip is worth its noise
   * only when ONE entry is greyed out among enabled siblings and the reason is
   * not on screen.
   *
   * Independent of `disabled` on purpose: an entry may be disabled with no
   * explanation, but a reason attached to an ENABLED entry would be a lie, so
   * callers must clear this when they clear `disabled`.
   */
  readonly disabledTooltip: string | null;
  readonly variant: "default" | "destructive";
  readonly testIds: SidebarRowMenuTestIds;
  readonly onSelect: () => void;
}

/**
 * Attaches an entry's disabled-reason tooltip.
 *
 * The extra wrapper element is load-bearing, not decoration. Both
 * `DropdownMenuItem` and `ContextMenuItem` carry `data-disabled:pointer-events-none`,
 * so a trigger placed on the item itself (`TooltipWrapper` uses `asChild`)
 * would sit on a node that receives no hover in exactly the disabled state the
 * tooltip exists to explain. Hosting the trigger one level up keeps hover
 * working while the item stays inert.
 */
function SidebarRowMenuItemTooltip(props: {
  readonly tooltip: string | null;
  readonly children: ReactNode;
}) {
  if (props.tooltip === null) return props.children;
  return (
    <TooltipWrapper
      label={props.tooltip}
      side="right"
      sideOffset={undefined}
      align={undefined}
    >
      {/*
       * `role="none"` keeps the ARIA `menu` -> `menuitem` ownership intact.
       * Radix's own item collection is unaffected (it queries
       * `[data-radix-collection-item]` across all descendants), but the
       * accessibility tree only counts OWNED children, so an unmarked generic
       * div here would drop the item from the menu's position/count - and
       * only on the rows that happen to be busy.
       */}
      <div role="none">{props.children}</div>
    </TooltipWrapper>
  );
}

/**
 * Props that disable a menu item WITHOUT removing it from the keyboard.
 *
 * Radix renders a `disabled` item as `focusable: !disabled` and filters it out
 * of typeahead, so a hard-disabled entry cannot be reached by arrow keys at
 * all. For an entry that carries an explanation that is the wrong trade: the
 * hover button is already hidden while a row is busy, so the menu entry is the
 * only surface left, and hard-disabling it makes both the action AND its reason
 * invisible to keyboard and screen-reader users - they see Archive simply
 * vanish, with no signal it exists or why it is unavailable.
 *
 * `aria-disabled` keeps the item focusable and announced as unavailable, and
 * lets the tooltip open on FOCUS as well as hover. Selection is suppressed by
 * preventing the event, so it is inert in the way that matters.
 *
 * An entry disabled with no tooltip (a transient in-flight mutation) stays
 * hard-disabled: there is nothing to read, and it settles on its own.
 */
function softDisabledProps(entry: SidebarRowMenuItemEntry): {
  readonly disabled: boolean;
  readonly ariaDisabled: boolean;
  readonly onSelect: (event: Event) => void;
} {
  const explained = entry.disabled && entry.disabledTooltip !== null;
  if (!explained) {
    return {
      disabled: entry.disabled,
      ariaDisabled: false,
      onSelect: entry.onSelect,
    };
  }
  return {
    disabled: false,
    ariaDisabled: true,
    onSelect: (event: Event) => event.preventDefault(),
  };
}

interface SidebarRowMenuSeparatorEntry {
  readonly kind: "separator";
  readonly id: string;
}

export type SidebarRowMenuEntry =
  SidebarRowMenuItemEntry | SidebarRowMenuSeparatorEntry;

export function SidebarDropdownMenuItems(props: {
  readonly entries: ReadonlyArray<SidebarRowMenuEntry>;
}) {
  return props.entries.map((entry) => {
    if (entry.kind === "separator") {
      return <DropdownMenuSeparator key={entry.id} />;
    }
    const state = softDisabledProps(entry);
    return (
      <SidebarRowMenuItemTooltip key={entry.id} tooltip={entry.disabledTooltip}>
        <DropdownMenuItem
          disabled={state.disabled}
          aria-disabled={state.ariaDisabled}
          className={cn(state.ariaDisabled && "opacity-50")}
          variant={entry.variant}
          data-testid={entry.testIds.dropdown}
          onSelect={state.onSelect}
        >
          {entry.icon}
          {entry.label}
        </DropdownMenuItem>
      </SidebarRowMenuItemTooltip>
    );
  });
}

export function SidebarContextMenuItems(props: {
  readonly entries: ReadonlyArray<SidebarRowMenuEntry>;
}) {
  return props.entries.map((entry) => {
    if (entry.kind === "separator") {
      return <ContextMenuSeparator key={entry.id} />;
    }
    const state = softDisabledProps(entry);
    return (
      <SidebarRowMenuItemTooltip key={entry.id} tooltip={entry.disabledTooltip}>
        <ContextMenuItem
          disabled={state.disabled}
          aria-disabled={state.ariaDisabled}
          className={cn(state.ariaDisabled && "opacity-50")}
          variant={entry.variant}
          data-testid={entry.testIds.context}
          onSelect={state.onSelect}
        >
          {entry.icon}
          {entry.label}
        </ContextMenuItem>
      </SidebarRowMenuItemTooltip>
    );
  });
}
