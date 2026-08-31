import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  isHostOptionSelectable,
  type HostRowSurfaceState,
} from "@/components/settings/host-scope/host-option-model";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
import {
  groupSweepHostPickerRows,
  SWEEP_HOST_OCCUPANCY_LABEL,
  type SweepHostPickerRow,
} from "@/components/epics/sweep-host-model";
import { cn } from "@/lib/utils";

/**
 * The completeness rationale, demoted.
 *
 * It used to be the host step's DESCRIPTION - the first thing a person read
 * when all they wanted was to clean up, defending a decision they had not
 * questioned. It is still worth being able to read, which is why it survives
 * at all; it is not worth reading first, which is why it sits behind
 * "Why every host?".
 */
const SWEEP_HOST_COMPLETENESS_LINE =
  "Every host is listed — a machine can hold this task's worktrees even with no agent on it.";

/**
 * Sweep's host list: WHICH machine's worktrees the open dialog is censusing.
 *
 * It is the body of the chip's popover, and it was the whole of a modal that
 * stood in front of the dialog until this epic. Nothing about the LIST changed
 * in that move - the grouping, the completeness rule and the inert rows are
 * the same - only what surrounds it. That matters: as a modal it had to carry
 * a question, a rationale and a footer of its own, and it answered "which
 * host" a screen away from the census that is the only real answer to it.
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
 * The list is GROUPED, never scoped. Badged hosts and the one being censused
 * sit at the top level; the rest of the fleet collapses under one disclosure.
 * That is presentation only - every host is still a row, still selectable when
 * it can be dialled, and still there when the badge signal is wrong, which is
 * the case the completeness rule exists for. Scoping the list to the Epic's
 * participating hosts would read almost identically and would delete exactly
 * that backstop.
 *
 * Mounted only while the popover is OPEN (Radix drops the content otherwise),
 * which is what keeps `useHostOptions`'s liveness cadence off every surface
 * that can open a Sweep.
 */
export function SweepHostList(props: {
  readonly rows: readonly SweepHostPickerRow[];
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
      <SweepHostRowGroups
        rows={props.rows}
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
      <SweepHostCompletenessNote />
    </div>
  );
}

/**
 * The rationale, as an affordance rather than a preamble. Collapsed on every
 * open, because a person who has already read it once is here to pick a
 * machine.
 */
function SweepHostCompletenessNote(): ReactNode {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-border/40 pt-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((current) => !current);
        }}
        data-testid="sweep-host-why-every-host"
        className={cn(
          "self-start rounded-md px-1 py-0.5 text-start text-ui-xs text-muted-foreground",
          "transition-colors hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
      >
        Why every host?
      </button>
      {expanded ? (
        <p
          className="text-ui-xs leading-relaxed text-muted-foreground wrap-anywhere"
          data-testid="sweep-host-completeness"
        >
          {SWEEP_HOST_COMPLETENESS_LINE}
        </p>
      ) : null}
    </div>
  );
}

function SweepHostRowGroups(props: {
  readonly rows: readonly SweepHostPickerRow[];
  readonly isLoading: boolean;
  readonly listsFailed: boolean;
  readonly onRetryLists: () => void;
  readonly onPick: (hostId: string) => void;
}): ReactNode {
  // Collapsed on every open. The popover content is mounted per open, so this
  // needs no reset of its own - and a disclosure that remembered being open
  // would defeat the grouping for the rest of the session on exactly the
  // accounts it was added for.
  const [otherExpanded, setOtherExpanded] = useState(false);
  const groups = groupSweepHostPickerRows(props.rows);
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
    <div className="flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain">
      <SweepHostRows rows={groups.primary} onPick={props.onPick} />
      {groups.other.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={otherExpanded}
            onClick={() => {
              setOtherExpanded((expanded) => !expanded);
            }}
            data-testid="sweep-host-other-toggle"
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
            <SweepHostRows rows={groups.other} onPick={props.onPick} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SweepHostRows(props: {
  readonly rows: readonly SweepHostPickerRow[];
  readonly onPick: (hostId: string) => void;
}): ReactNode {
  return (
    <ul className="flex min-w-0 flex-col gap-1">
      {props.rows.map((row) => (
        <SweepHostOption
          key={row.host.hostId}
          row={row}
          onPick={props.onPick}
        />
      ))}
    </ul>
  );
}

function SweepHostOption(props: {
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
        data-testid={`sweep-host-option-${row.host.hostId}`}
        data-occupied={row.occupied ? "true" : "false"}
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
        {row.occupied ? (
          <span
            className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-1.5 text-ui-xs text-primary"
            data-testid="sweep-host-occupancy"
          >
            {SWEEP_HOST_OCCUPANCY_LABEL}
          </span>
        ) : null}
      </button>
    </li>
  );
}
