/**
 * Host-driven raw-terminal list rendered as a left-panel rail entry.
 * The list source of truth is `terminal.list@1.0` filtered by `epicId`
 * on the host side (terminals do not live in the Y.Doc). Click a row
 * to open or focus that session as a canvas tab; the "+" action opens a
 * fresh terminal whose tile creates the underlying PTY on mount.
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
import {
  MoreHorizontal,
  Pencil,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
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
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { SnapshotGate } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import { TerminalsPanelSkeleton } from "@/components/epic-canvas/skeletons/terminals-panel-skeleton";
import {
  getTerminalTileDragId,
  TERMINAL_TILE_DND_TYPE,
  type EpicCanvasTerminalTileDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useTerminalKill } from "@/hooks/terminal/use-terminal-kill-mutation";
import { useTerminalList } from "@/hooks/terminal/use-terminal-list-query";
import { useTerminalRename } from "@/hooks/terminal/use-terminal-rename-mutation";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useHostClient } from "@/lib/host";
import { isVisibleEpicTerminalSession } from "@/lib/terminals/terminal-session-filters";
import {
  deriveTitleSourceFromSessionTitle,
  terminalSessionTitle,
} from "@/lib/terminals/terminal-title";
import { OwnerResourceChip } from "@/components/resources/resource-usage-chip";
import { cn } from "@/lib/utils";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
  useIsActiveEpicArtifact,
} from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import {
  SidebarContextMenuItems,
  SidebarDropdownMenuItems,
  type SidebarRowMenuEntry,
} from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";

const TERMINALS_PANEL_SKELETON = <TerminalsPanelSkeleton />;

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
  const hostClient = useHostClient();
  const list = useTerminalList({ kind: "epic", epicId }, hostClient);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const prepareSetActiveTileTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareSetActiveTileTabFocusTarget,
  );
  const activeHostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;

  const openExisting = useCallback(
    (session: CanonicalTerminalSessionInfo) => {
      const found = findOpenArtifactInTab(tabId, session.sessionId);
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
        prepareOpenTileInTabFocusTarget(
          tabId,
          makeTerminalRef(session, activeHostId, uuidv4()),
        ),
      );
    },
    [
      activeHostId,
      epicId,
      navigateNested,
      prepareOpenTileInTabFocusTarget,
      prepareSetActiveTileTabFocusTarget,
      tabId,
    ],
  );

  // Host keeps exited sessions for a 60s grace window; filter so a
  // single kill click feels like "remove" instead of "mark dead".
  const sessions = (list.data?.sessions ?? []).filter((session) =>
    isVisibleEpicTerminalSession(session, epicId),
  );

  return (
    <SidebarContent className="min-h-0">
      <SidebarGroup className="min-h-0 flex-1 px-2 py-1">
        <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
          <TerminalSidebarBody
            isLoading={list.isPending}
            isError={list.isError}
            errorMessage={list.error?.message ?? null}
            sessions={sessions}
            epicId={epicId}
            tabId={tabId}
            hostId={activeHostId}
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
  return <NewTerminalPicker epicId={props.epicId} tabId={props.tabId} />;
}

interface TerminalSidebarBodyProps {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly errorMessage: string | null;
  readonly sessions: ReadonlyArray<CanonicalTerminalSessionInfo>;
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string;
  readonly onOpen: (session: CanonicalTerminalSessionInfo) => void;
}

function TerminalSidebarBody(props: TerminalSidebarBodyProps) {
  if (props.isLoading) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className="shrink-0 text-muted-foreground/70"
          testId={undefined}
          variant={undefined}
        />
        <span>Loading terminals…</span>
      </div>
    );
  }
  if (props.isError) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1.5 text-ui-sm text-destructive"
        data-testid="epic-terminal-sidebar-error"
      >
        <span className="min-w-0 flex-1">
          {props.errorMessage ?? "Failed to load terminals."}
        </span>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Failed to load terminals",
            message: "The terminal list could not be loaded.",
            code: null,
            source: "Terminals",
          })}
          presentation="icon"
          className="text-current"
        />
      </div>
    );
  }
  if (props.sessions.length === 0) {
    return (
      <SidebarPanelEmptyState
        icon={TerminalIcon}
        title="No terminals yet."
        description={null}
        testId="epic-terminal-sidebar-empty"
      />
    );
  }
  return (
    <ul
      aria-label="Epic terminals"
      className="space-y-0.5"
      data-testid="epic-terminal-sidebar-list"
    >
      {props.sessions.map((session) => (
        <TerminalRow
          key={session.sessionId}
          epicId={props.epicId}
          tabId={props.tabId}
          hostId={props.hostId}
          session={session}
          onOpen={props.onOpen}
        />
      ))}
    </ul>
  );
}

interface TerminalRowProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string;
  readonly session: CanonicalTerminalSessionInfo;
  readonly onOpen: (session: CanonicalTerminalSessionInfo) => void;
}

function TerminalRow(props: TerminalRowProps) {
  const { hostId, epicId, tabId, session, onOpen } = props;
  // Per-row boolean subscription so selecting a session re-renders only the two
  // rows whose active state flips, not every row.
  const isActive = useIsActiveEpicArtifact(tabId, session.sessionId);
  const kill = useTerminalKill();
  const rename = useTerminalRename();
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );
  const showNavigatorResourceStats = useSettingsStore(
    (state) => state.showNavigatorResourceStats,
  );

  const label = deriveTerminalLabel(session);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tile = useMemo(
    () => makeTerminalRef(session, hostId, uuidv4()),
    [hostId, session],
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
  const {
    attributes,
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getTerminalTileDragId(session.sessionId),
    data: dragData,
    disabled: isRenaming,
  });

  useEffect(() => {
    if (!isRenaming) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [isRenaming]);

  const startRename = useCallback(() => {
    setRenameValue(label);
    setIsRenaming(true);
  }, [label]);

  const commitRename = useCallback(() => {
    if (rename.isPending) return;
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed === label) {
      setIsRenaming(false);
      return;
    }
    // The mutation optimistically patches the cached `terminal.list` rows,
    // so this row AND any open canvas tab for the session update before the
    // host round-trip (with rollback on error).
    rename.mutate(
      { sessionId: session.sessionId, title: trimmed },
      {
        onSuccess: () => setIsRenaming(false),
      },
    );
  }, [label, rename, renameValue, session.sessionId]);

  const handleRenameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (rename.isPending) return;
      if (event.key === "Enter") {
        event.preventDefault();
        commitRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        setIsRenaming(false);
      }
    },
    [commitRename, rename.isPending],
  );

  // "Close" terminates the PTY AND closes its open canvas tab. Killing alone
  // only drops the host session (and its sidebar row); the open tile would
  // otherwise linger until the exit frame round-trips - and not at all if the
  // tile is currently unmounted. Closing the tab here makes the action
  // immediate and mount-independent. `findOpenArtifactInTab` returns null when
  // no tab is open for this session, so a sidebar-only session just gets killed.
  const requestClose = useCallback(() => {
    if (kill.isPending) return;
    const found = findOpenArtifactInTab(tabId, session.sessionId);
    if (found !== null) {
      navigateNested(epicId, tabId, () =>
        prepareCloseCanvasTabFocusTarget(tabId, found.paneId, found.instanceId),
      );
    }
    kill.mutate({ sessionId: session.sessionId });
  }, [
    epicId,
    kill,
    navigateNested,
    prepareCloseCanvasTabFocusTarget,
    session.sessionId,
    tabId,
  ]);

  const handleDoubleClick = useCallback(() => {
    if (isRenaming) return;
    startRename();
  }, [isRenaming, startRename]);
  const rowMenuEntries = terminalRowMenuEntries({
    sessionId: session.sessionId,
    closePending: kill.isPending,
    onStartRename: startRename,
    onRequestClose: requestClose,
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
                  disabled={rename.isPending}
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
                  data-terminal-status={session.status}
                  className={cn(
                    "flex h-7 w-full items-center gap-1.5 rounded-md pl-2 pr-8 text-left text-ui-sm transition-colors",
                    "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
                    isDragging && "cursor-grabbing opacity-60",
                    isActive
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
                  )}
                  onClick={() => onOpen(session)}
                  onDoubleClick={handleDoubleClick}
                >
                  <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{label}</span>
                  </div>
                  {showNavigatorResourceStats ? (
                    <OwnerResourceChip
                      epicId={epicId}
                      kind="terminal"
                      ownerId={session.sessionId}
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

interface TerminalRowMenuEntriesProps {
  readonly sessionId: string;
  readonly closePending: boolean;
  readonly onStartRename: () => void;
  readonly onRequestClose: () => void;
}

function terminalRowMenuEntries(
  props: TerminalRowMenuEntriesProps,
): ReadonlyArray<SidebarRowMenuEntry> {
  return [
    {
      kind: "item",
      id: "rename",
      label: "Rename",
      icon: <Pencil className="size-3.5" />,
      disabled: false,
      variant: "default",
      testIds: {
        dropdown: `epic-terminal-sidebar-rename-${props.sessionId}`,
        context: `epic-terminal-sidebar-context-rename-${props.sessionId}`,
      },
      onSelect: props.onStartRename,
    },
    { kind: "separator", id: "before-close" },
    {
      kind: "item",
      id: "close",
      label: "Close",
      icon: <Trash2 className="size-3.5" />,
      disabled: props.closePending,
      variant: "destructive",
      testIds: {
        dropdown: `epic-terminal-sidebar-kill-menu-${props.sessionId}`,
        context: `epic-terminal-sidebar-context-kill-${props.sessionId}`,
      },
      onSelect: props.onRequestClose,
    },
  ];
}

function deriveTerminalLabel(session: CanonicalTerminalSessionInfo): string {
  return terminalSessionTitle({
    title: session.title,
    activeProcessName: session.activeProcessName,
  });
}

function makeTerminalRef(
  session: CanonicalTerminalSessionInfo,
  hostId: string,
  instanceId: string,
): EpicTerminalRef {
  return {
    id: session.sessionId,
    instanceId,
    type: "terminal",
    name: deriveTerminalLabel(session),
    titleSource: deriveTitleSourceFromSessionTitle(session.title),
    hostId,
    cwd: session.cwd,
  };
}
