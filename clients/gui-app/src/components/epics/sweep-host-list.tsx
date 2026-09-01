import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  isHostOptionSelectable,
  type HostRowSurfaceState,
} from "@/components/settings/host-scope/host-option-model";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
import { useSweepHostWorktreeCount } from "@/hooks/epic/use-sweep-host-worktree-count-query";
import {
  sweepHostCountLabel,
  type SweepHostPickerRow,
} from "@/components/epics/sweep-host-model";
import { cn } from "@/lib/utils";

/**
 * Sweep's host list: WHICH machine's worktrees the open dialog is censusing.
 *
 * It is the body of the chip's popover. Every host in the account is a row,
 * flat, in the shared picker's own order - a machine can hold a Task's
 * worktrees with no agent record naming it, so scoping the list would delete
 * the backstop. What a row SAYS is how many of the selected Task(s)' worktrees
 * it holds, asked of the host itself and only while this list is on screen.
 *
 * `intent="pin"` throughout. Choosing here scopes ONE surface's RPCs for the
 * length of one confirmation; it does not rebind the window, and it writes no
 * pin of its own - the next Sweep opens on the surface's host again, because
 * "which host did I sweep last time" is not a preference worth remembering
 * over a destructive action. The intent also carries the plan gate for free: a
 * remote host this plan does not include is non-connectable, so its row is
 * inert exactly as it is in the terminal and workspace pickers, and Sweep
 * cannot become a side door to one.
 *
 * Mounted only while the popover is OPEN (Radix drops the content otherwise),
 * which is what keeps both `useHostOptions`'s liveness cadence and the per-row
 * count reads off every surface that can open a Sweep.
 */
export function SweepHostList(props: {
  readonly rows: readonly SweepHostPickerRow[];
  /** The Task(s) whose worktrees each row counts. */
  readonly selectedEpicIds: ReadonlySet<string>;
  /**
   * The censused host's count, from the dialog's own proof - it is not asked
   * again. `null` while there is no settled census to count.
   */
  readonly currentHostCount: number | null;
  readonly isLoading: boolean;
  readonly listsFailed: boolean;
  readonly onRetryLists: () => void;
  readonly onPick: (hostId: string) => void;
}): ReactNode {
  // This list renders liveness (an offline row is the whole reason a dead host
  // stays listed), so it opts into the registry's liveness cadence the same way
  // the workspace picker does - and only for as long as it is on screen.
  useRegisteredHostsPollLiveness();
  return (
    <div
      className="flex min-h-0 min-w-0 flex-col gap-2"
      data-testid="sweep-host-options"
    >
      <SweepHostRows
        rows={props.rows}
        selectedEpicIds={props.selectedEpicIds}
        currentHostCount={props.currentHostCount}
        isLoading={props.isLoading}
        listsFailed={props.listsFailed}
        onRetryLists={props.onRetryLists}
        onPick={props.onPick}
      />
      {props.listsFailed && !props.isLoading && props.rows.length > 0 ? (
        <div
          className="flex shrink-0 items-center justify-between gap-2"
          data-testid="sweep-host-partial-failure"
        >
          <span className="text-ui-xs text-muted-foreground">
            Some hosts may be missing
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={props.onRetryLists}
            data-testid="sweep-host-retry"
          >
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SweepHostRows(props: {
  readonly rows: readonly SweepHostPickerRow[];
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly currentHostCount: number | null;
  readonly isLoading: boolean;
  readonly listsFailed: boolean;
  readonly onRetryLists: () => void;
  readonly onPick: (hostId: string) => void;
}): ReactNode {
  if (props.rows.length === 0) {
    if (props.isLoading) {
      return (
        <p className="py-1 text-ui-sm text-muted-foreground">
          Finding your hosts…
        </p>
      );
    }
    return (
      <div className="flex flex-col items-start gap-2 py-1">
        <p
          className="text-ui-sm text-muted-foreground"
          data-testid="sweep-host-empty"
        >
          {props.listsFailed
            ? "Couldn't load your hosts."
            : "No hosts to sweep on."}
        </p>
        {props.listsFailed ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={props.onRetryLists}
            data-testid="sweep-host-retry"
          >
            Try again
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <ul className="flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain">
      {props.rows.map((row) => (
        <SweepHostOption
          key={row.host.hostId}
          row={row}
          selectedEpicIds={props.selectedEpicIds}
          currentHostCount={props.currentHostCount}
          onPick={props.onPick}
        />
      ))}
    </ul>
  );
}

function SweepHostOption(props: {
  readonly row: SweepHostPickerRow;
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly currentHostCount: number | null;
  readonly onPick: (hostId: string) => void;
}): ReactNode {
  const { row } = props;
  // Whether this host's client can actually be BUILT, asked per row and by the
  // same seam the flow resolves the pick through.
  //
  // `connectable` is a fact about the DIRECTORY - a dialable endpoint - and it
  // stays true when the client cannot be built for a reason that has nothing to
  // do with the route: `buildTransientHostClient` also answers `null` with no
  // request context or no bound user, which is the whole fleet at once, not one
  // machine. Judging the row on `connectable` alone therefore left an enabled
  // row whose every click re-entered the same unresolved pick, silently and
  // without saying why. Asking here means the refusal lands ON the row that
  // cannot serve, before a click rather than after it.
  const rowClient = useHostClientForHostId(row.host.hostId);
  const surfaceState: HostRowSurfaceState =
    rowClient === null
      ? { kind: "refused", word: "unavailable" }
      : AVAILABLE_HOST_ROW_SURFACE_STATE;
  // The SAME predicate every other picker container asks, so a row that
  // explains why it cannot be picked is also a row that cannot be picked.
  const selectable = isHostOptionSelectable(row.host, "pin", surfaceState);
  // The censused host is not asked again - the dialog's own proof already
  // counted it. Every other dialable row is asked once, here, while the
  // popover is open; an inert row is never asked at all.
  const askedCount = useSweepHostWorktreeCount({
    client: rowClient,
    selectedEpicIds: props.selectedEpicIds,
    enabled: !row.isDefault && selectable,
  });
  const countLabel = sweepHostCountLabel(
    row.isDefault ? props.currentHostCount : askedCount,
  );
  return (
    <li className="min-w-0">
      <button
        type="button"
        disabled={!selectable}
        aria-current={row.isDefault ? "true" : undefined}
        onClick={() => props.onPick(row.host.hostId)}
        data-testid={`sweep-host-option-${row.host.hostId}`}
        data-current={row.isDefault ? "true" : "false"}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-ui-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          selectable
            ? "hover:bg-accent/40"
            : "cursor-not-allowed opacity-60 hover:bg-transparent",
          row.isDefault && "bg-foreground/5",
        )}
      >
        {/* `updateView` is the shared row's opt-IN badge channel, and Sweep is
            one of the pickers that deliberately opts out: it holds no observed
            fleet-update view, and the row's contract forbids fabricating one.
            An update badge here would also answer a question this step does
            not ask - which machine holds the worktrees, not which needs
            updating. */}
        <HostOptionRow
          host={row.host}
          picked={row.isDefault}
          active={row.host.isActive}
          intent="pin"
          surfaceState={surfaceState}
          updateView={null}
        />
        {row.isDefault ? (
          <span className="sr-only">Currently showing this host</span>
        ) : null}
        {countLabel === null ? null : (
          <span
            className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-1.5 text-ui-xs text-primary"
            data-testid="sweep-host-count"
          >
            {countLabel}
          </span>
        )}
      </button>
    </li>
  );
}
