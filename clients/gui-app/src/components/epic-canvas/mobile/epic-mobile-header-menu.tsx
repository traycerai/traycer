import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { EllipsisVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
import {
  useRegisteredEpicPermissionRole,
  useRegisteredEpicTitle,
} from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { NewTerminalPickerBody } from "@/components/epic-canvas/sidebar/new-terminal-picker-body";
import {
  buildTerminalTileRef,
  type TerminalLaunchTarget,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
import { useEpicUpdateTitle } from "@/hooks/epic/use-epic-title-mutation";

interface EpicHeaderIdentity {
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * Fills Phase 0's mobile-header right-actions slot on the epic route with a "⋮"
 * overflow menu: **New chat**, **New terminal**, and **Rename**.
 *
 * Rendered by `MobileAppHeader` (inside the app provider stack, OUTSIDE the
 * epic session tree), so it derives epic state from app-global registries keyed
 * on `epicId` - never epic-session React context. The stored element only
 * closes over the stable route ids; everything volatile (title, permission,
 * mutation) is read from hooks here, so there is no stale closure. See
 * {@link MobileEpicHeaderActionsBinder} for why this stays a `ReactNode` slot.
 *
 * Both actions require edit rights: New chat mirrors the desktop sidebar's
 * `canMutate` editable gate (`epic-sidebar-chat-tree.tsx` - a viewer's create is
 * server-rejected, so an ungated item would open a dead-end modal), and Rename
 * is likewise editor-only. A viewer therefore has no actions, so the whole
 * trigger is hidden (no empty menu). The role reads through
 * `useRegisteredEpicPermissionRole` + `isEditableRole` - the same predicate on
 * the same permission the sidebar uses, via the header-safe registry accessor
 * (not a parallel check). The transient `!isDisconnected` half of desktop's
 * `canMutate` is intentionally not mirrored - there is no app-global connection
 * accessor to read without inventing a parallel check, and a disconnected
 * editor only hits the modal's own submit gate (self-heals on reconnect), not a
 * permanent dead-end.
 */
export function EpicMobileHeaderMenu(props: EpicHeaderIdentity) {
  const { epicId, tabId } = props;
  const role = useRegisteredEpicPermissionRole(epicId);
  const canEdit = isEditableRole(role);
  const [renameOpen, setRenameOpen] = useState(false);
  const [terminalPickerOpen, setTerminalPickerOpen] = useState(false);

  const handleNewChat = () => {
    // The exact desktop funnel (see NewConversationModalAction): force chat
    // mode, then open the shared New Conversation modal request for this epic.
    // NewConversationModalHost (mounted on the active epic route) renders it.
    useNewConversationModalStore.getState().setComposerMode(epicId, "chat");
    useNewConversationModalOpenStore.getState().open({
      epicId,
      tabId,
      placement: ACTIVE_TILE_PLACEMENT,
      parentId: null,
      hostId: null,
    });
  };

  // No editable action for a viewer -> no trigger at all (avoids an empty menu
  // and the viewer new-chat dead-end).
  if (!canEdit) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Epic actions"
            data-testid="mobile-epic-actions-trigger"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <EllipsisVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={handleNewChat}>New chat</DropdownMenuItem>
          <DropdownMenuItem
            data-testid="mobile-epic-new-terminal"
            onSelect={() => setTerminalPickerOpen(true)}
          >
            New terminal
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            Rename
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EpicRenameDialog
        epicId={epicId}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <NewTerminalDialog
        epicId={epicId}
        tabId={tabId}
        open={terminalPickerOpen}
        onOpenChange={setTerminalPickerOpen}
      />
    </>
  );
}

interface NewTerminalDialogProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Dialog shell around the shared raw-terminal picker body (the same host +
 * folder picker the Terminals panel "+" popover uses). A dropdown item can't
 * anchor a popover - the menu unmounts on select - so the mobile entry hosts
 * the body in a dialog instead. Mounted only while open, so picker state and
 * its bindings query reset per open.
 */
function NewTerminalDialog(props: NewTerminalDialogProps) {
  const { epicId, tabId, open, onOpenChange } = props;
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  // Same launch wiring as the sidebar "+" popover (`NewTerminalPicker`): the
  // shared body only reports the picked target; opening the tile is the
  // shell's job.
  const handleLaunch = useCallback(
    (target: TerminalLaunchTarget) => {
      navigateNested(epicId, tabId, () =>
        prepareOpenTileInTabFocusTarget(tabId, buildTerminalTileRef(target)),
      );
      onOpenChange(false);
    },
    [
      navigateNested,
      prepareOpenTileInTabFocusTarget,
      epicId,
      tabId,
      onOpenChange,
    ],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(92vw,28rem)] max-w-[min(92vw,28rem)] gap-0 p-0"
        data-testid="mobile-epic-new-terminal-dialog"
        // The picker's workspace search input auto-focuses itself; keep Radix
        // from grabbing focus for the first host row instead.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="border-b border-border/60 px-4 py-3">
          <DialogTitle>New terminal</DialogTitle>
          <DialogDescription className="sr-only">
            Pick a host and folder for the new terminal.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <NewTerminalPickerBody epicId={epicId} onLaunch={handleLaunch} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface EpicRenameDialogProps {
  readonly epicId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

function EpicRenameDialog(props: EpicRenameDialogProps) {
  const { epicId, open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,28rem)] max-w-[min(92vw,28rem)]">
        <DialogHeader>
          <DialogTitle>Rename epic</DialogTitle>
          <DialogDescription>Give this epic a new name.</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open (Radix unmounts closed content), so the form
            re-seeds from the current title on every open without an effect. */}
        {open ? (
          <EpicRenameForm epicId={epicId} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EpicRenameForm(props: {
  readonly epicId: string;
  readonly onDone: () => void;
}) {
  const { epicId, onDone } = props;
  const currentTitle = useRegisteredEpicTitle(epicId) ?? "";
  const [value, setValue] = useState(currentTitle);
  const updateTitle = useEpicUpdateTitle();
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !updateTitle.isPending;

  const handleSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    // Reuse the canonical epic-rename mutation. The active epic route's
    // title sync (use-epic-route-synchronization) mirrors the resulting epic
    // title into the header title, so no separate tab-name write is needed.
    updateTitle.mutate(
      { epicDelta: { id: epicId, title: trimmed, updatedAt: Date.now() } },
      { onSuccess: () => onDone() },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Radix Dialog moves focus to the first focusable element (this input)
          on open, so no autoFocus prop is needed. */}
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label="Epic title"
        data-testid="mobile-epic-rename-input"
      />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!canSubmit}
          data-testid="mobile-epic-rename-save"
        >
          Save
          {updateTitle.isPending ? (
            <AgentSpinningDots
              className="size-3.5"
              testId="mobile-epic-rename-pending"
              variant="dots2"
            />
          ) : null}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Fills / clears the mobile-header right-actions slot for the ACTIVE epic
 * route. Mounted once (from the active epic's route effects), self-gated on
 * `useIsMobileViewport()`. The slot stores a `ReactNode` element (Phase 0 shape kept):
 * this is safe because the element is a self-contained component keyed only on
 * the stable `{epicId, tabId}` route ids - it re-reads volatile state from its
 * own hooks each header render, so nothing goes stale. A render-fn slot would
 * be isomorphic (a fn returning the same element) but a larger store change; a
 * baked-in menu that closed over epic-session handlers WOULD go stale, which is
 * exactly what this shape avoids.
 */
export function MobileEpicHeaderActionsBinder(props: EpicHeaderIdentity) {
  const { epicId, tabId } = props;
  const isMobile = useIsMobileViewport();
  const setRightActions = useMobileHeaderStore((s) => s.setRightActions);

  useEffect(() => {
    if (!isMobile) return;
    setRightActions(<EpicMobileHeaderMenu epicId={epicId} tabId={tabId} />);
    return () => setRightActions(null);
  }, [isMobile, epicId, tabId, setRightActions]);

  return null;
}
