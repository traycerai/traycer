import { isMarkdownArtifactKind } from "@/lib/artifacts/node-display";
import { useArtifactById } from "@/lib/epic-selectors";
import { useCallback, useState, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { FileDown, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
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
import {
  useSwitcherRename,
  type SwitcherRowKind,
} from "@/components/epic-canvas/mobile/use-switcher-rename";
import { useEpicPermissionRole, useEpicNodeHostId } from "@/lib/epic-selectors";
import { useSidebarRowDropdownMount } from "@/components/epic-canvas/sidebar/use-sidebar-row-dropdown-mount";
import { isEditableRole } from "@/lib/epic-permissions";
import {
  describeTreeDeleteDisclosure,
  selectNestedAgentsKnown,
} from "@/lib/epic-tree-cascade";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useEpicDeleteChat } from "@/hooks/epic/use-epic-chat-mutations";
import { useChatWriteRoute } from "@/hooks/epic/use-chat-write-route";
import { CHAT_NOT_ADOPTED_COPY } from "@/stores/epics/open-epic/chat-write-routing";
import { useEpicDeleteTuiAgent } from "@/hooks/epic/use-epic-tui-agent-mutations";
import { useEpicExportArtifacts } from "@/hooks/epic/use-epic-export-artifacts-mutation";
import { hasNestedMarkdownArtifacts } from "@/lib/artifacts/artifact-export-selection";
import { useEpicDeleteArtifact } from "@/hooks/epic/use-epic-node-mutations";
import type { ArtifactExportFormat } from "@/lib/artifacts/artifact-export";
import { useTerminalKillFor } from "@/hooks/terminal/use-terminal-kill-for-mutation";
import { useDeletedArtifactsAvailable } from "@/hooks/epic/use-deleted-artifacts-available";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  findOpenArtifactInTab,
  findOpenTileInTab,
} from "@/stores/epics/canvas/canvas-selectors";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

interface SwitcherRowActionsProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly kind: SwitcherRowKind;
  /** Content id: the node id for agents/artifacts, the session id for a PTY. */
  readonly nodeId: string;
  readonly name: string;
}

const RENAME_TITLE: Record<SwitcherRowKind, string> = {
  chat: "Rename agent",
  "terminal-agent": "Rename agent",
  artifact: "Rename artifact",
  terminal: "Rename terminal",
};

const EXPORT_LABELS: Record<ArtifactExportFormat, string> = {
  markdown: "Export as Markdown",
  pdf: "Export as PDF",
};

const EXPORT_NESTED_LABELS: Record<ArtifactExportFormat, string> = {
  markdown: "Export with nested artifacts as Markdown ZIP",
  pdf: "Export with nested artifacts as PDF ZIP",
};

interface RowMenuInput {
  readonly nodeId: string;
  readonly kind: SwitcherRowKind;
  readonly canMutate: boolean;
  readonly chatWriteUnavailable: boolean;
  readonly canExport: boolean;
  readonly canExportNested: boolean;
  readonly exportPending: boolean;
  readonly closePending: boolean;
  readonly onExport: (
    format: ArtifactExportFormat,
    includeNested: boolean,
  ) => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}

function rowMenuEntries(
  input: RowMenuInput,
): ReadonlyArray<SidebarRowMenuEntry> {
  const { nodeId, kind, canMutate, chatWriteUnavailable } = input;
  const isTerminal = kind === "terminal";
  const disabledTooltip = chatWriteUnavailable ? CHAT_NOT_ADOPTED_COPY : null;
  const exportEntry = (
    format: ArtifactExportFormat,
    includeNested: boolean,
  ): SidebarRowMenuEntry => ({
    kind: "item",
    id: includeNested ? `export-nested-${format}` : `export-${format}`,
    label: includeNested ? EXPORT_NESTED_LABELS[format] : EXPORT_LABELS[format],
    icon: <FileDown className="size-3.5" />,
    disabled: input.exportPending,
    disabledTooltip: null,
    variant: "default",
    testIds: includeNested
      ? {
          dropdown: `switcher-export-nested-${format}-${nodeId}`,
          context: `switcher-export-nested-${format}-ctx-${nodeId}`,
        }
      : {
          dropdown: `switcher-export-${format}-${nodeId}`,
          context: `switcher-export-${format}-ctx-${nodeId}`,
        },
    onSelect: () => input.onExport(format, includeNested),
  });
  return [
    ...(input.canExport
      ? [
          exportEntry("markdown", false),
          exportEntry("pdf", false),
          ...(input.canExportNested
            ? [exportEntry("markdown", true), exportEntry("pdf", true)]
            : []),
          { kind: "separator" as const, id: "after-export" },
        ]
      : []),
    {
      kind: "item",
      id: "rename",
      label: "Rename",
      icon: <Pencil className="size-3.5" />,
      disabled: !canMutate || chatWriteUnavailable,
      disabledTooltip,
      variant: "default",
      testIds: {
        dropdown: `switcher-rename-${nodeId}`,
        context: `switcher-rename-ctx-${nodeId}`,
      },
      onSelect: input.onRename,
    },
    { kind: "separator", id: "before-delete" },
    {
      kind: "item",
      id: "delete",
      label: isTerminal ? "Close" : "Delete",
      icon: <Trash2 className="size-3.5" />,
      disabled:
        !canMutate || (isTerminal ? input.closePending : chatWriteUnavailable),
      disabledTooltip,
      variant: "destructive",
      testIds: {
        dropdown: `switcher-delete-${nodeId}`,
        context: `switcher-delete-ctx-${nodeId}`,
      },
      onSelect: input.onDelete,
    },
  ];
}

