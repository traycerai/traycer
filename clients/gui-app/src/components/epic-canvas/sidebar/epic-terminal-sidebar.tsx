/**
 * Host-driven raw-terminal list rendered as a left-panel rail entry. Durable
 * rows come from the authoritative `terminal.plain.list` collection stream;
 * `terminal.list` supplies compatibility rows such as setup/provider-login
 * shells (terminals do not live in the Y.Doc). Click a row to open or focus
 * that session as a canvas tab; the "+" action opens a fresh terminal whose
 * tile creates the underlying PTY on mount.
 *
 * Rows, states and per-row mutations all come from `useEpicTerminalsPanel` /
 * `useEpicTerminalRowActions`, which the phone switcher's Terminals category
 * mounts too; this file owns only the desktop chrome around them (drag to a
 * pane, hover "…", context menu, inline rename).
 *
 * Exports `TerminalsPanelBody` and `TerminalsPanelActions` consumed by
 * `epic-sidebar.tsx`'s `PANEL_COMPONENTS["terminals"]`. Agent terminals
 * (`terminal-agent` artifacts) live in the Agents panel instead.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { v4 as uuidv4 } from "uuid";
import { useDraggable } from "@dnd-kit/core";
import { MoreHorizontal, Terminal as TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { NewTerminalPicker } from "@/components/epic-canvas/sidebar/new-terminal-picker";
import { SnapshotGate } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import { TerminalsPanelSkeleton } from "@/components/epic-canvas/skeletons/terminals-panel-skeleton";
import {
  getTerminalTileDragId,
  getPaneScopedDndId,
  TERMINAL_TILE_DND_TYPE,
  type EpicCanvasTerminalTileDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { useDragSourceDisabled } from "@/components/epic-canvas/dnd/use-drag-source-disabled";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { OwnerResourceChip } from "@/components/resources/resource-usage-chip";
import { cn } from "@/lib/utils";
import {
  findOpenTileInTab,
  useEpicCanvasStore,
  useIsActiveTile,
} from "@/stores/epics/canvas/store";
import {
  useEpicLeftPanelStore,
  useLeftPanelSectionCollapsed,
} from "@/stores/epics/left-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  SidebarContextMenuItems,
  SidebarDropdownMenuItems,
} from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";
import { terminalRowMenuEntries } from "@/components/epic-canvas/sidebar/terminal-row-menu-entries";
import {
  useEpicTerminalRowActions,
  useEpicTerminalsPanel,
  type EpicTerminalRowAuthority,
  type EpicTerminalsPanel,
} from "@/components/epic-canvas/sidebar/use-epic-terminals-panel";
import {
  FailedTerminalCreateRow,
  TerminalsEmptyState,
  TerminalsErrorState,
  TerminalsLoadingState,
} from "@/components/epic-canvas/sidebar/terminal-list-states";
import { epicTerminalUiIdentityKey } from "@/lib/terminals/pending-create-identity";
import { makeListedEpicTerminalRef } from "@/lib/terminals/listed-epic-terminal-ref";
import type {
  ListedTerminalSidebarSession,
  TerminalSidebarSessionRow,
} from "@/lib/terminals/reconcile-terminal-sidebar-sessions";

const TERMINALS_PANEL_SKELETON = <TerminalsPanelSkeleton />;

/** Every test id this panel's shared states and rows are grabbed by. */
const TERMINALS_TEST_ID_PREFIX = "epic-terminal-sidebar";

/**
 * Body for the "terminals" left-panel rail entry. Lists raw host
 * terminals only; the chats panel keeps agent terminals (terminal-agent
 * artifacts) alongside chat rows.
 */
export function TerminalsPanelBody(props: LeftPanelSlotProps) {
  // Live body is split out so `useTerminalList` (a host RPC) is only
  // mounted post-snapshot, not while the epic store is still hydrating.
  return (
    <SnapshotGate skeleton={TERMINALS_PANEL_SKELETON}>
      <TerminalsPanelBodyLive epicId={props.epicId} tabId={props.tabId} />
    </SnapshotGate>
  );
}

