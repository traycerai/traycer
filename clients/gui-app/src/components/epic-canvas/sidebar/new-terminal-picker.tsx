/**
 * Picker popover behind the Terminals panel "+" action. Top section picks
 * the host (machine); below it the shared worktree folder list shows
 * everything already bound to the epic. A default row is auto-selected on
 * open (primary workspace, skipping any the host disabled, falling back to the
 * first selectable row); selecting a folder stages it; the footer launch action
 * opens a raw terminal tab bound to that row's host, with the row's
 * `runningDir` persisted as the PTY working directory.
 *
 * Host+folder selection itself lives in `NewTerminalPickerBody`.
 * `PopoverContent` only mounts this body while `isOpen`, so its state
 * (explicit row, launch latch) starts fresh every open without an imperative
 * reset. CMD-T uses the inline opener's own fuzzy workspace sub-page.
 */
import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { NewTerminalPickerBody } from "@/components/epic-canvas/sidebar/new-terminal-picker-body";
import { useTabSurfaceKey } from "@/hooks/host/use-surface-host-pin";
import {
  mintNewEpicTerminalTile,
  type TerminalLaunchTarget,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  usePanelHeaderMenuOpen,
  usePanelHeaderMenuStore,
} from "@/stores/epics/panel-header-menu-store";
import { isHostSwitcherListInteraction } from "@/components/settings/host-scope/host-switcher-portal";

interface NewTerminalPickerProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onBeforeOpen: (() => void) | undefined;
}

export function NewTerminalPicker(props: NewTerminalPickerProps) {
  const { epicId, onBeforeOpen, tabId } = props;
  const surfaceKey = useTabSurfaceKey("new-terminal", tabId);
  const isOpen = usePanelHeaderMenuOpen(tabId, "terminals", "create");
  const setMenuOpen = usePanelHeaderMenuStore((state) => state.setMenuOpen);
  const setIsOpen = useCallback(
    (open: boolean) => setMenuOpen(tabId, "terminals", "create", open),
    [setMenuOpen, tabId],
  );
  // The picker's `PopoverContent` (a modal Radix popover) un-presents by
  // unmounting when its pane is backgrounded, which silently resets the cmdk
  // folder-search query inside `WorktreeFolderListBody` while the root stays
  // logically open. Dismiss the picker on focus loss (the approved semantic) so
  // it never reappears as a logically-open root with reset content.
  const paneFocused = usePaneFocused();
  const [focusedLastRender, setFocusedLastRender] = useState(paneFocused);
  if (paneFocused !== focusedLastRender) {
    setFocusedLastRender(paneFocused);
    if (!paneFocused) setIsOpen(false);
  }
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      // `PopoverContent` mounts `NewTerminalPickerBody` only while open, so the
      // explicit-row reset and double-launch latch that used to be reset here
      // now start fresh with the body itself. Only the caller hook remains.
      if (open) onBeforeOpen?.();
      setIsOpen(open);
    },
    [onBeforeOpen, setIsOpen],
  );

  const handleLaunch = useCallback(
    (target: TerminalLaunchTarget) => {
      navigateNested(epicId, tabId, () =>
        prepareOpenTileInTabFocusTarget(
          tabId,
          mintNewEpicTerminalTile({ ...target, epicId }),
        ),
      );
      setIsOpen(false);
    },
    [navigateNested, prepareOpenTileInTabFocusTarget, epicId, tabId, setIsOpen],
  );

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New terminal"
          data-testid="epic-terminals-panel-add"
          className="text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(90vw,28rem)] gap-0 p-0"
        data-testid="new-terminal-picker-popover"
        // The host picker's list is a nested Radix popover: it portals OUTSIDE
        // this content, so every click in it arrives here as an interaction
        // from outside. Dismissing on those would close the panel the picker
        // exists to scope, and no host could ever be chosen from it.
        onInteractOutside={(event) => {
          if (isHostSwitcherListInteraction(event.target)) {
            event.preventDefault();
          }
        }}
        // Keep Radix from focusing the first focusable element (a host row);
        // the workspace search input auto-focuses itself instead so the user
        // can immediately type/arrow through workspaces.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {isOpen ? (
          <NewTerminalPickerBody
            epicId={epicId}
            surfaceKey={surfaceKey}
            onLaunch={handleLaunch}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