/**
 * The per-row "…" actions for the switcher's flat lists: Rename + Delete for
 * agents/artifacts (delete confirmed), Rename + Close for PTY terminals (Close
 * is immediate, matching desktop parity), and Export ahead of those on an
 * artifact row - the phone has no hover or right-click, so this menu is the
 * only way to reach the desktop sidebar's export items. Reuses the exact
 * desktop mutation hooks and the shared row-menu item renderer. Export is a
 * read, so an artifact row keeps its menu for a viewer with Rename and Delete
 * disabled, as the desktop row does; every other kind is editor-gated (a
 * viewer gets no menu at all, so no dead-end mutations). Delete also closes
 * the item's open canvas tile so the mobile view never lands on a dead tile.
 */
export function SwitcherRowActions(props: SwitcherRowActionsProps) {
  const canMutate = isEditableRole(useEpicPermissionRole());
  if (!canMutate && props.kind !== "artifact") return null;
  // Keyed on the role so a change of access remounts the row's actions: a
  // dialog opened as an editor is gone for good once access is lost, rather
  // than staying submittable or reappearing on its own if access comes back.
  return (
    <SwitcherRowActionsGate
      key={canMutate ? "editor" : "viewer"}
      {...props}
      canMutate={canMutate}
    />
  );
}

/**
 * The "…" alone until it is pressed. The body behind it is a menu root, two
 * dialogs and every mutation hook a row might need, and a list draws one of
 * these per row: on a task with a thousand artifacts that is what the switcher
 * spent most of its seconds mounting. The sidebar's first-use mount hook opens
 * the body on the press itself and replays a keyboard open on the mounted
 * trigger, so the first press behaves as the trigger would have, focus on the
 * first item included.
 */
