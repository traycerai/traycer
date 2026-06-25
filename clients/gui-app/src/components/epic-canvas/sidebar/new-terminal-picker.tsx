/**
 * Picker popover behind the Terminals panel "+" action. Top section picks
 * the host (machine); below it the shared worktree folder list shows
 * everything already bound to the epic. Selecting a folder stages it; the
 * footer launch action opens a raw terminal tab bound to that row's host, with
 * the row's `runningDir` persisted as the PTY working directory.
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
  const [selectedRow, setSelectedRow] =
    useState<WorktreeBindingSelectorRow | null>(null);
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);

  // A double-click on the launch action fires twice before `setIsOpen(false)`
  // can unmount the popover, so each click would mint a fresh terminal id. This
  // synchronous latch collapses one open->launch session to a single terminal.
  const hasLaunchedRef = useRef(false);
  const handleOpenChange = useCallback((open: boolean) => {
    if (open) {
      hasLaunchedRef.current = false;
      setSelectedRow(null);
    }
    setIsOpen(open);
  }, []);

  const handleLaunch = useCallback(() => {
    if (hasLaunchedRef.current || selectedRow === null) return;
    hasLaunchedRef.current = true;
    openTileInTab(props.tabId, {
      id: `term-${uuidv4()}`,
      instanceId: uuidv4(),
      type: "terminal",
      name: DEFAULT_TERMINAL_TITLE,
      hostId: selectedRow.hostId,
      cwd: selectedRow.runningDir,
    });
    setIsOpen(false);
  }, [openTileInTab, props.tabId, selectedRow]);

  const handleSelectRow = useCallback((row: WorktreeBindingSelectorRow) => {
    setSelectedRow(row);
  }, []);

  const launchDisabled = selectedRow === null;

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
        <NewTerminalFolders
          epicId={props.epicId}
          selectedRow={selectedRow}
          onSelect={handleSelectRow}
        />
        <div className="flex justify-end border-t border-border/60 bg-muted/20 px-2.5 py-2.5">
          <Button
            type="button"
            size="sm"
            disabled={launchDisabled}
            onClick={handleLaunch}
          >
            Launch
          </Button>
        </div>
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
  readonly selectedRow: WorktreeBindingSelectorRow | null;
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
      selectedRow={props.selectedRow}
      secondaryLabel={(row) => row.runningDir}
      onSelect={props.onSelect}
    />
  );
}
