/**
 * Host-driven raw-terminal list rendered as a left-panel rail entry. Durable
 * rows come from the authoritative `terminal.plain.list` collection stream;
 * `terminal.list` supplies compatibility rows such as setup/provider-login
 * shells (terminals do not live in the Y.Doc). Click a row to open or focus
 * that session as a canvas tab; the "+" action opens a fresh terminal whose
 * tile creates the underlying PTY on mount.
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
import type { RunningPlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
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
  getPaneScopedDndId,
  TERMINAL_TILE_DND_TYPE,
  type EpicCanvasTerminalTileDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useTerminalKillFor } from "@/hooks/terminal/use-terminal-kill-for-mutation";
import { useTerminalList } from "@/hooks/terminal/use-terminal-list-query";
import { useTerminalRenameFor } from "@/hooks/terminal/use-terminal-rename-for-mutation";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { isVisibleEpicTerminalSession } from "@/lib/terminals/terminal-session-filters";
import {
  deriveTitleSourceFromSessionTitle,
  terminalSessionLabel,
} from "@/lib/terminals/terminal-title";
import { OwnerResourceChip } from "@/components/resources/resource-usage-chip";
import { cn } from "@/lib/utils";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
  useIsActiveTile,
} from "@/stores/epics/canvas/store";
import {
  useEpicLeftPanelStore,
  useLeftPanelSectionCollapsed,
} from "@/stores/epics/left-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import {
  existingSessionOriginFields,
  isUnsupportedEpicTerminalRef,
} from "@/stores/epics/canvas/types";
import { providerLoginTerminalProviderId } from "@/stores/providers/provider-login-terminals";
import { isSetupTerminal } from "@/stores/worktree/setup-terminals";
import {
  SidebarContextMenuItems,
  SidebarDropdownMenuItems,
  type SidebarRowMenuEntry,
} from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";
import { useHostPlainTerminalAuthority } from "@/hooks/terminal/use-plain-terminal-authority";
import { useHostPlainTerminalMutations } from "@/hooks/terminal/use-plain-terminal-mutations";
import {
  registerEpicTerminalCloseAuthority,
  requestEpicTerminalLifetimeClose,
  type EpicTerminalCloseAuthority,
} from "@/lib/terminals/epic-terminal-close-coordinator";
import {
  plainTerminalCollectionValues,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";

const TERMINALS_PANEL_SKELETON = <TerminalsPanelSkeleton />;

function withLegacyTerminalCloseAuthority(
  authority: EpicTerminalCloseAuthority,
  closeLocalRef: () => void,
): void {
  const unregister = registerEpicTerminalCloseAuthority(authority);
  try {
    closeLocalRef();
  } finally {
    unregister();
  }
}

function sessionFromDurableProjection(
  terminal: RunningPlainTerminalProjection,
): CanonicalTerminalSessionInfo {
  return {
    sessionId: terminal.record.terminalId,
    scope: terminal.record.scope,
    sessionKind: "terminal",
    cwd: terminal.record.launch.cwd,
    shellCommand: terminal.record.launch.shellCommand,
    shellArgs: terminal.record.launch.shellArgs,
    cols: terminal.runtime.cols,
    rows: terminal.runtime.rows,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: Date.parse(terminal.record.createdAt),
    title: terminal.record.manualTitle,
    activeProcessName: terminal.runtime.activeProcessName,
  };
}

/**
 * `terminal.list` remains the compatibility source for manager-owned setup and
 * provider-login shells. Durable terminals arrive on the authoritative
 * collection stream, so merge that live projection over any cached unary rows.
 */