function SwitcherRowActionsGate(
  props: SwitcherRowActionsProps & { readonly canMutate: boolean },
) {
  const {
    mounted,
    open,
    setOpen,
    triggerIdProps,
    triggerRef,
    onPointerDown,
    onKeyDown,
    onClick,
  } = useSidebarRowDropdownMount(false);
  const trigger = (
    <Button
      type="button"
      variant="muted"
      size="icon-sm"
      ref={triggerRef}
      {...triggerIdProps}
      aria-label={`Actions for ${props.name}`}
      aria-haspopup="menu"
      aria-expanded={open}
      data-state={open ? "open" : "closed"}
      data-slot="dropdown-menu-trigger"
      data-testid={`switcher-more-${props.nodeId}`}
      className="shrink-0"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      <MoreHorizontal className="size-4" />
    </Button>
  );
  if (!mounted) return trigger;
  return (
    <SwitcherRowActionsBody
      {...props}
      trigger={trigger}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

function SwitcherRowActionsBody(
  props: SwitcherRowActionsProps & {
    readonly canMutate: boolean;
    readonly trigger: ReactElement;
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  },
) {
  const { epicId, tabId, kind, nodeId, name, canMutate, trigger, open } = props;
  const [renameOpen, setRenameOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Rename and Delete both reach `ChatRegistryWriter` for a chat row, so both
  // are gated together. `"artifact"` and `"terminal"` rows are never chats.
  const writeRoute = useChatWriteRoute(kind === "chat", nodeId);
  const chatWriteUnavailable = writeRoute === "unavailable";
  const deleteChat = useEpicDeleteChat();
  const ownerHostId = useEpicNodeHostId(nodeId);
  const sessionHostId = useEpicSessionHostId();
  const mutationHostId = ownerHostId ?? sessionHostId;
  const rename = useSwitcherRename(epicId, mutationHostId);
  const deleteTuiAgent = useEpicDeleteTuiAgent();
  const deleteArtifact = useEpicDeleteArtifact(nodeId);
  const exportArtifacts = useEpicExportArtifacts();
  const artifact = useArtifactById(nodeId);
  const restoreAvailable = useDeletedArtifactsAvailable(sessionHostId);
  // The sentence the sidebar row gives for the same tree, and subscribed to
  // its ANSWER as the sidebar rows are. `useShallow` is required, not
  // decorative: the selector mints a fresh object each call.
  const deleteDisclosure = useEpicStore(
    useShallow((state: OpenEpicState) =>
      kind === "artifact"
        ? describeTreeDeleteDisclosure({
            tree: state.tree,
            kind: "artifact",
            nodeIds: [nodeId],
            restoreAvailable,
          })
        : describeTreeDeleteDisclosure({
            tree: state.tree,
            kind: "agent",
            includeNestedAgents: false,
            nodeIds: [nodeId],
            nestedAgentsKnown: selectNestedAgentsKnown(state),
          }),
    ),
  );
  // Document export requires a Markdown body.
  const canExport =
    kind === "artifact" && isMarkdownArtifactKind(artifact?.kind);
  const canExportNested = useEpicStore(
    (state: OpenEpicState) =>
      canExport && hasNestedMarkdownArtifacts(state, nodeId),
  );
  // The row's terminal lives on the host the switcher LISTS (the Epic
  // session's), so kill goes to that same client - never the ambient one.
  const killTerminal = useTerminalKillFor(
    useEpicSessionHostClient(),
    "Couldn't close the terminal.",
    true,
  );

  const navigateNested = useEpicNestedFocusNavigation();
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );

  // Deleting/closing an item that is open must also close its canvas tile, or
  // the single mobile tile view would keep rendering a now-dead tile.
  const closeOpenTile = useCallback(() => {
    const found =
      kind === "artifact"
        ? findOpenArtifactInTab(tabId, nodeId)
        : findOpenTileInTab(tabId, {
            id: nodeId,
            type: kind,
            hostId: mutationHostId,
          });
    if (found === null) return;
    navigateNested(
      epicId,
      tabId,
      () =>
        prepareCloseCanvasTabFocusTarget(tabId, found.paneId, found.instanceId),
      "user",
    );
  }, [
    epicId,
    kind,
    mutationHostId,
    nodeId,
    navigateNested,
    prepareCloseCanvasTabFocusTarget,
    tabId,
  ]);

  const submitRename = useCallback(
    (title: string) => {
      rename(kind, nodeId, title);
      setRenameOpen(false);
    },
    [kind, nodeId, rename],
  );

  const confirmDelete = useCallback(() => {
    if (kind === "chat")
      deleteChat.mutate({ epicId, chatId: nodeId, hostId: mutationHostId });
    else if (kind === "terminal-agent")
      deleteTuiAgent.mutate({
        epicId,
        tuiAgentId: nodeId,
        hostId: mutationHostId,
      });
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
    mutationHostId,
  ]);

  // Terminal "Close" terminates the PTY immediately (no confirm - desktop
  // parity), closing the open tile first so the action is mount-independent.
  const closeTerminal = useCallback(() => {
    if (killTerminal.isPending) return;
    closeOpenTile();
    killTerminal.mutate({ sessionId: nodeId });
  }, [closeOpenTile, killTerminal, nodeId]);

  const isTerminal = kind === "terminal";
  const deletePending =
    deleteChat.isPending ||
    deleteTuiAgent.isPending ||
    deleteArtifact.isPending;

  const entries = rowMenuEntries({
    nodeId,
    kind,
    canMutate,
    chatWriteUnavailable,
    canExport,
    canExportNested,
    exportPending: exportArtifacts.isPending,
    closePending: killTerminal.isPending,
    onExport: (format, includeNested) =>
      exportArtifacts.mutate({
        artifacts: [{ id: nodeId, title: name }],
        format,
        archive: includeNested,
        archiveTitle: includeNested ? name : null,
        includeNested,
      }),
    onRename: () => setRenameOpen(true),
    onDelete: isTerminal ? closeTerminal : () => setConfirmOpen(true),
  });

  return (
    <>
      <DropdownMenu open={open} onOpenChange={props.onOpenChange}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-max">
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
          blockedReason={null}
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Delete "${name}"?`}
          description={deleteDisclosure.description}
          cascadeSummary={deleteDisclosure.cascadeSummary}
          cascadeNestedUnder={deleteDisclosure.cascadeNestedUnder}
          actionLabel="Delete"
          isPending={deletePending}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}
