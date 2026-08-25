import { useCallback } from "react";
import { Terminal } from "lucide-react";
import { SwitcherListRow } from "@/components/epic-canvas/mobile/switcher-list-row";
import { SwitcherTerminalRowActions } from "@/components/epic-canvas/mobile/switcher-terminal-row-actions";
import { SwitcherNewTerminalRow } from "@/components/epic-canvas/mobile/switcher-create-actions";
import { useSwitcherActivate } from "@/components/epic-canvas/mobile/use-switcher-activate";
import {
  FailedTerminalCreateRow,
  TerminalsEmptyState,
  TerminalsErrorState,
  TerminalsLoadingState,
} from "@/components/epic-canvas/sidebar/terminal-list-states";
import {
  useEpicTerminalsPanel,
  type EpicTerminalsPanel,
} from "@/components/epic-canvas/sidebar/use-epic-terminals-panel";
import { OwnerResourceChip } from "@/components/resources/resource-usage-chip";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { epicTerminalUiIdentityKey } from "@/lib/terminals/pending-create-identity";
import { terminalSessionLabel } from "@/lib/terminals/terminal-title";
import type { TerminalSidebarSessionRow } from "@/lib/terminals/reconcile-terminal-sidebar-sessions";
import { useIsActiveTile } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";

/** Every test id this list's shared states and rows are grabbed by. */
const TERMINALS_TEST_ID_PREFIX = "switcher-terminal";

interface SwitcherListProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * Terminals category. Rows, load/error/empty states and every mutation come
 * from `useEpicTerminalsPanel`, the same layer the desktop Terminals panel
 * mounts - so a phone lists the identical reconciled set (durable
 * `terminal.plain.list` projections included, which a raw `terminal.list` read
 * cannot see once a host is capable) and never opens a durable terminal as a
 * legacy-authority tile. Sessions on an unreachable host are still shown
 * (decision); opening one is refused with a reason rather than landing a dead
 * tile.
 *
 * This file owns only the touch chrome: a flat scroller instead of the
 * desktop's draggable tree rows. The tap itself goes through
 * {@link useSwitcherActivate}, so this category recycles the one shown tile on
 * exactly the terms every other category does.
 */
export function SwitcherTerminalsList(props: SwitcherListProps) {
  const { epicId, tabId, onClose } = props;
  const panel = useEpicTerminalsPanel({ epicId });
  const canMutate = isEditableRole(useEpicPermissionRole());
  const activate = useSwitcherActivate(epicId, tabId, onClose);

  const prepareOpenRow = panel.prepareOpenRow;
  const openRow = useCallback(
    (row: TerminalSidebarSessionRow) => {
      // A refused row (unreachable owner host) never reaches the canvas, and
      // leaves the sheet open on the toast explaining why.
      const tile = prepareOpenRow(row);
      if (tile === null) return;
      activate(() => tile);
    },
    [activate, prepareOpenRow],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain p-1 pb-safe-bottom">
      {/* Editor-gated: a viewer's create is server-rejected, so an ungated row
          would only lead to a dead end. Inside the scroll region and above the
          items, so it is the first thing in the list either way. */}
      {canMutate ? (
        <SwitcherNewTerminalRow
          epicId={epicId}
          tabId={tabId}
          onClose={onClose}
        />
      ) : null}
      <SwitcherTerminalsBody
        panel={panel}
        epicId={epicId}
        tabId={tabId}
        onOpen={openRow}
      />
    </div>
  );
}

function SwitcherTerminalsBody(props: {
  readonly panel: EpicTerminalsPanel;
  readonly epicId: string;
  readonly tabId: string;
  readonly onOpen: (row: TerminalSidebarSessionRow) => void;
}) {
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
    <>
      {panel.rows.map((row) => (
        <SwitcherTerminalRow
          key={epicTerminalUiIdentityKey(
            "session",
            row.hostId,
            row.session.sessionId,
          )}
          row={row}
          epicId={props.epicId}
          tabId={props.tabId}
          panel={panel}
          onOpen={() => props.onOpen(row)}
        />
      ))}
      {panel.failedCreates.map((job) => (
        <FailedTerminalCreateRow
          key={epicTerminalUiIdentityKey(
            "failed",
            job.request.hostId,
            job.request.terminalId,
          )}
          job={job}
          testIdPrefix={TERMINALS_TEST_ID_PREFIX}
        />
      ))}
    </>
  );
}

function SwitcherTerminalRow(props: {
  readonly row: TerminalSidebarSessionRow;
  readonly epicId: string;
  readonly tabId: string;
  readonly panel: EpicTerminalsPanel;
  readonly onOpen: () => void;
}) {
  const { row, epicId, tabId, panel, onOpen } = props;
  const { hostId, session } = row;
  // Host-scoped, like desktop: two fleet terminals sharing a terminalId must
  // not both read as the current tile.
  const isActive = useIsActiveTile(tabId, session.sessionId, hostId);
  const showNavigatorResourceStats = useSettingsStore(
    (state) => state.showNavigatorResourceStats,
  );
  const label = terminalSessionLabel(session);

  return (
    <SwitcherListRow
      icon={<Terminal className="size-4 shrink-0 text-muted-foreground" />}
      label={label}
      secondaryLabel={
        row.runtimeStatus === "unknown" ? "Runtime status unavailable" : null
      }
      badge={
        showNavigatorResourceStats ? (
          <OwnerResourceChip
            epicId={epicId}
            kind="terminal"
            ownerId={session.sessionId}
            hostId={hostId}
            className={undefined}
          />
        ) : null
      }
      active={isActive}
      onSelect={onOpen}
      selectTestId={`switcher-terminal-row-${session.sessionId}`}
      actions={
        <SwitcherTerminalRowActions
          epicId={epicId}
          tabId={tabId}
          hostId={hostId}
          session={session}
          durable={row.durable}
          authority={panel}
        />
      }
    />
  );
}
