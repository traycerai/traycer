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
   * `null` for every entry whose disabled state is self-explanatory from context (a viewer cannot mutate anything, so every entry greys out at once) - a tooltip is worth its noise only when ONE entry is greyed out among enabled siblings and the reason is not on screen.
   * Independent of `disabled` on purpose: an entry may be disabled with no explanation, but a reason attached to an ENABLED entry would be a lie, so callers must clear this when they clear `disabled`.
   */
  readonly disabledTooltip: string | null;
  readonly variant: "default" | "destructive";
  readonly testIds: SidebarRowMenuTestIds;
  readonly onSelect: () => void;
}

/**
 * A tooltip is only ever rendered for an entry carrying a reason, and every such entry is SOFT-disabled (see {@link softDisabledProps}) - Radix `disabled` is false, so `data-disabled` is absent and the item takes hover itself.
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

/** Only a genuinely absent key leaves Radix's value alone. */
interface SidebarRowMenuItemAria {
  readonly "aria-disabled": true;
  readonly "aria-describedby": string;
}

/**
 * Props that disable a menu item WITHOUT removing it from the keyboard.
 * Radix renders a `disabled` item as `focusable: !disabled` and filters it out of typeahead, so a hard-disabled entry cannot be reached by arrow keys at all.
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
 * Radix Tooltip only sets `aria-describedby` while the tooltip is OPEN, so a user arrowing onto the entry can hear "Archive, dimmed" with no reason attached - and the description would come and go with hover state.
 * Rendered inside the item rather than as a sibling so it cannot be orphaned by the portal, and so the id stays scoped to the item that owns it.
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
  | SidebarRowMenuItemEntry
  | SidebarRowMenuSeparatorEntry;

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
