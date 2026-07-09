/**
 * Picker popover behind the Terminals panel "+" action. Top section picks
 * the host (machine); below it the shared worktree folder list shows
 * everything already bound to the epic. A default row is auto-selected on
 * open (primary workspace, skipping any the host disabled, falling back to the
 * first selectable row); selecting a folder stages it; the footer launch action
 * opens a raw terminal tab bound to that row's host, with the row's
 * `runningDir` persisted as the PTY working directory.
 *
 * The bindings query is gated on the popover's open state so a closed "+"
 * button subscribes to nothing but its own open state.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
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
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { DEFAULT_TERMINAL_TITLE } from "@/lib/terminals/terminal-title";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

interface NewTerminalPickerProps {
  readonly epicId: string;
  readonly tabId: string;
}

export function NewTerminalPicker(props: NewTerminalPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  // The user's explicit pick. Null means "follow the auto-selected default";
  // the effective selection is derived below so a default never has to be
  // written into state via an effect.
  const [explicitRow, setExplicitRow] =
    useState<WorktreeBindingSelectorRow | null>(null);
  const activeHostId = useReactiveActiveHostId();
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );

  // Gated on `isOpen` so the "+" button costs no RPC while idle; the query
  // becomes active only while the popover is open.
  const bindingsQuery = useWorktreeListBindingsForEpic({
    epicId: props.epicId,
    enabled: isOpen,
  });
  const rows = useMemo(
    () => bindingsQuery.data?.rows ?? [],
    [bindingsQuery.data?.rows],
  );
  // Explicit pick wins while it stays selectable; otherwise auto-select the
  // default (primary, skipping disabled rows, falling back to the first
  // selectable one). Derived rather than stored so a row going missing while
  // open re-resolves to a healthy default without an effect.
  const selectedRow = useMemo(
    () => resolveTerminalSelection(explicitRow, rows),
    [explicitRow, rows],
  );
  const hasLoadedNoRows =
    isOpen &&
    !bindingsQuery.isPending &&
    !bindingsQuery.isError &&
    rows.length === 0;
  // The fallback cwd for folderless launches rides the bindings response
  // (`worktree.listBindingsForEpic@1.1`). `null` means the host predates
  // folderless workspaces (bridged v1.0 response), so launch stays disabled.
  const folderlessCwd = bindingsQuery.data?.folderlessCwd ?? null;
  const folderlessCwdFailed = hasLoadedNoRows && folderlessCwd === null;
  const launchTarget = useMemo(
    () =>
      selectedRow === null
        ? resolveFolderlessTerminalTarget(
            hasLoadedNoRows,
            activeHostId,
            folderlessCwd,
          )
        : { hostId: selectedRow.hostId, cwd: selectedRow.runningDir },
    [activeHostId, folderlessCwd, hasLoadedNoRows, selectedRow],
  );

  // A double-click on the launch action fires twice before `setIsOpen(false)`
  // can unmount the popover, so each click would mint a fresh terminal id. This
  // synchronous latch collapses one open->launch session to a single terminal.
  const hasLaunchedRef = useRef(false);
  const handleOpenChange = useCallback((open: boolean) => {
    if (open) {
      hasLaunchedRef.current = false;
      setExplicitRow(null);
    }
    setIsOpen(open);
  }, []);

  const handleLaunch = useCallback(() => {
    if (hasLaunchedRef.current || launchTarget === null) return;
    hasLaunchedRef.current = true;
    navigateNested(props.epicId, props.tabId, () =>
      prepareOpenTileInTabFocusTarget(props.tabId, {
        id: `term-${uuidv4()}`,
        instanceId: uuidv4(),
        type: "terminal",
        name: DEFAULT_TERMINAL_TITLE,
        titleSource: "default",
        hostId: launchTarget.hostId,
        cwd: launchTarget.cwd,
      }),
    );
    setIsOpen(false);
  }, [
    navigateNested,
    prepareOpenTileInTabFocusTarget,
    props.epicId,
    props.tabId,
    launchTarget,
  ]);

  const handleSelectRow = useCallback((row: WorktreeBindingSelectorRow) => {
    setExplicitRow(row);
  }, []);

  const launchDisabled = launchTarget === null;
  let folderlessCwdStatus: ReactNode = null;
  if (folderlessCwdFailed) {
    folderlessCwdStatus = (
      <span
        className="text-destructive"
        data-testid="new-terminal-folderless-cwd-error"
      >
        Couldn't resolve terminal directory.
      </span>
    );
  }

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
        // Keep Radix from focusing the first focusable element (a host row);
        // the workspace search input auto-focuses itself instead so the user
        // can immediately type/arrow through workspaces.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <WorktreePickerHostSection />
        <WorktreeFolderListBody
          isPending={bindingsQuery.isPending}
          isError={bindingsQuery.isError}
          rows={rows}
          selectedRow={selectedRow}
          secondaryLabel={(row) => row.runningDir}
          onSelect={handleSelectRow}
          autoFocusSearch
        />
        <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-2.5 py-2.5">
          <div className="min-w-0 text-xs text-muted-foreground">
            {folderlessCwdStatus}
          </div>
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
 * Default row for the terminal picker, mirroring the git diff panel's
 * `pickDefaultRow`: skip rows the host disabled (setup pending/failed, missing
 * worktree, ...), prefer the primary directory the agent runs in, and otherwise
 * take the first selectable row. Returns null when nothing is selectable so
 * Launch stays disabled. Terminals don't require a git repo, so selectability
 * is just `disabledReason === null` (unlike the git surfaces' `isGitSelectable`).
 */
function pickDefaultTerminalRow(
  rows: ReadonlyArray<WorktreeBindingSelectorRow>,
): WorktreeBindingSelectorRow | null {
  const selectable = rows.filter((row) => row.disabledReason === null);
  if (selectable.length === 0) return null;
  return selectable.find((row) => row.isPrimary) ?? selectable[0];
}

/**
 * The user's explicit pick wins while it stays selectable; if it vanishes or
 * the host disables it (e.g. its worktree goes missing), fall back to the
 * default. Re-reads the row from the live list so a selected row keeps fresh
 * fields across binding updates.
 */
function resolveTerminalSelection(
  explicit: WorktreeBindingSelectorRow | null,
  rows: ReadonlyArray<WorktreeBindingSelectorRow>,
): WorktreeBindingSelectorRow | null {
  if (explicit !== null) {
    const explicitKey = worktreeRowKey(explicit);
    const live = rows.find(
      (row) =>
        worktreeRowKey(row) === explicitKey && row.disabledReason === null,
    );
    if (live !== undefined) return live;
  }
  return pickDefaultTerminalRow(rows);
}

interface TerminalLaunchTarget {
  readonly hostId: string;
  readonly cwd: string;
}

function resolveFolderlessTerminalTarget(
  enabled: boolean,
  hostId: string | null,
  cwd: string | null,
): TerminalLaunchTarget | null {
  if (!enabled || hostId === null || cwd === null || cwd.length === 0) {
    return null;
  }
  return { hostId, cwd };
}
