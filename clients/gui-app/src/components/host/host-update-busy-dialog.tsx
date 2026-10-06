import { toast } from "sonner";
import type {
  ActivateInstalledOk,
  BusyContinuation,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";
import { HostRestartSessions } from "@/components/host/host-restart-sessions";
import { useLocalHostQuitStatus } from "@/components/host/use-local-host-quit-status";
import { useRunnerActivateInstalled } from "@/hooks/runner/use-runner-activate-installed-mutation";
import { useHostBinding } from "@/lib/host";
import { hostQuitCountsLine } from "@/lib/host/host-lifecycle-copy";

export const HOST_RESTART_WHEN_IDLE_LABEL = "Restart when idle";
export const HOST_RESTART_WHEN_IDLE_SCHEDULED =
  "The host will restart to finish the update once its work is done.";

export interface HostUpdateBusyDialogProps {
  /** The busy outcome an update or activation settled with; `null` = closed. */
  readonly busy: {
    readonly continuation: BusyContinuation;
    readonly message: string;
  } | null;
  readonly isForcing: boolean;
  readonly onForce: () => void;
  readonly onDefer: () => void;
  /**
   * Receives every "Restart when idle" outcome but `busy`, which this dialog
   * answers itself: there it means the restart is scheduled. The caller's own
   * activate handler, so a restart that landed at once, or failed, reads as
   * it does from that surface's other buttons.
   */
  readonly onActivateOutcome: (
    outcome: MutationOutcome<ActivateInstalledOk>,
  ) => void;
}

/**
 * The "Host is busy" dialog of the three update surfaces (the home banner,
 * the app menu and the tray), which used to show one fixed sentence and two
 * answers. It adds what the host says is working, the sessions this window
 * knows about, and, for an update that is installed and only waiting on its
 * restart, a way to have that restart happen once the host is idle.
 */
export function HostUpdateBusyDialog(props: HostUpdateBusyDialogProps) {
  const { busy, onActivateOutcome, onDefer } = props;
  const whenIdle = useRunnerActivateInstalled();
  const activatePending = busy?.continuation === "activate";
  return (
    <HostBusyForceDeferDialog
      purpose="update"
      detail={null}
      open={busy !== null}
      title="Host is busy"
      message={busy?.message ?? ""}
      isForcing={props.isForcing}
      forceLabel={activatePending ? "Force restart" : "Force update"}
      forceDestructive
      onForce={props.onForce}
      onDefer={onDefer}
      idleAction={
        // Only where Force restarts and nothing else: an update that is not
        // installed yet has no idle-gated continuation to schedule.
        activatePending
          ? {
              label: HOST_RESTART_WHEN_IDLE_LABEL,
              isPending: whenIdle.isPending,
              onClick: () => {
                whenIdle.mutate(
                  { force: false, retryWhenIdle: true },
                  {
                    onSuccess: (outcome) => {
                      if (outcome.kind !== "busy") {
                        onActivateOutcome(outcome);
                        return;
                      }
                      toast.info(HOST_RESTART_WHEN_IDLE_SCHEDULED);
                      onDefer();
                    },
                  },
                );
              },
            }
          : null
      }
    >
      {busy === null ? null : (
        <HostBusyWork
          disabled={props.isForcing || whenIdle.isPending}
          onNavigate={onDefer}
        />
      )}
    </HostBusyForceDeferDialog>
  );
}

interface HostBusyWorkProps {
  readonly disabled: boolean;
  readonly onNavigate: () => void;
}

/** `useLocalHostQuitStatus` needs a host runtime binding, so split on it. */
function HostBusyWork(props: HostBusyWorkProps) {
  const binding = useHostBinding();
  if (binding === null) return null;
  return <BoundHostBusyWork {...props} />;
}

/**
 * What is working on this machine's host: the sessions list the manual
 * restart dialog shows, then the `host.status` breakdown in the quit prompt's
 * words. Read live while the dialog is up. Nothing is shown for a host that
 * could not be asked; the dialog's own sentence stands on its own then.
 */
function BoundHostBusyWork(props: HostBusyWorkProps) {
  const status = useLocalHostQuitStatus(true);
  const verdict = status.verdict;
  const countsLine =
    verdict.kind === "busy" || verdict.kind === "idle"
      ? hostQuitCountsLine({
          busy: verdict.kind === "busy",
          busySessionCount: verdict.busySessionCount,
          breakdown: verdict.breakdown,
          statusMinor: verdict.statusMinor,
        })
      : null;
  return (
    <>
      {status.localHostId === null ? null : (
        <HostRestartSessions
          hostId={status.localHostId}
          disabled={props.disabled}
          onNavigate={props.onNavigate}
        />
      )}
      {countsLine === null ? null : (
        <p
          className="border-t border-border/60 px-5 py-3 text-ui-sm text-muted-foreground"
          data-testid="host-busy-work-counts"
        >
          {countsLine}
        </p>
      )}
    </>
  );
}
