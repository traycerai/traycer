import { useState, type ReactNode } from "react";
import { ChevronRight, Paintbrush } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  isHostOptionSelectable,
  type HostRowSurfaceState,
} from "@/components/settings/host-scope/host-option-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
import {
  buildSweepHostPickerRows,
  groupSweepHostPickerRows,
  SWEEP_HOST_OCCUPANCY_LABEL,
  type SweepHostPickerRow,
} from "@/components/epics/sweep-host-model";
import { cn } from "@/lib/utils";

/**
 * Sweep's host step: WHICH machine's worktrees are we about to look at.
 *
 * It sits in front of `SweepWorktreesDialog` and hands it a host - it never
 * censuses, proves or sweeps anything itself. That division is the reason the
 * per-host act-time proof survives multi-host Sweep untouched: one dialog
 * instance is still exactly one host, frozen from the proof that dialog ran.
 *
 * `intent="pin"` throughout. Choosing here scopes ONE surface's RPCs for the
 * length of one confirmation; it does not rebind the window, and it writes no
 * pin of its own - the next Sweep asks again, because "which host did I sweep
 * last time" is not a preference worth remembering over a destructive action.
 * The intent also carries the plan gate for free: a remote host this plan does
 * not include is non-connectable, so its row is inert exactly as it is in the
 * terminal and workspace pickers, and Sweep cannot become a side door to one.
 *
 * The list is GROUPED, never scoped. Badged hosts and the surface's own sit at
 * the top level; the rest of the fleet collapses under one disclosure. That is
 * presentation only - every host is still a row, still selectable when it can
 * be dialled, and still there when the badge signal is wrong, which is the
 * case the completeness rule exists for. Scoping the list to the Epic's
 * participating hosts would read almost identically and would delete exactly
 * that backstop.
 *
 * Mounted only while a Sweep is actually choosing a host. `useHostOptions`
 * reads the cloud registry and the local runner host, so mounting it from
 * always-present chrome would put a `<RunnerHostProvider>` dependency under
 * every surface that can open a Sweep.
 */
