import { Pencil, Trash2 } from "lucide-react";
import type { SidebarRowMenuEntry } from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";

/**
 * Per-surface test ids for the two terminal row actions. The actions
 * themselves - which entries exist, in what order, with which labels and
 * disabled state - are the same everywhere; only what a test grabs them by
 * follows the surface's own naming.
 */
export interface TerminalRowMenuTestIds {
  readonly rename: { readonly dropdown: string; readonly context: string };
  readonly close: { readonly dropdown: string; readonly context: string };
}

export interface TerminalRowMenuEntriesProps {
  readonly closeDisabled: boolean;
  readonly onStartRename: () => void;
  readonly renameDisabled: boolean;
  readonly onRequestClose: () => void;
  readonly testIds: TerminalRowMenuTestIds;
}

/**
 * The "…" menu of a raw-terminal row: Rename, then a destructive Close.
 * Shared so a phone's menu can never quietly offer fewer actions - or
 * differently-gated ones - than the desktop row it mirrors.
 */
export function terminalRowMenuEntries(
  props: TerminalRowMenuEntriesProps,
): ReadonlyArray<SidebarRowMenuEntry> {
  return [
    {
      kind: "item",
      id: "rename",
      label: "Rename",
      icon: <Pencil className="size-3.5" />,
      disabled: props.renameDisabled,
      disabledTooltip: null,
      variant: "default",
      testIds: props.testIds.rename,
      onSelect: props.onStartRename,
    },
    { kind: "separator", id: "before-close" },
    {
      kind: "item",
      id: "close",
      label: "Close",
      icon: <Trash2 className="size-3.5" />,
      disabled: props.closeDisabled,
      disabledTooltip: null,
      variant: "destructive",
      testIds: props.testIds.close,
      onSelect: props.onRequestClose,
    },
  ];
}
