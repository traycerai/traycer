import { useState, type ReactNode } from "react";
import { ChevronDown, Monitor } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { SweepHostList } from "@/components/epics/sweep-host-list";
import {
  buildSweepHostPickerRows,
  type SweepHostPickerRow,
} from "@/components/epics/sweep-host-model";
import { cn } from "@/lib/utils";

/** A question rather than a guess. The dialog behind it runs no census in this state, so a chip that named a
 * machine would be claiming to show that machine's worktrees while showing nothing. */
export const SWEEP_HOST_UNCHOSEN_LABEL = "Choose a host";

/** `null` means this account has one usable host, so there is no decision and no chip - the dialog renders
 * exactly what it rendered before multi-host Sweep existed. */
export interface SweepHostChoice {
  /** Never derived from anything the fleet plane can move underneath an open confirmation - and, `null` or not,
   * never filled in from a fallback here: the whole point of the latch is that this is the one answer. */
  readonly hostId: string | null;
  /** A host that was picked and whose client then would not build. */
  readonly unavailableHostId: string | null;
  readonly onSwitch: (hostId: string) => void;
}

/** The chip arrives as an element rather than as data because only this scope holds the fleet list it is drawn
 * from, and threading `hosts` through the dialog would put a second reader on it. */
export interface SweepHostChoiceView {
  /** The chip, or `null` when the host cannot be named yet. */
  readonly chip: ReactNode;
  readonly hostName: string | null;
  /** A nullable callback rather than a callback plus a `disabled` flag, because the two shapes are not equally
   * safe: with a flag, a new switch surface reads as complete while quietly skipping the check. */
  readonly requestSwitch: ((hostId: string) => void) | null;
}

/** A render prop rather than a wrapper with children, because the dialog's body needs the view and the view
 * needs a hook. */
export function SweepHostChoiceScope(props: {
  /** `null` ⇒ unchosen: the chip asks instead of naming. */
  readonly hostId: string | null;
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly currentHostCount: number | null;
  readonly unavailableHostId: string | null;
  readonly disabled: boolean;
  /** Switching would discard checks the person made by hand. */
  readonly hasSelectionOverrides: boolean;
  readonly onSwitch: (hostId: string) => void;
  readonly render: (view: SweepHostChoiceView) => ReactNode;
}): ReactNode {
  const { hosts, isLoading, listsFailed, retryLists } = useHostOptions();
  // Held rather than applied, because the retarget it triggers clears that selection and there is no undo for a
  // list you spent a minute on.
  const [pendingHostId, setPendingHostId] = useState<string | null>(null);
  const rows = buildSweepHostPickerRows({
    hosts,
    defaultHostId: props.hostId,
  });
  const hostName = hostNameOf(hosts, props.hostId);
  const unavailableName = hostNameOf(hosts, props.unavailableHostId);
  // Both the gesture that raises a switch and the one that commits a held question derive from it, so a switch
  // cannot be admitted by a check that ran at a moment which has since passed.
  const switchNow = props.disabled
    ? null
    : (hostId: string): void => {
        setPendingHostId(null);
        props.onSwitch(hostId);
      };
  const requestSwitch =
    switchNow === null
      ? null
      : (hostId: string): void => {
          // Picking the host you are already on is not a host change, and
          // warning that it would clear your list is a lie.
          if (hostId === props.hostId) return;
          if (props.hasSelectionOverrides) {
            setPendingHostId(hostId);
            return;
          }
          switchNow(hostId);
        };
  const chipLabel = sweepChipLabel(props.hostId, hostName);
  const view: SweepHostChoiceView = {
    chip:
      chipLabel === null ? null : (
        <SweepHostChip
          label={chipLabel}
          hostName={hostName}
          unavailableHostName={unavailableName}
          rows={rows}
          selectedEpicIds={props.selectedEpicIds}
          currentHostCount={props.currentHostCount}
          isLoading={isLoading}
          listsFailed={listsFailed}
          onRetryLists={retryLists}
          onPick={requestSwitch}
          pendingHost={
            rows.find((row) => row.host.hostId === pendingHostId)?.host ?? null
          }
          onCancelPending={() => {
            setPendingHostId(null);
          }}
          onConfirmPending={switchNow}
        />
      ),
    hostName,
    requestSwitch,
  };
  return props.render(view);
}

