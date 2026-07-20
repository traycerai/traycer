/**
 * Picker popover behind the Terminals panel "+" action. Top section picks
 * the host (machine); below it the shared worktree folder list shows
 * everything already bound to the epic. A default row is auto-selected on
 * open (primary workspace, skipping any the host disabled, falling back to the
 * first selectable row); selecting a folder stages it; the footer launch action
 * opens a raw terminal tab bound to that row's host, with the row's
 * `runningDir` persisted as the PTY working directory.
 *
 * Host+folder selection itself lives in `NewTerminalPickerBody`, shared with
 * the Cmd+K palette's "Create new terminal" dialog. `PopoverContent` only
 * mounts this body while `isOpen`, so its state (explicit row, launch latch)
 * starts fresh every open without an imperative reset.
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
import {
  buildTerminalTileRef,
  type TerminalLaunchTarget,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

interface NewTerminalPickerProps {
  readonly epicId: string;
  readonly tabId: string;
}

export function NewTerminalPicker(props: NewTerminalPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );

  const handleLaunch = useCallback(
    (target: TerminalLaunchTarget) => {
      navigateNested(props.epicId, props.tabId, () =>
        prepareOpenTileInTabFocusTarget(
          props.tabId,
          buildTerminalTileRef(target),
        ),
      );
      setIsOpen(false);
    },
    [
      navigateNested,
      prepareOpenTileInTabFocusTarget,
      props.epicId,
      props.tabId,
    ],
  );

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
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
        // Keep Radix from focusing the first focusable element (a host row);
        // the workspace search input auto-focuses itself instead so the user
        // can immediately type/arrow through workspaces.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {isOpen ? (
          <NewTerminalPickerBody
            epicId={props.epicId}
            onLaunch={handleLaunch}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
