import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarDropdownMenuItems } from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";
import { terminalRowMenuEntries } from "@/components/epic-canvas/sidebar/terminal-row-menu-entries";
import {
  useEpicTerminalRowActions,
  type EpicTerminalRowAuthority,
} from "@/components/epic-canvas/sidebar/use-epic-terminals-panel";
import { SwitcherRenameDialog } from "@/components/epic-canvas/mobile/switcher-rename-dialog";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import type { ListedTerminalSidebarSession } from "@/lib/terminals/reconcile-terminal-sidebar-sessions";

/**
 * The per-row "…" actions for a raw terminal in the mobile switcher: the same
 * Rename and Close the desktop row offers, gated by the same lifetime
 * authority (a durable row renames and closes through the host projection, a
 * compatibility row through the legacy manager RPCs, an unreachable or
 * capability-unknown one not at all). Only the rename affordance differs -
 * desktop edits the row in place, which has no touch analog, so this opens the
 * shared rename dialog and drives the identical mutation from it.
 *
 * Editor-gated on top of that: a viewer's mutation is server-rejected, so an
 * ungated menu would only lead to a dead end.
 */
export function SwitcherTerminalRowActions(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string;
  readonly session: ListedTerminalSidebarSession;
  readonly durable: boolean;
  readonly authority: EpicTerminalRowAuthority;
}) {
  const { authority, durable, epicId, hostId, session, tabId } = props;
  const canMutate = isEditableRole(useEpicPermissionRole());
  const [renameOpen, setRenameOpen] = useState(false);
  const actions = useEpicTerminalRowActions({
    epicId,
    tabId,
    hostId,
    session,
    durable,
    authority,
  });

  if (!canMutate) return null;

  const entries = terminalRowMenuEntries({
    closeDisabled: actions.closeDisabled,
    onStartRename: () => setRenameOpen(true),
    renameDisabled: !actions.canRename,
    onRequestClose: actions.requestClose,
    testIds: {
      rename: {
        dropdown: `switcher-terminal-rename-${session.sessionId}`,
        context: `switcher-terminal-context-rename-${session.sessionId}`,
      },
      close: {
        dropdown: `switcher-terminal-close-${session.sessionId}`,
        context: `switcher-terminal-context-close-${session.sessionId}`,
      },
    },
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${actions.label}`}
            data-testid={`switcher-more-${session.sessionId}`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <SidebarDropdownMenuItems entries={entries} />
        </DropdownMenuContent>
      </DropdownMenu>
      <SwitcherRenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename terminal"
        initialValue={actions.label}
        nodeId={session.sessionId}
        onSubmit={(value) =>
          actions.submitRename(value, () => setRenameOpen(false))
        }
      />
    </>
  );
}
