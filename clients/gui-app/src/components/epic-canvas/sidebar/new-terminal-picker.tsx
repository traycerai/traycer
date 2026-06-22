/**
 * Picker popover behind the Terminals panel "+" action. Top section picks
 * the host (machine); below it the shared worktree folder list shows
 * everything already bound to the epic. Selecting a folder immediately
 * opens a raw terminal tab bound to that row's host, with the row's
 * `runningDir` persisted as the PTY working directory.
 *
 * The folder query and epic-artifact subscription live in
 * `NewTerminalFolders`, mounted inside the popover content so a closed
 * "+" button subscribes to nothing but its own open state.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { Plus } from "lucide-react";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { WorktreeFolderListBody } from "@/components/worktree/worktree-folder-list-body";
import { WorktreePickerHostSection } from "@/components/worktree/worktree-picker-host-section";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { DEFAULT_TERMINAL_TITLE } from "@/lib/terminals/terminal-title";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

interface NewTerminalPickerProps {
  readonly epicId: string;
  readonly tabId: string;
}

export function NewTerminalPicker(props: NewTerminalPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);

  // A double-click on a folder row fires `onSelect` twice before
  // `setIsOpen(false)` (a state update) can unmount the list, so each click
  // would mint a fresh `term-${uuidv4()}` id and open a second terminal. This
  // synchronous latch collapses one open→pick session to a single terminal;
  // it is reset when the popover (re)opens.
  const hasPickedRef = useRef(false);
  const handleOpenChange = useCallback((open: boolean) => {
    if (open) hasPickedRef.current = false;
    setIsOpen(open);
  }, []);

  const handleSelectRow = useCallback(
    (row: WorktreeBindingSelectorRow) => {
      if (hasPickedRef.current) return;
      hasPickedRef.current = true;
      openTileInTab(props.tabId, {
        id: `term-${uuidv4()}`,
        instanceId: uuidv4(),
        type: "terminal",
        name: DEFAULT_TERMINAL_TITLE,
        hostId: row.hostId,
        cwd: row.runningDir,
      });
      setIsOpen(false);
    },
    [openTileInTab, props.tabId],
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
      >
        <WorktreePickerHostSection />
        <NewTerminalFolders epicId={props.epicId} onSelect={handleSelectRow} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Mounted only while the popover is open (Radix unmounts closed content),
 * so the bindings RPC costs nothing while the "+" button idles.
 */
function NewTerminalFolders(props: {
  readonly epicId: string;
  readonly onSelect: (row: WorktreeBindingSelectorRow) => void;
}) {
  const bindingsQuery = useWorktreeListBindingsForEpic({
    epicId: props.epicId,
    enabled: true,
  });
  const rows = useMemo(
    () => bindingsQuery.data?.rows ?? [],
    [bindingsQuery.data?.rows],
  );

  return (
    <WorktreeFolderListBody
      isPending={bindingsQuery.isPending}
      isError={bindingsQuery.isError}
      rows={rows}
      selectedRow={null}
      secondaryLabel={(row) => row.runningDir}
      onSelect={props.onSelect}
    />
  );
}