function terminalSidebarSessions(args: {
  readonly epicId: string;
  readonly listed: readonly CanonicalTerminalSessionInfo[];
  readonly durableCollection: PlainTerminalCollection | undefined;
}): CanonicalTerminalSessionInfo[] {
  const listed = args.listed.filter((session) =>
    isVisibleEpicTerminalSession(session, args.epicId),
  );
  const durable = plainTerminalCollectionValues(args.durableCollection).filter(
    (terminal): terminal is RunningPlainTerminalProjection =>
      terminal.runtime.status === "running" &&
      terminal.record.scope.kind === "epic" &&
      terminal.record.scope.epicId === args.epicId,
  );
  if (durable.length === 0) return listed;
  const durableIds = new Set(
    durable.map((terminal) => terminal.record.terminalId),
  );
  return [
    ...listed.filter((session) => !durableIds.has(session.sessionId)),
    ...durable.map(sessionFromDurableProjection),
  ];
}

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
  // The Epic SESSION's host, not the app-wide effective one. This panel is a
  // sibling of the canvas and therefore outside every tile `TabHostProvider`,
  // which is exactly the case `useEpicSessionHostId` was written for: "host
  // RPCs issued by the sidebar must use the session transport's host instead
  // of ... independently re-reading the app-wide active host". `terminal.list`
  // is such an RPC, and the pair below has to come from ONE source - the list
  // names the machine whose terminals it shows, and the id it hands to
  // `makeTerminalRef` binds each opened tile to that machine for life.
  //
  // Reading ambient made both wrong together the moment they disagreed:
  // activation or failover moves the effective host while `EpicSessionProvider`
  // is still rendering its previous session (and for the whole of a
  // re-point that is establishing, or one that failed), so an Epic projected
  // from host A listed, killed and renamed host B's terminals, and opened them
  // as B-bound tiles under A's Epic.
  const hostClient = useEpicSessionHostClient();
  const list = useTerminalList({ kind: "epic", epicId }, hostClient);
  // Manual escape hatch for a stranded error state: host-scoped queries get
  // no automatic retry/refetch routes (transport already retried), so without
  // this the only recoveries are accidental (collapse/re-expand remounts the
  // body) or the stream-driven `availability-recovered` invalidation.
  const refetchList = list.refetch;
  const retryList = useCallback(() => {
    void refetchList();
  }, [refetchList]);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const prepareSetActiveTileTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareSetActiveTileTabFocusTarget,
  );
  const activeHostId = useEpicSessionHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const durableAuthority = useHostPlainTerminalAuthority({
    hostId: activeHostId,
    scope: { kind: "epic", epicId },
  });
  const durableMutations = useHostPlainTerminalMutations(durableAuthority);
  const requestDurableClose = (terminalId: string) => {
    const pending = requestEpicTerminalLifetimeClose({
      hostId: activeHostId,
      terminalId,
      capability: durableAuthority.capability.status,
      canMutate: durableAuthority.canMutate,
      close: async () => {
        await durableMutations.close.mutateAsync({ terminalId });
      },
    });
    if (pending === null) return;
    void pending.catch(() => undefined);
  };
  const requestDurableRename = (
    terminalId: string,
    manualTitle: string,
    onSuccess: () => void,
  ) => {
    if (!durableAuthority.canMutate || durableMutations.rename.isPending) {
      return;
    }
    durableMutations.rename.mutate({ terminalId, manualTitle }, { onSuccess });
  };

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
  const sessions = useMemo(
    () =>
      terminalSidebarSessions({
        epicId,
        listed: list.data?.sessions ?? [],
        durableCollection: durableAuthority.collection,
      }),
    [durableAuthority.collection, epicId, list.data?.sessions],
  );

  return (
    <SidebarContent className="min-h-0">
      <SidebarGroup className="min-h-0 flex-1 px-2 py-1">
        <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
          <TerminalSidebarBody
            isLoading={list.isPending ? sessions.length === 0 : false}
            isError={list.isError}
            errorMessage={list.error?.message ?? null}
            isRetrying={list.isFetching}
            onRetry={retryList}
            sessions={sessions}
            epicId={epicId}
            tabId={tabId}
            hostId={activeHostId}
            onOpen={openExisting}
            closeCapability={durableAuthority.capability.status}
            closeCanMutate={durableAuthority.canMutate}
            closePending={durableMutations.close.isPending}
            onDurableClose={requestDurableClose}
            durableRenameTerminalIds={Object.keys(
              durableAuthority.collection?.terminalsById ?? {},
            )}
            durableRenamePending={durableMutations.rename.isPending}
            onDurableRename={requestDurableRename}
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
      onBeforeOpen={expandBeforeOpen}
    />
  );
}

interface TerminalSidebarBodyProps {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly errorMessage: string | null;
  readonly isRetrying: boolean;
  readonly onRetry: () => void;
  readonly sessions: ReadonlyArray<CanonicalTerminalSessionInfo>;
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string;
  readonly onOpen: (session: CanonicalTerminalSessionInfo) => void;
  readonly closeCapability: "unknown" | "legacy" | "capable";
  readonly closeCanMutate: boolean;
  readonly closePending: boolean;
  readonly onDurableClose: (terminalId: string) => void;
  readonly durableRenameTerminalIds: readonly string[];
  readonly durableRenamePending: boolean;
  readonly onDurableRename: (
    terminalId: string,
    manualTitle: string,
    onSuccess: () => void,
  ) => void;
}

