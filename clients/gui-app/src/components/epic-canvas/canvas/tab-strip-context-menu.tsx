import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";

import {
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  Pencil,
} from "lucide-react";

import type { SplitDirection } from "@/stores/epics/canvas/types";

export interface TabStripContextMenuProps {
  readonly groupId: string;
  readonly tabId: string;
  readonly canCloseRight: boolean;
  readonly onClose: (groupId: string, tabId: string) => void;
  readonly onCloseOthers: (groupId: string, tabId: string) => void;
  readonly onCloseRight: (groupId: string, tabId: string) => void;
  readonly onCloseAll: (groupId: string) => void;
  readonly onSplit: (
    groupId: string,
    tabId: string,
    axis: SplitDirection,
    leading: boolean,
  ) => void;
  readonly onRevealInSidebar: (tabId: string) => void;
  /** Copies the absolute path for workspace-file tabs; absent for other kinds. */
  readonly onCopyFilePath: (() => void) | null;
  /**
   * Commit handler for inline title editing. Consumed by the tab item when
   * the rename is committed (Enter / blur), not by the menu itself - the menu
   * only triggers `onEditTitle` to enter edit mode.
   */
  readonly onRename: (groupId: string, tabId: string, title: string) => void;
  /** Whether this tab kind can be renamed (chat / artifact / terminal). */
  readonly canRename: boolean;
  /** Switches the tab title into the inline editable input. */
  readonly onEditTitle: () => void;
}

/**
 * Right-click menu rendered inside a `<ContextMenu>` parent. The
 * close-family items map to the canvas store's `closeTab*` actions; the
 * split-family items move this tab into a new group on the chosen
 * edge. `Reveal in Sidebar` activates the panel that owns the tab's
 * artifact and scrolls the tree to highlight it.
 */
export function TabStripContextMenu(props: TabStripContextMenuProps) {
  const {
    groupId,
    tabId,
    canCloseRight,
    onClose,
    onCloseOthers,
    onCloseRight,
    onCloseAll,
    onSplit,
    onRevealInSidebar,
    onCopyFilePath,
    canRename,
    onEditTitle,
  } = props;

  return (
    <ContextMenuContent
      className="w-56"
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      <ContextMenuItem onSelect={() => onClose(groupId, tabId)}>
        Close
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onCloseOthers(groupId, tabId)}>
        Close Others
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!canCloseRight}
        onSelect={() => onCloseRight(groupId, tabId)}
      >
        Close to the Right
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onCloseAll(groupId)}>
        Close All
      </ContextMenuItem>
      {canRename ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onEditTitle}>
            <Pencil className="size-4" />
            Edit Title
          </ContextMenuItem>
        </>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => onSplit(groupId, tabId, "vertical", true)}
      >
        <ChevronUp className="size-4" />
        Split Up
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => onSplit(groupId, tabId, "vertical", false)}
      >
        <ChevronDown className="size-4" />
        Split Down
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => onSplit(groupId, tabId, "horizontal", true)}
      >
        <ChevronLeft className="size-4" />
        Split Left
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => onSplit(groupId, tabId, "horizontal", false)}
      >
        <ChevronRight className="size-4" />
        Split Right
      </ContextMenuItem>
      <ContextMenuSeparator />
      {onCopyFilePath === null ? null : (
        <ContextMenuItem onSelect={onCopyFilePath}>
          <Copy className="size-4" />
          Copy File Path
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => onRevealInSidebar(tabId)}>
        <Eye className="size-4" />
        Reveal in Sidebar
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
