import { useId, type ReactNode } from "react";
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
 * Attaches an entry's disabled-reason tooltip DIRECTLY to the item, with no
 * element in between.
 *
 * An intermediate wrapper used to be necessary: both `DropdownMenuItem` and
 * `ContextMenuItem` carry `data-disabled:pointer-events-none`, so a trigger on
 * a hard-disabled item would sit on a node that receives no hover in exactly
 * the state the tooltip explains. That no longer applies. A tooltip is only
 * ever rendered for an entry carrying a reason, and every such entry is
 * SOFT-disabled (see {@link softDisabledProps}) - Radix `disabled` is false, so
 * `data-disabled` is absent and the item takes hover itself.
 *
 * Removing the wrapper is not a simplification, it is the fix. Radix Tooltip
 * puts `aria-describedby` on its trigger while open, and per ARIA a
 * `role="presentation"`/`none` is IGNORED on an element carrying any global
 * ARIA property. So a presentational wrapper stopped being presentational at
 * the exact moment a keyboard user focused the busy entry and opened its
 * tooltip - reappearing in the accessibility tree and breaking the
 * `menu` -> `menuitem` ownership it existed to preserve. With the trigger on
 * the item, the item stays a direct child of the menu in every state.
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
      {props.children}
    </TooltipWrapper>
  );
}

/**
 * The ARIA a soft-disabled item needs, as one object to SPREAD.
 *
 * Spread-or-omit rather than `aria-disabled={...}`, because passing `undefined`
 * is not the same as passing nothing. Radix renders
 * `"aria-disabled": disabled || undefined` and THEN spreads the caller's props,
 * and object spread copies a key whose value is `undefined` - so an explicit
 * `undefined` still wins and deletes the `true` Radix derived. A hard-disabled
 * item would then be announced as available while being both inert AND skipped
 * by keyboard navigation. Only a genuinely absent key leaves Radix's value
 * alone.
 */
interface SidebarRowMenuItemAria {
  readonly "aria-disabled": true;
  readonly "aria-describedby": string;
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
function softDisabledProps(
  entry: SidebarRowMenuItemEntry,
  reasonIdPrefix: string,
): {
  readonly disabled: boolean;
  readonly softDisabled: boolean;
  readonly aria: SidebarRowMenuItemAria | null;
  readonly reasonId: string | undefined;
  readonly onSelect: (event: Event) => void;
} {
  const explained = entry.disabled && entry.disabledTooltip !== null;
  if (!explained) {
    return {
      disabled: entry.disabled,
      softDisabled: false,
      aria: null,
      reasonId: undefined,
      onSelect: entry.onSelect,
    };
  }
  const reasonId = `${reasonIdPrefix}${entry.id}`;
  return {
    disabled: false,
    softDisabled: true,
    aria: { "aria-disabled": true, "aria-describedby": reasonId },
    reasonId,
    onSelect: (event: Event) => event.preventDefault(),
  };
}

/**
 * The disabled reason, rendered INSIDE the item and referenced by its
 * `aria-describedby`.
 *
 * The tooltip alone does not carry the reason to a screen reader reliably.
 * Radix Tooltip only sets `aria-describedby` while the tooltip is OPEN, so a
 * user arrowing onto the entry can hear "Archive, dimmed" with no reason
 * attached - and the description would come and go with hover state. This span
 * is always present, so the item describes itself in every state, independent
 * of the tooltip.
 *
 * Rendered inside the item rather than as a sibling so it cannot be orphaned
 * by the portal, and so the id stays scoped to the item that owns it. Radix's
 * typeahead reads the item's `textContent`, so it now sees the reason appended
 * to the label - harmless, because matching is prefix-based and the label
 * comes first.
 *
 * `aria-hidden` keeps it OUT of the item's accessible NAME. `sr-only` hides it
 * visually but leaves it in the name-from-content subtree, so without this the
 * item would be named "Archive" plus the whole refusal - and then announce that
 * same text again as its description. A node referenced directly by
 * `aria-describedby` is still traversed for the description even when hidden
 * (accname), so the relationship survives; only the name is cleaned up.
 */
function SidebarRowMenuItemReason(props: {
  readonly id: string | undefined;
  readonly reason: string | null;
}) {
  if (props.id === undefined || props.reason === null) return null;
  return (
    <span id={props.id} className="sr-only" aria-hidden="true">
      {props.reason}
    </span>
  );
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
  const reasonIdPrefix = useId();
  return props.entries.map((entry) => {
    if (entry.kind === "separator") {
      return <DropdownMenuSeparator key={entry.id} />;
    }
    const state = softDisabledProps(entry, reasonIdPrefix);
    return (
      <SidebarRowMenuItemTooltip key={entry.id} tooltip={entry.disabledTooltip}>
        <DropdownMenuItem
          disabled={state.disabled}
          {...(state.aria ?? {})}
          className={cn(state.softDisabled && "opacity-50")}
          variant={entry.variant}
          data-testid={entry.testIds.dropdown}
          onSelect={state.onSelect}
        >
          {entry.icon}
          {entry.label}
          <SidebarRowMenuItemReason
            id={state.reasonId}
            reason={entry.disabledTooltip}
          />
        </DropdownMenuItem>
      </SidebarRowMenuItemTooltip>
    );
  });
}

export function SidebarContextMenuItems(props: {
  readonly entries: ReadonlyArray<SidebarRowMenuEntry>;
}) {
  const reasonIdPrefix = useId();
  return props.entries.map((entry) => {
    if (entry.kind === "separator") {
      return <ContextMenuSeparator key={entry.id} />;
    }
    const state = softDisabledProps(entry, reasonIdPrefix);
    return (
      <SidebarRowMenuItemTooltip key={entry.id} tooltip={entry.disabledTooltip}>
        <ContextMenuItem
          disabled={state.disabled}
          {...(state.aria ?? {})}
          className={cn(state.softDisabled && "opacity-50")}
          variant={entry.variant}
          data-testid={entry.testIds.context}
          onSelect={state.onSelect}
        >
          {entry.icon}
          {entry.label}
          <SidebarRowMenuItemReason
            id={state.reasonId}
            reason={entry.disabledTooltip}
          />
        </ContextMenuItem>
      </SidebarRowMenuItemTooltip>
    );
  });
}
