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
import { toast } from "sonner";
import { useDraggable } from "@dnd-kit/core";
import {
  MoreHorizontal,
  Pencil,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
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
import {
  DEFAULT_TERMINAL_TITLE,
  terminalSessionLabel,
} from "@/lib/terminals/terminal-title";
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
import { isUnsupportedEpicTerminalRef } from "@/stores/epics/canvas/types";
import {
  SidebarContextMenuItems,
  SidebarDropdownMenuItems,
  type SidebarRowMenuEntry,
} from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";
import { useHostPlainTerminalAuthority } from "@/hooks/terminal/use-plain-terminal-authority";
import { useDelayedTerminalFleetWarning } from "@/hooks/terminal/use-delayed-terminal-fleet-warning";
import { useHostPlainTerminalMutations } from "@/hooks/terminal/use-plain-terminal-mutations";
import { requestEpicTerminalLifetimeClose } from "@/lib/terminals/epic-terminal-close-coordinator";
import {
  discardEpicTerminalDurableCreate,
  retryEpicTerminalDurableCreate,
  settleEpicTerminalDurableCreate,
  type EpicTerminalDurableCreateJobView,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { useEpicTerminalDurableCreateJobViews } from "@/hooks/terminal/use-epic-terminal-durable-create";
import {
  epicTerminalUiIdentityKey,
  failedCreateHasAuthoritativeRow,
} from "@/lib/terminals/pending-create-identity";
import {
  getPlainTerminal,
  plainTerminalCapabilityTopology,
  plainTerminalCollectionIdentityKey,
  plainTerminalCollectionValues,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import { makeListedEpicTerminalRef } from "@/lib/terminals/listed-epic-terminal-ref";
import {
  reconcileTerminalSidebarSessions,
  type ListedTerminalSidebarSession,
  type TerminalSidebarSessionRow,
} from "@/lib/terminals/reconcile-terminal-sidebar-sessions";
import { useResolvePlainTerminalOwnerHostClient } from "@/lib/terminals/resolve-plain-terminal-owner-client";

const TERMINALS_PANEL_SKELETON = <TerminalsPanelSkeleton />;

function failedCreateMatchesAuthoritativeRow(args: {
  readonly job: EpicTerminalDurableCreateJobView;
  readonly hostId: string;
  readonly durableCollection: PlainTerminalCollection | undefined;
}): boolean {
  return failedCreateHasAuthoritativeRow({
    jobHostId: args.job.request.hostId,
    jobTerminalId: args.job.request.terminalId,
    sessionHostId: args.hostId,
    durableHasTerminalId: (terminalId) =>
      getPlainTerminal(
        args.durableCollection,
        args.job.request.hostId,
        terminalId,
      ) !== undefined,
  });
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
  const resolveOwnerClient = useResolvePlainTerminalOwnerHostClient();
  const requestDurableClose = (hostId: string, terminalId: string) => {
    const pending = requestEpicTerminalLifetimeClose({
      hostId,
      terminalId,
      capability: durableAuthority.capability.status,
      canMutate: durableAuthority.canMutate,
      close: async () => {
        await durableMutations.close.mutateAsync({ hostId, terminalId });
      },
    });
    if (pending === null) return;
    void pending.catch(() => undefined);
  };
  const requestDurableRename = (
    hostId: string,
    terminalId: string,
    manualTitle: string,
    onSuccess: () => void,
  ) => {
    if (!durableAuthority.canMutate || durableMutations.rename.isPending) {
      return;
    }
    durableMutations.rename.mutate(
      { hostId, terminalId, manualTitle },
      { onSuccess },
    );
  };

  const openExisting = useCallback(
    (row: TerminalSidebarSessionRow) => {
      if (row.durable && resolveOwnerClient(row.hostId) === null) {
        toast(
          `Can't open this terminal right now - host ${row.hostId} is not reachable.`,
        );
        return;
      }
      const tile = makeListedEpicTerminalRef({
        session: row.session,
        hostId: row.hostId,
        instanceId: uuidv4(),
        durable: row.durable,
      });
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
      prepareOpenTileInTabFocusTarget,
      prepareSetActiveTileTabFocusTarget,
      resolveOwnerClient,
      tabId,
    ],
  );

  // Host keeps exited sessions for a 60s grace window; filter so a
  // single kill click feels like "remove" instead of "mark dead".
  const reconciled = useMemo(
    () =>
      reconcileTerminalSidebarSessions({
        epicId,
        servingHostId: activeHostId,
        capability: durableAuthority.capability.status,
        topology:
          plainTerminalCapabilityTopology(durableAuthority.capability) ??
          "fleet",
        coverage: durableAuthority.coverage ?? null,
        listed: list.data?.sessions ?? [],
        durableCollection: durableAuthority.collection,
      }),
    [
      activeHostId,
      durableAuthority.capability,
      durableAuthority.collection,
      durableAuthority.coverage,
      epicId,
      list.data?.sessions,
    ],
  );
  const sessions = reconciled.rows;
  const incompleteFleet = reconciled.incompleteFleet;
  // The sidebar no longer captions partial fleet coverage - the epic status
  // pill owns that signal (one amber light, the sentence on hover). The grace
  // still matters here: until it elapses a catalog that is merely hydrating
  // must not read as "No terminals yet.", so the loading state holds instead.
  const fleetGapSettled = useDelayedTerminalFleetWarning(
    incompleteFleet,
    JSON.stringify([activeHostId, epicId]),
  );
  const createJobs = useEpicTerminalDurableCreateJobViews(epicId);
  const failedCreates = useMemo(
    () =>
      createJobs.filter((job) => {
        if (job.status !== "failed") return false;
        if (job.request.hostId !== activeHostId) return false;
        return !failedCreateMatchesAuthoritativeRow({
          job,
          hostId: activeHostId,
          durableCollection: durableAuthority.collection,
        });
      }),
    [activeHostId, createJobs, durableAuthority.collection],
  );
  const unmarkTerminalPendingCreate = useEpicCanvasStore(
    (state) => state.unmarkTerminalPendingCreate,
  );
  useEffect(() => {
    for (const job of createJobs) {
      if (job.status !== "failed") continue;
      if (
        !failedCreateMatchesAuthoritativeRow({
          job,
          hostId: activeHostId,
          durableCollection: durableAuthority.collection,
        })
      ) {
        continue;
      }
      settleEpicTerminalDurableCreate(
        job.request.hostId,
        job.request.terminalId,
      );
      unmarkTerminalPendingCreate(job.request.hostId, job.request.terminalId);
    }
  }, [
    activeHostId,
    createJobs,
    durableAuthority.collection,
    unmarkTerminalPendingCreate,
  ]);

  return (
    <SidebarContent className="min-h-0">
      <SidebarGroup className="min-h-0 flex-1 px-2 py-1">
        <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
          <TerminalSidebarBody
            isLoading={
              failedCreates.length === 0 &&
              (durableAuthority.capability.status === "unknown" ||
                (incompleteFleet &&
                  !fleetGapSettled &&
                  sessions.length === 0) ||
                (sessions.length === 0 &&
                  (list.isPending ||
                    (durableAuthority.capability.status === "capable" &&
                      durableAuthority.collection === undefined))))
            }
            isError={Boolean(
              durableAuthority.capability.status !== "unknown" &&
              list.isError &&
              sessions.length === 0,
            )}
            errorMessage={list.error?.message ?? null}
            isRetrying={list.isFetching}
            onRetry={retryList}
            sessions={sessions}
            failedCreates={failedCreates}
            epicId={epicId}
            tabId={tabId}
            hostId={activeHostId}
            onOpen={openExisting}
            closeCapability={durableAuthority.capability.status}
            closeCanMutate={durableAuthority.canMutate}
            closePending={durableMutations.close.isPending}
            onDurableClose={requestDurableClose}
            durableRenameIdentityKeys={
              new Set(
                plainTerminalCollectionValues(durableAuthority.collection).map(
                  (terminal) =>
                    plainTerminalCollectionIdentityKey(
                      terminal.record.hostId,
                      terminal.record.terminalId,
                    ),
                ),
              )
            }
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
      onLaunched={null}
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
  readonly sessions: ReadonlyArray<TerminalSidebarSessionRow>;
  readonly failedCreates: ReadonlyArray<EpicTerminalDurableCreateJobView>;
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string;
  readonly onOpen: (row: TerminalSidebarSessionRow) => void;
  readonly closeCapability: "unknown" | "legacy" | "capable";
  readonly closeCanMutate: boolean;
  readonly closePending: boolean;
  readonly onDurableClose: (hostId: string, terminalId: string) => void;
  readonly durableRenameIdentityKeys: ReadonlySet<string>;
  readonly durableRenamePending: boolean;
  readonly onDurableRename: (
    hostId: string,
    terminalId: string,
    manualTitle: string,
    onSuccess: () => void,
  ) => void;
}

type TerminalSidebarRenameMode = "disabled" | "legacy" | "capable";

/**
 * Which lifetime authority owns a row's rename. `capability` and `canMutate`
 * are host-wide, but the sidebar merges durable projection rows with
 * manager-owned compatibility rows from `terminal.list`.
 */
function resolveTerminalSidebarRenameMode(args: {
  readonly capability: "unknown" | "legacy" | "capable";
  readonly canMutate: boolean;
  readonly hasProjection: boolean;
}): TerminalSidebarRenameMode {
  if (args.capability === "legacy") return "legacy";
  if (args.capability !== "capable") return "disabled";
  if (!args.canMutate) return "disabled";
  // A row with no durable projection is a manager-owned compatibility row.
  // The host still serves `terminal.rename` for it.
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
  if (props.sessions.length === 0 && props.failedCreates.length === 0) {
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
      {props.sessions.map((row) => (
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
          closeCapability={props.closeCapability}
          closeCanMutate={props.closeCanMutate}
          closePending={props.closePending}
          onDurableClose={props.onDurableClose}
          renameMode={resolveTerminalSidebarRenameMode({
            capability: props.closeCapability,
            canMutate: props.closeCanMutate,
            hasProjection: props.durableRenameIdentityKeys.has(
              plainTerminalCollectionIdentityKey(
                row.hostId,
                row.session.sessionId,
              ),
            ),
          })}
          durableRenamePending={props.durableRenamePending}
          onDurableRename={props.onDurableRename}
        />
      ))}
      {props.failedCreates.map((job) => (
        <FailedHeadlessTerminalCreateRow
          key={epicTerminalUiIdentityKey(
            "failed",
            job.request.hostId,
            job.request.terminalId,
          )}
          job={job}
        />
      ))}
    </ul>
  );
}

function FailedHeadlessTerminalCreateRow(props: {
  readonly job: EpicTerminalDurableCreateJobView;
}) {
  const { job } = props;
  const unmarkPendingCreate = useEpicCanvasStore(
    (state) => state.unmarkTerminalPendingCreate,
  );
  const title = DEFAULT_TERMINAL_TITLE;
  const message = job.error?.message ?? "Could not create terminal.";
  const identityKey = epicTerminalUiIdentityKey(
    "failed",
    job.request.hostId,
    job.request.terminalId,
  );
  return (
    <li
      className="rounded-md px-2 py-1.5"
      data-testid={`epic-terminal-sidebar-failed-create-${identityKey}`}
    >
      <div className="flex min-w-0 items-start gap-1.5 text-ui-sm">
        <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-destructive/70" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground/80">{title}</div>
          <div className="truncate text-destructive">{message}</div>
          <div className="mt-1 flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`epic-terminal-sidebar-failed-retry-${identityKey}`}
              onClick={() => {
                retryEpicTerminalDurableCreate(
                  job.request.hostId,
                  job.request.terminalId,
                );
              }}
            >
              Retry
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={`epic-terminal-sidebar-failed-discard-${identityKey}`}
              onClick={() => {
                discardEpicTerminalDurableCreate(
                  job.request.hostId,
                  job.request.terminalId,
                );
                unmarkPendingCreate(job.request.hostId, job.request.terminalId);
              }}
            >
              Discard
            </Button>
          </div>
        </div>
      </div>
    </li>
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
  readonly closeCapability: "unknown" | "legacy" | "capable";
  readonly closeCanMutate: boolean;
  readonly closePending: boolean;
  readonly onDurableClose: (hostId: string, terminalId: string) => void;
  readonly renameMode: TerminalSidebarRenameMode;
  readonly durableRenamePending: boolean;
  readonly onDurableRename: (
    hostId: string,
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
    runtimeStatus,
    durable,
    onDurableClose,
    onDurableRename,
    onOpen,
    session,
    tabId,
  } = props;
  // Per-row boolean subscription so selecting a session re-renders only the two
  // rows whose active state flips, not every row.
  const isActive = useIsActiveTile(tabId, session.sessionId, hostId);
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
      onDurableRename(hostId, session.sessionId, trimmed, finish);
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
  // immediate and mount-independent. `findOpenTileInTab` returns null when
  // no tab is open for this session, so a sidebar-only session just gets killed.
  const requestClose = () => {
    if (hasUnsupportedFutureRef) return;
    if (durable) {
      if (closeCapability !== "capable" || !closeCanMutate || closePending) {
        return;
      }
      onDurableClose(hostId, session.sessionId);
      return;
    }
    if (closeCapability === "unknown" || kill.isPending) return;
    const found = findOpenTileInTab(
      tabId,
      makeListedEpicTerminalRef({
        session,
        hostId,
        instanceId: "legacy-close-lookup",
        durable: false,
      }),
    );
    if (found !== null) {
      navigateNested(epicId, tabId, () =>
        prepareCloseCanvasTabFocusTarget(tabId, found.paneId, found.instanceId),
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
      (durable
        ? closeCapability !== "capable" || !closeCanMutate || closePending
        : closeCapability === "unknown" || kill.isPending),
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