function TerminalsPanelBodyLive(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const { epicId, tabId } = props;
  const panel = useEpicTerminalsPanel({ epicId });
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const prepareSetActiveTileTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareSetActiveTileTabFocusTarget,
  );

  const prepareOpenRow = panel.prepareOpenRow;
  const openExisting = useCallback(
    (row: TerminalSidebarSessionRow) => {
      const tile = prepareOpenRow(row);
      if (tile === null) return;
      const found = findOpenTileInTab(tabId, tile);
      if (found !== null) {
        navigateNested(epicId, tabId, () =>
          prepareSetActiveTileTabFocusTarget(
            tabId,
            found.paneId,
            found.instanceId,
          ),
        );
        return;
      }
      navigateNested(epicId, tabId, () =>
        prepareOpenTileInTabFocusTarget(tabId, tile),
      );
    },
    [
      epicId,
      navigateNested,
      prepareOpenRow,
      prepareOpenTileInTabFocusTarget,
      prepareSetActiveTileTabFocusTarget,
      tabId,
    ],
  );

  return (
    <SidebarContent className="min-h-0">
      <SidebarGroup className="min-h-0 flex-1 px-2 py-1">
        <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
          <TerminalSidebarBody
            panel={panel}
            epicId={epicId}
            tabId={tabId}
            onOpen={openExisting}
          />
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}

/**
 * Header "+" action for the "terminals" left panel - opens the host +
 * folder picker; selecting a folder opens a fresh raw terminal tab in
 * that directory. Subscribes only to the open-action (no terminal-list
 * subscription) so a collapsed Terminals section doesn't re-render on
 * every host list update.
 */
export function TerminalsPanelActions(props: LeftPanelSlotProps) {
  const collapsed = useLeftPanelSectionCollapsed("terminals");
  const setPanelSectionCollapsed = useEpicLeftPanelStore(
    (state) => state.setPanelSectionCollapsed,
  );
  const expandBeforeOpen = useCallback(() => {
    if (collapsed) setPanelSectionCollapsed("terminals", false);
  }, [collapsed, setPanelSectionCollapsed]);
  return (
    <NewTerminalPicker
      epicId={props.epicId}
      tabId={props.tabId}
      onLaunched={null}
      onBeforeOpen={expandBeforeOpen}
    />
  );
}

interface TerminalSidebarBodyProps {
  readonly panel: EpicTerminalsPanel;
  readonly epicId: string;
  readonly tabId: string;
  readonly onOpen: (row: TerminalSidebarSessionRow) => void;
}

function TerminalSidebarBody(props: TerminalSidebarBodyProps) {
  const { panel } = props;
  if (panel.isLoading) {
    return <TerminalsLoadingState testIdPrefix={TERMINALS_TEST_ID_PREFIX} />;
  }
  if (panel.isError) {
    return (
      <TerminalsErrorState
        message={panel.errorMessage}
        isRetrying={panel.isRetrying}
        onRetry={panel.retry}
        testIdPrefix={TERMINALS_TEST_ID_PREFIX}
      />
    );
  }
  if (panel.rows.length === 0 && panel.failedCreates.length === 0) {
    return <TerminalsEmptyState testIdPrefix={TERMINALS_TEST_ID_PREFIX} />;
  }
  return (
    <ul
      aria-label="Epic terminals"
      className="space-y-0.5"
      data-testid="epic-terminal-sidebar-list"
    >
      {panel.rows.map((row) => (
        <TerminalRow
          key={epicTerminalUiIdentityKey(
            "session",
            row.hostId,
            row.session.sessionId,
          )}
          epicId={props.epicId}
          tabId={props.tabId}
          hostId={row.hostId}
          session={row.session}
          runtimeStatus={row.runtimeStatus}
          durable={row.durable}
          onOpen={() => props.onOpen(row)}
          authority={panel}
        />
      ))}
      {panel.failedCreates.map((job) => (
        <li
          key={epicTerminalUiIdentityKey(
            "failed",
            job.request.hostId,
            job.request.terminalId,
          )}
        >
          <FailedTerminalCreateRow
            job={job}
            testIdPrefix={TERMINALS_TEST_ID_PREFIX}
          />
        </li>
      ))}
    </ul>
  );
}

interface TerminalRowProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string;
  readonly session: ListedTerminalSidebarSession;
  readonly runtimeStatus: "running" | "dormant" | "unknown";
  readonly durable: boolean;
  readonly onOpen: () => void;
  readonly authority: EpicTerminalRowAuthority;
}