export function SweepHostPickerDialog(props: {
  readonly open: boolean;
  /** How many Tasks are being swept — names the confirmation, as in the dialog. */
  readonly taskCount: number;
  readonly taskTitle: string | null;
  /** Hosts the selected Task(s)' node records name. Zero-RPC hint. */
  readonly occupiedHostIds: ReadonlySet<string>;
  /** The host this surface already speaks to — marked, never auto-picked. */
  readonly defaultHostId: string | null;
  readonly onPick: (hostId: string) => void;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  // This list renders liveness (an offline row is the whole reason a dead host
  // stays listed), so it opts into the registry's liveness cadence the same way
  // the workspace picker does.
  useRegisteredHostsPollLiveness();
  const { hosts, isLoading, listsFailed, retryLists } = useHostOptions();
  const rows = buildSweepHostPickerRows({
    hosts,
    occupiedHostIds: props.occupiedHostIds,
    defaultHostId: props.defaultHostId,
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(90dvh,36rem)] w-[min(92vw,30rem)] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        data-testid="sweep-host-picker-dialog"
      >
        <div className="flex min-w-0 shrink-0 items-start gap-3 px-5 pt-5 pb-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
            <Paintbrush className="size-4" aria-hidden />
          </div>
          <div className="min-h-0 min-w-0 flex-1 space-y-1.5">
            <DialogTitle className="text-ui font-semibold leading-snug wrap-anywhere">
              {sweepHostPickerTitle(props.taskCount, props.taskTitle)}
            </DialogTitle>
            <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground wrap-anywhere">
              Worktrees live on one machine. Choose the host to sweep — hosts
              this task has agents on are marked, but a host can still hold its
              worktrees without one, so every host stays listed.
            </DialogDescription>
          </div>
        </div>

        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-border/60 bg-foreground/2 px-5 py-4"
          data-testid="sweep-host-picker-options"
        >
          <SweepHostPickerList
            rows={rows}
            isLoading={isLoading}
            listsFailed={listsFailed}
            onRetryLists={retryLists}
            onPick={props.onPick}
          />
          {listsFailed && !isLoading && rows.length > 0 ? (
            <div
              className="mt-3 flex shrink-0 items-center justify-between gap-2 border-t border-border/25 pt-1.5"
              data-testid="sweep-host-picker-partial-failure"
            >
              <span className="text-ui-xs text-muted-foreground">
                Some hosts may be missing
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={retryLists}
                data-testid="sweep-host-picker-retry"
              >
                Try again
              </Button>
            </div>
          ) : null}
        </section>

        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border/60 bg-foreground/3 px-5 py-3 sm:flex sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => props.onOpenChange(false)}
            data-testid="sweep-host-picker-cancel"
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SweepHostPickerList(props: {
  readonly rows: readonly SweepHostPickerRow[];
  readonly isLoading: boolean;
  readonly listsFailed: boolean;
  readonly onRetryLists: () => void;
  readonly onPick: (hostId: string) => void;
}): ReactNode {
  // Collapsed on every open. The picker is mounted per Sweep (the flow drops
  // it between opens), so this needs no reset of its own - and a disclosure
  // that remembered being open would defeat the grouping for the rest of the
  // session on exactly the accounts it was added for.
  const [otherExpanded, setOtherExpanded] = useState(false);
  const groups = groupSweepHostPickerRows(props.rows);
  if (props.rows.length === 0) {
    if (props.isLoading) {
      return (
        <p className="py-2 text-ui-sm text-muted-foreground">
          Finding your hosts…
        </p>
      );
    }
    return (
      <div className="flex flex-col items-start gap-2 py-2">
        <p
          className="text-ui-sm text-muted-foreground"
          data-testid="sweep-host-picker-empty"
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
            data-testid="sweep-host-picker-retry"
          >
            Try again
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain rounded-lg border border-border/60 bg-background/40 p-1">
      <SweepHostPickerRows rows={groups.primary} onPick={props.onPick} />
      {groups.other.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={otherExpanded}
            onClick={() => {
              setOtherExpanded((expanded) => !expanded);
            }}
            data-testid="sweep-host-picker-other-toggle"
            className={cn(
              "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2.5 py-1.5",
              "text-start text-ui-xs text-muted-foreground transition-colors",
              "hover:bg-foreground/5 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            )}
          >
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 transition-transform",
                otherExpanded && "rotate-90",
              )}
              aria-hidden
            />
            <span className="min-w-0 truncate">
              Other hosts ({groups.other.length})
            </span>
          </button>
          {otherExpanded ? (
            <SweepHostPickerRows rows={groups.other} onPick={props.onPick} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SweepHostPickerRows(props: {
  readonly rows: readonly SweepHostPickerRow[];
  readonly onPick: (hostId: string) => void;
}): ReactNode {
  return (
    <ul className="flex min-w-0 flex-col gap-1">
      {props.rows.map((row) => (
        <SweepHostPickerOption
          key={row.host.hostId}
          row={row}
          onPick={props.onPick}
        />
      ))}
    </ul>
  );
}

function SweepHostPickerOption(props: {
  readonly row: SweepHostPickerRow;
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
  return (
    <li className="min-w-0">
      <button
        type="button"
        disabled={!selectable}
        aria-current={row.isDefault ? "true" : undefined}
        onClick={() => props.onPick(row.host.hostId)}
        data-testid={`sweep-host-picker-option-${row.host.hostId}`}
        data-occupied={row.occupied ? "true" : "false"}
        data-default={row.isDefault ? "true" : "false"}
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
          <span className="sr-only">Current host for this surface</span>
        ) : null}
        {row.occupied ? (
          <span
            className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-1.5 text-ui-xs text-primary"
            data-testid="sweep-host-picker-occupancy"
          >
            {SWEEP_HOST_OCCUPANCY_LABEL}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/**
 * Names what is about to be swept, in the same voice the confirmation dialog
 * behind it uses - the host step should read as the first half of one
 * question, not as an unrelated chooser that appeared first.
 */
function sweepHostPickerTitle(
  taskCount: number,
  taskTitle: string | null,
): string {
  if (taskCount > 1)
    return `Sweep worktrees for ${taskCount} tasks — on which host?`;
  return taskTitle === null
    ? "Sweep worktrees — on which host?"
    : `Sweep worktrees for "${taskTitle}" — on which host?`;
}