type TerminalSidebarRenameMode = "disabled" | "legacy" | "capable";

function resolveTerminalSidebarRenameMode(args: {
  readonly capability: "unknown" | "legacy" | "capable";
  readonly canMutate: boolean;
  readonly hasProjection: boolean;
}): TerminalSidebarRenameMode {
  if (args.capability === "legacy") return "legacy";
  if (args.capability !== "capable") return "disabled";
  if (!args.canMutate) return "disabled";
  // A row with no durable projection is a `terminal.list` compatibility row
  // (setup / provider-login shell). The host still serves `terminal.rename`
  // for it, so keep the legacy path instead of disabling rename.
  if (!args.hasProjection) return "legacy";
  return "capable";
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
        className="flex flex-col gap-2 px-2 py-1.5 text-ui-sm text-destructive"
        data-testid="epic-terminal-sidebar-error"
      >
        <span className="min-w-0">
          {props.errorMessage ?? "Failed to load terminals."}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.isRetrying}
            data-testid="epic-terminal-sidebar-retry"
            onClick={props.onRetry}
          >
            {props.isRetrying ? (
              <AgentSpinningDots
                className="shrink-0"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Retry
          </Button>
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
  const durableRenameTerminalIds = new Set(props.durableRenameTerminalIds);
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
          closeCapability={props.closeCapability}
          closeCanMutate={props.closeCanMutate}
          closePending={props.closePending}
          onDurableClose={props.onDurableClose}
          renameMode={resolveTerminalSidebarRenameMode({
            capability: props.closeCapability,
            canMutate: props.closeCanMutate,
            hasProjection: durableRenameTerminalIds.has(session.sessionId),
          })}
          durableRenamePending={props.durableRenamePending}
          onDurableRename={props.onDurableRename}
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
  readonly closeCapability: "unknown" | "legacy" | "capable";
  readonly closeCanMutate: boolean;
  readonly closePending: boolean;
  readonly onDurableClose: (terminalId: string) => void;
  readonly renameMode: TerminalSidebarRenameMode;
  readonly durableRenamePending: boolean;
  readonly onDurableRename: (
    terminalId: string,
    manualTitle: string,
    onSuccess: () => void,
  ) => void;
}

function TerminalRow(props: TerminalRowProps) {
  const {
    closeCapability,
    closeCanMutate,
    closePending,
    durableRenamePending,
    epicId,
    hostId,
    onDurableClose,
    onDurableRename,
    onOpen,
    session,
    tabId,
  } = props;
  // Per-row boolean subscription so selecting a session re-renders only the two
  // rows whose active state flips, not every row.
  const isActive = useIsActiveTile(tabId, session.sessionId);
  // The row's terminal lives on the host this sidebar LISTS (the Epic
  // session's - see the list above), so kill and rename go to that same
  // client. The app-wide wrappers were the last two reads that stayed on
  // the ambient host after the list moved: during a re-point they killed and
  // renamed host B's sessions from host A's rows.
  const rowHostClient = useEpicSessionHostClient();
  const kill = useTerminalKillFor(
    rowHostClient,
    "Couldn't close the terminal.",
    true,
  );
  const legacyRename = useTerminalRenameFor(rowHostClient);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );
  const showNavigatorResourceStats = useSettingsStore(
    (state) => state.showNavigatorResourceStats,
  );
  const hasUnsupportedFutureRef = useEpicCanvasStore((state) =>
    Object.values(state.canvasByTabId).some((canvas) =>
      Object.values(canvas?.tilesByInstanceId ?? {}).some(
        (ref) =>
          ref?.type === "terminal" &&
          ref.hostId === hostId &&
          ref.id === session.sessionId &&
          isUnsupportedEpicTerminalRef(ref),
      ),
    ),
  );
  const renameMode = hasUnsupportedFutureRef ? "disabled" : props.renameMode;
  let renamePending = false;
  if (renameMode === "capable") renamePending = durableRenamePending;
  if (renameMode === "legacy") renamePending = legacyRename.isPending;
  const canRename = renameMode !== "disabled" && !renamePending;

  const label = terminalSessionLabel(session);
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
    id: getPaneScopedDndId(tabId, getTerminalTileDragId(session.sessionId)),
    data: dragData,
    disabled: isRenaming,
  });

  useEffect(() => {
    if (!isRenaming) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [isRenaming]);

  const startRename = () => {
    if (!canRename) return;
    setRenameValue(label);
    setIsRenaming(true);
  };

  const commitRename = () => {
    if (!canRename) return;
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed === label) {
      setIsRenaming(false);
      return;
    }
    // The mutation optimistically patches the cached `terminal.list` rows,
    // so this row AND any open canvas tab for the session update before the
    // host round-trip (with rollback on error).
    const finish = (): void => setIsRenaming(false);
    if (renameMode === "capable") {
      onDurableRename(session.sessionId, trimmed, finish);
      return;
    }
    legacyRename.mutate(
      { sessionId: session.sessionId, title: trimmed },
      { onSuccess: finish },
    );
  };

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (renamePending) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setIsRenaming(false);
    }
  };

  // "Close" terminates the PTY AND closes its open canvas tab. Killing alone
  // only drops the host session (and its sidebar row); the open tile would
  // otherwise linger until the exit frame round-trips - and not at all if the
  // tile is currently unmounted. Closing the tab here makes the action
  // immediate and mount-independent. `findOpenArtifactInTab` returns null when
  // no tab is open for this session, so a sidebar-only session just gets killed.
  const requestClose = () => {
    if (hasUnsupportedFutureRef) return;
    if (closeCapability === "capable") {
      if (!closeCanMutate || closePending) return;
      onDurableClose(session.sessionId);
      return;
    }
    if (closeCapability === "unknown" || kill.isPending) return;
    const found = findOpenArtifactInTab(tabId, session.sessionId);
    if (found !== null) {
      // This branch is reachable only after the manifest positively identifies
      // an old host. Register that evidence for the synchronous store boundary
      // so it preserves the legacy local-close behavior without weakening the
      // coordinator's fail-closed default for unregistered refs.
      withLegacyTerminalCloseAuthority(
        {
          instanceId: found.instanceId,
          hostId,
          terminalId: session.sessionId,
          capability: "legacy",
          canMutate: false,
          close: () => Promise.resolve(),
        },
        () => {
          navigateNested(epicId, tabId, () =>
            prepareCloseCanvasTabFocusTarget(
              tabId,
              found.paneId,
              found.instanceId,
            ),
          );
        },
      );
    }
    kill.mutate({ sessionId: session.sessionId });
  };

  const handleDoubleClick = () => {
    if (isRenaming || !canRename) return;
    startRename();
  };
  const rowMenuEntries = terminalRowMenuEntries({
    sessionId: session.sessionId,
    // Not a pending flag: it also encodes "not permitted" (unsupported future
    // ref, unknown capability, no mutation authority).
    closeDisabled:
      hasUnsupportedFutureRef ||
      closeCapability === "unknown" ||
      (closeCapability === "capable"
        ? !closeCanMutate || closePending
        : kill.isPending),
    onStartRename: startRename,
    renameDisabled: !canRename,
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
                  disabled={renamePending}
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
  readonly closeDisabled: boolean;
  readonly onStartRename: () => void;
  readonly renameDisabled: boolean;
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
      disabled: props.renameDisabled,
      disabledTooltip: null,
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
      disabled: props.closeDisabled,
      disabledTooltip: null,
      variant: "destructive",
      testIds: {
        dropdown: `epic-terminal-sidebar-kill-menu-${props.sessionId}`,
        context: `epic-terminal-sidebar-context-kill-${props.sessionId}`,
      },
      onSelect: props.onRequestClose,
    },
  ];
}

function makeTerminalRef(
  session: CanonicalTerminalSessionInfo,
  hostId: string,
  instanceId: string,
): EpicTerminalRef {
  // `terminal.list` cannot say who created a session, so a sign-in terminal
  // reopened from here would otherwise become an ordinary tile that believes it
  // owns the PTY - and re-creates the id as a bare shell once the host loses
  // it. The renderer's own record of host-created sign-in terminals supplies
  // what the wire does not.
  const signInProviderId = providerLoginTerminalProviderId(
    hostId,
    session.sessionId,
  );
  const setupSession = isSetupTerminal(hostId, session.sessionId);
  return {
    id: session.sessionId,
    instanceId,
    type: "terminal",
    name: terminalSessionLabel(session),
    titleSource: deriveTitleSourceFromSessionTitle(session.title),
    hostId,
    cwd: session.cwd,
    ...existingSessionOriginFields(signInProviderId, setupSession),
  };
}