function TerminalRow(props: TerminalRowProps) {
  const {
    authority,
    durable,
    epicId,
    hostId,
    onOpen,
    runtimeStatus,
    session,
    tabId,
  } = props;
  // Per-row boolean subscription so selecting a session re-renders only the two
  // rows whose active state flips, not every row.
  const isActive = useIsActiveTile(tabId, session.sessionId, hostId);
  const actions = useEpicTerminalRowActions({
    epicId,
    tabId,
    hostId,
    session,
    durable,
    authority,
  });
  const showNavigatorResourceStats = useSettingsStore(
    (state) => state.showNavigatorResourceStats,
  );
  const label = actions.label;
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tile = useMemo(
    () =>
      makeListedEpicTerminalRef({
        session,
        hostId,
        instanceId: uuidv4(),
        durable,
      }),
    [durable, hostId, session],
  );
  const dragData = useMemo<EpicCanvasTerminalTileDragData>(
    () => ({
      kind: TERMINAL_TILE_DND_TYPE,
      epicId,
      viewTabId: tabId,
      tile,
    }),
    [epicId, tabId, tile],
  );
  const dragDisabled = useDragSourceDisabled();
  const {
    attributes,
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getPaneScopedDndId(
      tabId,
      getTerminalTileDragId(session.sessionId, hostId),
    ),
    data: dragData,
    disabled: isRenaming || dragDisabled,
  });

  useEffect(() => {
    if (!isRenaming) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [isRenaming]);

  const startRename = () => {
    if (!actions.canRename) return;
    setRenameValue(label);
    setIsRenaming(true);
  };

  const commitRename = () => {
    // Settle the editor on COMMIT, not on the ack - the same contract as the
    // two epic sidebar trees and `useInlineRename`. The optimistic cache patch
    // is the feedback. Waiting to be called back held this editor open for the
    // whole round trip, and open FOREVER on a failure or a refusal, neither of
    // which called anything back.
    //
    // But a REFUSAL still has to hold the editor open, or the typed title is
    // gone with nothing sent: rename can go unavailable while this editor is
    // up (the host stops being mutable, or another row's rename is in flight -
    // that pending flag is panel-wide). This reads a synchronous return, not a
    // `mutate`-scoped callback, so it keeps the settle on the gesture.
    // `onBlur` routes here too, and holding the editor through a blur is the
    // point: the text survives until the rename can actually be sent, and
    // Escape still discards it.
    if (actions.submitRename(renameValue)) setIsRenaming(false);
  };

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setIsRenaming(false);
    }
  };

  const handleDoubleClick = () => {
    if (isRenaming || !actions.canRename) return;
    startRename();
  };
  const rowMenuEntries = terminalRowMenuEntries({
    closeDisabled: actions.closeDisabled,
    onStartRename: startRename,
    renameDisabled: !actions.canRename,
    onRequestClose: actions.requestClose,
    testIds: {
      rename: {
        dropdown: `epic-terminal-sidebar-rename-${session.sessionId}`,
        context: `epic-terminal-sidebar-context-rename-${session.sessionId}`,
      },
      close: {
        dropdown: `epic-terminal-sidebar-kill-menu-${session.sessionId}`,
        context: `epic-terminal-sidebar-context-kill-${session.sessionId}`,
      },
    },
  });

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={isRenaming}>
          <div className="group/term-row relative">
            {isRenaming ? (
              <div
                className={cn(
                  "flex h-7 w-full items-center gap-1.5 rounded-md pl-2 pr-2 text-ui-sm",
                  "bg-accent text-accent-foreground",
                )}
              >
                <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                <Input
                  ref={renameInputRef}
                  data-testid={`epic-terminal-sidebar-rename-input-${session.sessionId}`}
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={handleRenameKeyDown}
                  className="h-7 flex-1 min-w-0 px-1 text-ui-sm"
                />
              </div>
            ) : (
              <>
                <button
                  ref={dragRef}
                  {...attributes}
                  {...listeners}
                  type="button"
                  data-testid={`epic-terminal-sidebar-item-${session.sessionId}`}
                  data-terminal-host-id={hostId}
                  data-terminal-status={runtimeStatus}
                  className={cn(
                    "flex h-7 w-full items-center gap-1.5 rounded-md pl-2 pr-8 text-left text-ui-sm transition-colors",
                    "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
                    isDragging && "cursor-grabbing opacity-60",
                    isActive
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
                  )}
                  onClick={() => onOpen()}
                  onDoubleClick={handleDoubleClick}
                >
                  <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{label}</span>
                    {runtimeStatus === "unknown" ? (
                      <span className="truncate text-ui-xs text-muted-foreground">
                        Runtime status unavailable
                      </span>
                    ) : null}
                  </div>
                  {showNavigatorResourceStats ? (
                    <OwnerResourceChip
                      epicId={epicId}
                      kind="terminal"
                      ownerId={session.sessionId}
                      hostId={hostId}
                      className={undefined}
                    />
                  ) : null}
                </button>
                <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/term-row:opacity-100">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Terminal actions for ${label}`}
                        data-testid={`epic-terminal-sidebar-more-${session.sessionId}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <MoreHorizontal className="size-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <SidebarDropdownMenuItems entries={rowMenuEntries} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </>
            )}
          </div>
        </ContextMenuTrigger>
        {isRenaming ? null : (
          <ContextMenuContent>
            <SidebarContextMenuItems entries={rowMenuEntries} />
          </ContextMenuContent>
        )}
      </ContextMenu>
    </li>
  );
}
