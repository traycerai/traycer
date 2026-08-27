/**
 * The Terminals surface's data + action layer, independent of its chrome.
 *
 * Listing a raw terminal is not a "render the rows" problem: which rows exist
 * is a three-authority reconciliation (durable `terminal.plain.list`
 * projections, manager-owned `terminal.list` compatibility rows, a genuinely
 * legacy host's full list), and renaming or closing one has to be routed to
 * whichever authority owns that particular row. Every surface that lists
 * terminals - the desktop left panel and the phone tab switcher's Terminals
 * category - mounts these hooks, so both list the same sessions and mutate
 * them through the same host authority; only the chrome around them differs.
 */
import { useCallback, useEffect, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { toast } from "sonner";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useTerminalKillFor } from "@/hooks/terminal/use-terminal-kill-for-mutation";
import { useTerminalList } from "@/hooks/terminal/use-terminal-list-query";
import { useTerminalRenameFor } from "@/hooks/terminal/use-terminal-rename-for-mutation";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { terminalSessionLabel } from "@/lib/terminals/terminal-title";
import {
  findOpenTileInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import {
  isUnsupportedEpicTerminalRef,
  type EpicTerminalRef,
} from "@/stores/epics/canvas/types";
import { useHostPlainTerminalAuthority } from "@/hooks/terminal/use-plain-terminal-authority";
import { useDelayedTerminalFleetWarning } from "@/hooks/terminal/use-delayed-terminal-fleet-warning";
import { useHostPlainTerminalMutations } from "@/hooks/terminal/use-plain-terminal-mutations";
import { requestEpicTerminalLifetimeClose } from "@/lib/terminals/epic-terminal-close-coordinator";
import {
  settleEpicTerminalDurableCreate,
  type EpicTerminalDurableCreateJobView,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { useEpicTerminalDurableCreateJobViews } from "@/hooks/terminal/use-epic-terminal-durable-create";
import { failedCreateHasAuthoritativeRow } from "@/lib/terminals/pending-create-identity";
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

export type TerminalCloseCapability = "unknown" | "legacy" | "capable";

export type TerminalSidebarRenameMode = "disabled" | "legacy" | "capable";

/** The lifetime authority a single row's rename and close have to go through. */
export interface EpicTerminalRowAuthority {
  readonly closeCapability: TerminalCloseCapability;
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

export interface EpicTerminalsPanel extends EpicTerminalRowAuthority {
  readonly rows: ReadonlyArray<TerminalSidebarSessionRow>;
  readonly failedCreates: ReadonlyArray<EpicTerminalDurableCreateJobView>;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly errorMessage: string | null;
  readonly isRetrying: boolean;
  readonly retry: () => void;
  /** The Epic session's host - the machine whose terminals these rows are. */
  readonly hostId: string;
  /**
   * The canvas ref for a row, or null when its owner host is unreachable (the
   * user is told why). Callers own what they do with the ref, because
   * "activate" means a different thing on a split canvas than on a phone's
   * single-tile view - the identity of the thing being opened does not.
   */
  readonly prepareOpenRow: (
    row: TerminalSidebarSessionRow,
  ) => EpicTerminalRef | null;
}

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
 * Which lifetime authority owns a row's rename. `capability` and `canMutate`
 * are host-wide, but the list merges durable projection rows with
 * manager-owned compatibility rows from `terminal.list`.
 */
export function resolveTerminalSidebarRenameMode(args: {
  readonly capability: TerminalCloseCapability;
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

export function useEpicTerminalsPanel(args: {
  readonly epicId: string;
}): EpicTerminalsPanel {
  const { epicId } = args;
  // The Epic SESSION's host, not the app-wide effective one. Every surface
  // that mounts this sits OUTSIDE the tiles' `TabHostProvider` - the desktop
  // panel is a sibling of the canvas, the phone switcher a sibling of the
  // shown tile - which is exactly the case `useEpicSessionHostId` was written
  // for: "host RPCs issued by the sidebar must use the session transport's
  // host instead of ... independently re-reading the app-wide active host".
  // `terminal.list` is such an RPC, and the pair below has to come from ONE
  // source - the list names the machine whose terminals it shows, and the id
  // it hands to `makeListedEpicTerminalRef` binds each opened tile to that
  // machine for life.
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
  const retry = useCallback(() => {
    void refetchList();
  }, [refetchList]);
  const activeHostId = useEpicSessionHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const durableAuthority = useHostPlainTerminalAuthority({
    hostId: activeHostId,
    scope: { kind: "epic", epicId },
  });
  const durableMutations = useHostPlainTerminalMutations(durableAuthority);
  const resolveOwnerClient = useResolvePlainTerminalOwnerHostClient();

  const closeCapability = durableAuthority.capability.status;
  const closeCanMutate = durableAuthority.canMutate;
  const closeMutation = durableMutations.close;
  const renameMutation = durableMutations.rename;

  const onDurableClose = useCallback(
    (hostId: string, terminalId: string) => {
      const pending = requestEpicTerminalLifetimeClose({
        hostId,
        terminalId,
        capability: closeCapability,
        canMutate: closeCanMutate,
        close: async () => {
          await closeMutation.mutateAsync({ hostId, terminalId });
        },
      });
      if (pending === null) return;
      void pending.catch(() => undefined);
    },
    [closeCanMutate, closeCapability, closeMutation],
  );

  const onDurableRename = useCallback(
    (
      hostId: string,
      terminalId: string,
      manualTitle: string,
      onSuccess: () => void,
    ) => {
      if (!closeCanMutate || renameMutation.isPending) return;
      renameMutation.mutate({ hostId, terminalId, manualTitle }, { onSuccess });
    },
    [closeCanMutate, renameMutation],
  );

  const prepareOpenRow = useCallback(
    (row: TerminalSidebarSessionRow): EpicTerminalRef | null => {
      if (row.durable && resolveOwnerClient(row.hostId) === null) {
        toast(
          `Can't open this terminal right now - host ${row.hostId} is not reachable.`,
        );
        return null;
      }
      return makeListedEpicTerminalRef({
        session: row.session,
        hostId: row.hostId,
        instanceId: uuidv4(),
        durable: row.durable,
      });
    },
    [resolveOwnerClient],
  );

  // Host keeps exited sessions for a 60s grace window; filter so a
  // single kill click feels like "remove" instead of "mark dead".
  const reconciled = useMemo(
    () =>
      reconcileTerminalSidebarSessions({
        epicId,
        servingHostId: activeHostId,
        capability: closeCapability,
        topology:
          plainTerminalCapabilityTopology(durableAuthority.capability) ??
          "fleet",
        coverage: durableAuthority.coverage ?? null,
        listed: list.data?.sessions ?? [],
        durableCollection: durableAuthority.collection,
      }),
    [
      activeHostId,
      closeCapability,
      durableAuthority.capability,
      durableAuthority.collection,
      durableAuthority.coverage,
      epicId,
      list.data?.sessions,
    ],
  );
  const rows = reconciled.rows;
  const incompleteFleet = reconciled.incompleteFleet;
  // The list no longer captions partial fleet coverage - the epic status
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

  const durableRenameIdentityKeys = useMemo(
    () =>
      new Set(
        plainTerminalCollectionValues(durableAuthority.collection).map(
          (terminal) =>
            plainTerminalCollectionIdentityKey(
              terminal.record.hostId,
              terminal.record.terminalId,
            ),
        ),
      ),
    [durableAuthority.collection],
  );

  return {
    rows,
    failedCreates,
    isLoading:
      failedCreates.length === 0 &&
      (closeCapability === "unknown" ||
        (incompleteFleet && !fleetGapSettled && rows.length === 0) ||
        (rows.length === 0 &&
          (list.isPending ||
            (closeCapability === "capable" &&
              durableAuthority.collection === undefined)))),
    isError: Boolean(
      closeCapability !== "unknown" && list.isError && rows.length === 0,
    ),
    errorMessage: list.error?.message ?? null,
    isRetrying: list.isFetching,
    retry,
    hostId: activeHostId,
    prepareOpenRow,
    closeCapability,
    closeCanMutate,
    closePending: closeMutation.isPending,
    onDurableClose,
    durableRenameIdentityKeys,
    durableRenamePending: renameMutation.isPending,
    onDurableRename,
  };
}

export interface EpicTerminalRowActions {
  /** What the session is called on screen, from the one shared definition. */
  readonly label: string;
  readonly canRename: boolean;
  readonly renamePending: boolean;
  /**
   * Commits a rename through whichever authority owns this row. A blank or
   * unchanged title is a no-op that still reports done, so a surface can close
   * its editor on the same call either way.
   */
  readonly submitRename: (next: string, onDone: () => void) => void;
  /**
   * Not a pending flag: it also encodes "not permitted" (unsupported future
   * ref, unknown capability, no mutation authority).
   */
  readonly closeDisabled: boolean;
  readonly requestClose: () => void;
}

/**
 * A single row's rename and close, routed to the authority that owns it.
 */
export function useEpicTerminalRowActions(args: {
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string;
  readonly session: ListedTerminalSidebarSession;
  readonly durable: boolean;
  readonly authority: EpicTerminalRowAuthority;
}): EpicTerminalRowActions {
  const { authority, durable, epicId, hostId, session, tabId } = args;
  // The row's terminal lives on the host this surface LISTS (the Epic
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

  const renameMode = hasUnsupportedFutureRef
    ? "disabled"
    : resolveTerminalSidebarRenameMode({
        capability: authority.closeCapability,
        canMutate: authority.closeCanMutate,
        hasProjection: authority.durableRenameIdentityKeys.has(
          plainTerminalCollectionIdentityKey(hostId, session.sessionId),
        ),
      });
  let renamePending = false;
  if (renameMode === "capable") renamePending = authority.durableRenamePending;
  if (renameMode === "legacy") renamePending = legacyRename.isPending;
  const canRename = renameMode !== "disabled" && !renamePending;
  const label = terminalSessionLabel(session);

  const submitRename = (next: string, onDone: () => void): void => {
    if (!canRename) return;
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === label) {
      onDone();
      return;
    }
    // The mutation optimistically patches the cached `terminal.list` rows,
    // so this row AND any open canvas tab for the session update before the
    // host round-trip (with rollback on error).
    if (renameMode === "capable") {
      authority.onDurableRename(hostId, session.sessionId, trimmed, onDone);
      return;
    }
    legacyRename.mutate(
      { sessionId: session.sessionId, title: trimmed },
      { onSuccess: onDone },
    );
  };

  // "Close" terminates the PTY AND closes its open canvas tab. Killing alone
  // only drops the host session (and its row); the open tile would
  // otherwise linger until the exit frame round-trips - and not at all if the
  // tile is currently unmounted. Closing the tab here makes the action
  // immediate and mount-independent. `findOpenTileInTab` returns null when
  // no tab is open for this session, so a list-only session just gets killed.
  const requestClose = (): void => {
    if (hasUnsupportedFutureRef) return;
    if (durable) {
      if (
        authority.closeCapability !== "capable" ||
        !authority.closeCanMutate ||
        authority.closePending
      ) {
        return;
      }
      authority.onDurableClose(hostId, session.sessionId);
      return;
    }
    if (authority.closeCapability === "unknown" || kill.isPending) return;
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

  return {
    label,
    canRename,
    renamePending,
    submitRename,
    closeDisabled:
      hasUnsupportedFutureRef ||
      (durable
        ? authority.closeCapability !== "capable" ||
          !authority.closeCanMutate ||
          authority.closePending
        : authority.closeCapability === "unknown" || kill.isPending),
    requestClose,
  };
}
