import type { ReactNode } from "react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

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
  readonly variant: "default" | "destructive";
  readonly testIds: SidebarRowMenuTestIds;
  readonly onSelect: () => void;
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
    return (
      <DropdownMenuItem
        key={entry.id}
        disabled={entry.disabled}
        variant={entry.variant}
        data-testid={entry.testIds.dropdown}
        onSelect={entry.onSelect}
      >
        {entry.icon}
        {entry.label}
      </DropdownMenuItem>
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
    return (
      <ContextMenuItem
        key={entry.id}
        disabled={entry.disabled}
        variant={entry.variant}
        data-testid={entry.testIds.context}
        onSelect={entry.onSelect}
      >
        {entry.icon}
        {entry.label}
      </ContextMenuItem>
    );
  });
}
