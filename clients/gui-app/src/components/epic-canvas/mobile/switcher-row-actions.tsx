import { useCallback, useState } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarDropdownMenuItems,
  type SidebarRowMenuEntry,
} from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { SwitcherRenameDialog } from "@/components/epic-canvas/mobile/switcher-rename-dialog";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import {
  useEpicDeleteChat,
  useEpicRenameChat,
} from "@/hooks/epic/use-epic-chat-mutations";
import {
  useEpicDeleteTuiAgent,
  useEpicRenameTuiAgent,
} from "@/hooks/epic/use-epic-tui-agent-mutations";
import {
  useEpicDeleteArtifact,
  useEpicRenameArtifact,
} from "@/hooks/epic/use-epic-node-mutations";
import { useTerminalRename } from "@/hooks/terminal/use-terminal-rename-mutation";
import { useTerminalKill } from "@/hooks/terminal/use-terminal-kill-mutation";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

export type SwitcherRowKind =
  "chat" | "terminal-agent" | "artifact" | "terminal";

interface SwitcherRowActionsProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly kind: SwitcherRowKind;
  /** Content id: the node id for agents/artifacts, the session id for a PTY. */
  readonly nodeId: string;
  readonly name: string;
  /** "… and N nested" summary for a cascading delete; null when none / N/A. */
  readonly cascadeSummary: string | null;
}

const RENAME_TITLE: Record<SwitcherRowKind, string> = {
  chat: "Rename agent",
  "terminal-agent": "Rename agent",
  artifact: "Rename artifact",
  terminal: "Rename terminal",
};

/**
 * The per-row "…" actions for the switcher's flat lists: Rename + Delete for
 * agents/artifacts (delete confirmed), Rename + Close for PTY terminals (Close
 * is immediate, matching desktop parity). Reuses the exact desktop mutation
 * hooks and the shared row-menu item renderer; the whole affordance is
 * editor-gated (a viewer gets no menu at all, so no dead-end mutations). Delete
 * also closes the item's open canvas tile so the mobile view never lands on a
 * dead tile.
 */
export function SwitcherRowActions(props: SwitcherRowActionsProps) {
  const { epicId, tabId, kind, nodeId, name, cascadeSummary } = props;
  const canMutate = isEditableRole(useEpicPermissionRole());
  const [renameOpen, setRenameOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const renameChat = useEpicRenameChat();
  const renameTuiAgent = useEpicRenameTuiAgent();
  const renameArtifact = useEpicRenameArtifact(true);
  const renameTerminal = useTerminalRename();
  const deleteChat = useEpicDeleteChat();
  const deleteTuiAgent = useEpicDeleteTuiAgent();
  const deleteArtifact = useEpicDeleteArtifact();
  const killTerminal = useTerminalKill();

  const navigateNested = useEpicNestedFocusNavigation();
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );

  // Deleting/closing an item that is open must also close its canvas tile, or
  // the single mobile tile view would keep rendering a now-dead tile.
  const closeOpenTile = useCallback(() => {
    const found = findOpenArtifactInTab(tabId, nodeId);
    if (found === null) return;
    navigateNested(epicId, tabId, () =>
      prepareCloseCanvasTabFocusTarget(tabId, found.paneId, found.instanceId),
    );
  }, [epicId, nodeId, navigateNested, prepareCloseCanvasTabFocusTarget, tabId]);

  const submitRename = useCallback(
    (title: string) => {
      if (kind === "chat") renameChat.mutate({ epicId, chatId: nodeId, title });
      else if (kind === "terminal-agent")
        renameTuiAgent.mutate({ epicId, tuiAgentId: nodeId, title });
      else if (kind === "artifact")
        renameArtifact.mutate({ epicId, artifactId: nodeId, title });
      else renameTerminal.mutate({ sessionId: nodeId, title });
      setRenameOpen(false);
    },
    [
      epicId,
      kind,
      nodeId,
      renameArtifact,
      renameChat,
      renameTerminal,
      renameTuiAgent,
    ],
  );

  const confirmDelete = useCallback(() => {
    if (kind === "chat")
      deleteChat.mutate(
        { epicId, chatId: nodeId },
        { onSuccess: closeOpenTile },
      );
    else if (kind === "terminal-agent")
      deleteTuiAgent.mutate(
        { epicId, tuiAgentId: nodeId },
        { onSuccess: closeOpenTile },
      );
    else if (kind === "artifact")
      deleteArtifact.mutate(
        { epicId, artifactId: nodeId },
        { onSuccess: closeOpenTile },
      );
    setConfirmOpen(false);
  }, [
    closeOpenTile,
    deleteArtifact,
    deleteChat,
    deleteTuiAgent,
    epicId,
    kind,
    nodeId,
  ]);

  // Terminal "Close" terminates the PTY immediately (no confirm - desktop
  // parity), closing the open tile first so the action is mount-independent.
  const closeTerminal = useCallback(() => {
    if (killTerminal.isPending) return;
    closeOpenTile();
    killTerminal.mutate({ sessionId: nodeId });
  }, [closeOpenTile, killTerminal, nodeId]);

  if (!canMutate) return null;

  const isTerminal = kind === "terminal";
  const deleteLabel = isTerminal ? "Close" : "Delete";
  const deletePending =
    deleteChat.isPending ||
    deleteTuiAgent.isPending ||
    deleteArtifact.isPending;

  const entries: ReadonlyArray<SidebarRowMenuEntry> = [
    {
      kind: "item",
      id: "rename",
      label: "Rename",
      icon: <Pencil className="size-3.5" />,
      disabled: false,
      disabledTooltip: null,
      variant: "default",
      testIds: {
        dropdown: `switcher-rename-${nodeId}`,
        context: `switcher-rename-ctx-${nodeId}`,
      },
      onSelect: () => setRenameOpen(true),
    },
    { kind: "separator", id: "before-delete" },
    {
      kind: "item",
      id: "delete",
      label: deleteLabel,
      icon: <Trash2 className="size-3.5" />,
      disabled: isTerminal ? killTerminal.isPending : false,
      disabledTooltip: null,
      variant: "destructive",
      testIds: {
        dropdown: `switcher-delete-${nodeId}`,
        context: `switcher-delete-ctx-${nodeId}`,
      },
      onSelect: isTerminal ? closeTerminal : () => setConfirmOpen(true),
    },
  ];

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${name}`}
            data-testid={`switcher-more-${nodeId}`}
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
        title={RENAME_TITLE[kind]}
        initialValue={name}
        nodeId={nodeId}
        onSubmit={submitRename}
      />
      {isTerminal ? null : (
        <ConfirmDestructiveDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Delete "${name}"?`}
          description={
            kind === "artifact"
              ? "This permanently deletes the artifact."
              : "This permanently deletes the agent and its history."
          }
          cascadeSummary={cascadeSummary}
          actionLabel="Delete"
          isPending={deletePending}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}