/** Disabled rather than hidden while the census is unsettled (a refresh in flight, a sweep of these rows
 * already streaming). */
function SweepHostChip(props: {
  readonly label: string;
  /** `null` while unchosen - there is no host to still be showing. */
  readonly hostName: string | null;
  readonly unavailableHostName: string | null;
  readonly rows: readonly SweepHostPickerRow[];
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly currentHostCount: number | null;
  readonly isLoading: boolean;
  readonly listsFailed: boolean;
  readonly onRetryLists: () => void;
  /** The gated seam; `null` while switching is unavailable. */
  readonly onPick: ((hostId: string) => void) | null;
  readonly pendingHost: HostScopeOption | null;
  readonly onCancelPending: () => void;
  /** Commits the held question - the same nullable policy value `onPick` comes from, re-read at confirm time. */
  readonly onConfirmPending: ((hostId: string) => void) | null;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const pendingHost = props.pendingHost;
  const confirmPending = props.onConfirmPending;
  // Forced open while a switch is waiting on an answer, so the confirmation
  // appears where the host decision lives.
  const popoverOpen = open || pendingHost !== null;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Popover
        open={popoverOpen}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          // Dismissing the popover abandons the pending switch rather than
          // applying it: closing a question is not answering it.
          if (!nextOpen) props.onCancelPending();
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={props.onPick === null}
            aria-haspopup="dialog"
            data-testid="sweep-host-chip"
            className={cn(
              "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/60 px-2 py-1",
              "text-ui-xs text-muted-foreground transition-colors",
              props.onPick === null
                ? "cursor-not-allowed opacity-60"
                : "hover:bg-foreground/5 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            )}
          >
            <Monitor className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{props.label}</span>
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          className="w-[min(88vw,24rem)] max-h-[min(var(--radix-popover-content-available-height),24rem)] overflow-y-auto"
          data-testid="sweep-host-popover"
        >
          {pendingHost === null ? (
            <SweepHostList
              rows={props.rows}
              selectedEpicIds={props.selectedEpicIds}
              currentHostCount={props.currentHostCount}
              isLoading={props.isLoading}
              listsFailed={props.listsFailed}
              onRetryLists={props.onRetryLists}
              onPick={(hostId) => {
                // Closed unconditionally: a pick that raises a confirmation re-opens through `popoverOpen`, and one that does
                // not has nothing left to show.
                setOpen(false);
                props.onPick?.(hostId);
              }}
            />
          ) : (
            <div
              className="flex min-w-0 flex-col gap-2"
              data-testid="sweep-host-switch-confirm"
            >
              <p className="text-ui-sm wrap-anywhere text-foreground">
                Changing hosts clears this selection.
              </p>
              <p className="text-ui-xs wrap-anywhere text-muted-foreground">
                {props.onConfirmPending === null
                  ? `Not while this host is busy — wait for the refresh or sweep to finish, or keep what you have.`
                  : `Sweep will check ${pendingHost.name} from scratch.`}
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={props.onCancelPending}
                  data-testid="sweep-host-switch-keep"
                >
                  Keep this selection
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  disabled={confirmPending === null}
                  onClick={
                    confirmPending === null
                      ? undefined
                      : () => {
                          setOpen(false);
                          confirmPending(pendingHost.hostId);
                        }
                  }
                  data-testid="sweep-host-switch-confirm-action"
                >
                  Change host
                </Button>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {props.unavailableHostName === null ? null : (
        <p
          className="text-ui-xs wrap-anywhere text-destructive"
          data-testid="sweep-host-unavailable"
        >
          {props.hostName === null
            ? `Couldn't reach ${props.unavailableHostName}. Choose another host.`
            : `Couldn't reach ${props.unavailableHostName} — still showing ${props.hostName}.`}
        </p>
      )}
    </div>
  );
}

/** Unchosen asks; a chosen host states what is being shown. */
function sweepChipLabel(
  hostId: string | null,
  hostName: string | null,
): string | null {
  if (hostId === null) return SWEEP_HOST_UNCHOSEN_LABEL;
  if (hostName === null) return null;
  return `on ${hostName}`;
}

function hostNameOf(
  hosts: readonly HostScopeOption[],
  hostId: string | null,
): string | null {
  if (hostId === null) return null;
  return hosts.find((host) => host.hostId === hostId)?.name ?? null;
}
