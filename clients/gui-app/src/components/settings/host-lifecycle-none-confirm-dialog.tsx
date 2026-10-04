import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { HostQuitDialogView } from "@/components/host/host-quit-dialog-view";
import { useDisclosedStopForce } from "@/components/host/use-disclosed-stop-force";
import {
  useLocalHostQuitStatus,
  type LocalHostQuitStatus,
} from "@/components/host/use-local-host-quit-status";
import { useRunnerHostLifecycleQuery } from "@/hooks/runner/use-runner-host-lifecycle-query";
import { useRunnerHostLifecycleSetMutation } from "@/hooks/runner/use-runner-host-lifecycle-set-mutation";
import { useHostBinding } from "@/lib/host";
import { isForegroundHostRun } from "@/lib/host/host-foreground-run";
import {
  HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION,
  HOST_LIFECYCLE_SUPERSEDED_TITLE,
  HOST_NONE_CONFIRM_DESCRIPTION,
  HOST_NONE_CONFIRM_DESCRIPTION_FOREGROUND,
  HOST_NONE_CONFIRM_STOP_LABEL,
  HOST_NONE_CONFIRM_SWITCH_LABEL,
  HOST_NONE_CONFIRM_TITLE_BUSY,
  HOST_NONE_CONFIRM_TITLE_FOREGROUND,
  HOST_NONE_CONFIRM_TITLE_IDLE,
  HOST_QUIT_HOST_CHANGED_DESCRIPTION,
  HOST_QUIT_HOST_CHANGED_TITLE,
  HOST_QUIT_TITLE_CHECKING,
  HOST_QUIT_TITLE_UNKNOWN,
  hostLifecycleSetRefusalCopy,
  hostQuitCountsLine,
  hostQuitUnknownDescription,
} from "@/lib/host/host-lifecycle-copy";

interface HostLifecycleNoneConfirmDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * The `→ none` confirm: switching this machine to "no local host" stops the
 * host that is running now, so it goes through the quit modal in its
 * stop-only form - the same list and counts, "Stop host" as the only action,
 * no Remember. The mode is written only once main's stop succeeds; Cancel
 * leaves everything as it was.
 *
 * During a foreground run there is nothing to stop: main refuses the stop as
 * `not-service-run` and commits `none` with the terminal host left running, so
 * that form says so and offers Switch instead (see `ForegroundNoneConfirm`).
 * It follows the live view, so a run that ends while this is open turns it
 * back into the stop form.
 *
 * Mounted only while open, so every opening asks the host afresh.
 */
export function HostLifecycleNoneConfirmDialog(
  props: HostLifecycleNoneConfirmDialogProps,
): ReactNode {
  if (!props.open) return null;
  return <NoneConfirmBody onClose={props.onClose} />;
}

/** Split on the binding, as the quit modal is; see `HostQuitDialog`. */
function NoneConfirmBody(props: { readonly onClose: () => void }): ReactNode {
  const binding = useHostBinding();
  const foreground = isForegroundHostRun(useRunnerHostLifecycleQuery().data);
  if (foreground) return <ForegroundNoneConfirm onClose={props.onClose} />;
  if (binding === null) {
    return <NoneConfirm status={UNBOUND_STATUS} onClose={props.onClose} />;
  }
  return <BoundNoneConfirm onClose={props.onClose} />;
}

function BoundNoneConfirm(props: { readonly onClose: () => void }): ReactNode {
  const status = useLocalHostQuitStatus(true);
  return <NoneConfirm status={status} onClose={props.onClose} />;
}

/**
 * The foreground-run form: no list (nothing will be stopped), and Switch as
 * the one action. It still sends `stop: "if-idle"` - main requires a stop
 * choice, and if the terminal host exited meanwhile and an idle service host
 * came up, an idle-only stop is all that may run; a busy one comes back
 * `host-busy` and is shown like any refusal.
 */
function ForegroundNoneConfirm(props: {
  readonly onClose: () => void;
}): ReactNode {
  const setMode = useRunnerHostLifecycleSetMutation();
  const [refusal, setRefusal] = useState<string | null>(null);
  const onSwitch = (): void => {
    setRefusal(null);
    setMode.mutate(
      { request: { mode: "none", stop: "if-idle" }, source: "settings" },
      {
        onSuccess: (result) => {
          switch (result.kind) {
            case "applied":
              props.onClose();
              return;
            case "superseded":
              props.onClose();
              toast.info(HOST_LIFECYCLE_SUPERSEDED_TITLE, {
                description: HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION,
              });
              return;
            case "stop-refused":
            case "failed":
              setRefusal(hostLifecycleSetRefusalCopy(result.reason));
              return;
          }
        },
      },
    );
  };
  return (
    <HostQuitDialogView
      open
      stateKind="foreground"
      title={HOST_NONE_CONFIRM_TITLE_FOREGROUND}
      description={HOST_NONE_CONFIRM_DESCRIPTION_FOREGROUND}
      detail={refusal}
      countsLine={null}
      sessionsHostId={null}
      stoppingLine={null}
      remember={null}
      keepLabel={HOST_NONE_CONFIRM_SWITCH_LABEL}
      stopLabel={null}
      stopDisabled
      pendingAction={setMode.isPending ? "keep" : null}
      onKeep={onSwitch}
      onStop={() => undefined}
      onCancel={props.onClose}
      onNavigate={props.onClose}
    />
  );
}

const UNBOUND_STATUS: LocalHostQuitStatus = {
  localHostId: null,
  verdict: { kind: "unknown", reason: "no-connection" },
  liveLocalHostIdNow: () => null,
  recheck: () => undefined,
};

function noneConfirmTitle(
  busy: boolean,
  kind: LocalHostQuitStatus["verdict"]["kind"],
): string {
  if (busy) return HOST_NONE_CONFIRM_TITLE_BUSY;
  if (kind === "unknown") return HOST_QUIT_TITLE_UNKNOWN;
  if (kind === "checking") return HOST_QUIT_TITLE_CHECKING;
  return HOST_NONE_CONFIRM_TITLE_IDLE;
}

function NoneConfirm(props: {
  readonly status: LocalHostQuitStatus;
  readonly onClose: () => void;
}): ReactNode {
  const { status } = props;
  const setMode = useRunnerHostLifecycleSetMutation();
  // Set when main's if-idle stop found work after an idle list: the host has
  // now disclosed it is busy, so the next Stop is a force.
  const [forceNext, setForceNext] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const verdict = status.verdict;
  const facts =
    verdict.kind === "busy" || verdict.kind === "idle" ? verdict : null;
  const busy = forceNext || verdict.kind === "busy";
  const title = noneConfirmTitle(busy, verdict.kind);
  const detail =
    refusal ??
    (verdict.kind === "unknown"
      ? hostQuitUnknownDescription(verdict.reason)
      : null);
  // Force only after disclosure: a list that was busy or unreadable when Stop
  // was first offered, or the host's own busy refusal. An idle list stops if
  // idle, and so does one that turned busy after it was offered (see
  // `useDisclosedStopForce`); the host's refusal then sets `forceNext`.
  const disclosedForce = useDisclosedStopForce({
    offerKey: "none-confirm",
    enabled: verdict.kind !== "checking",
    force: verdict.kind === "busy" || verdict.kind === "unknown",
  });
  const stop =
    forceNext || disclosedForce ? ("force" as const) : ("if-idle" as const);

  const onStop = (): void => {
    const liveHostId = status.liveLocalHostIdNow();
    if (
      liveHostId !== null &&
      status.localHostId !== null &&
      liveHostId !== status.localHostId
    ) {
      toast.info(HOST_QUIT_HOST_CHANGED_TITLE, {
        description: HOST_QUIT_HOST_CHANGED_DESCRIPTION,
      });
      setForceNext(false);
      status.recheck();
      return;
    }
    setRefusal(null);
    setMode.mutate(
      { request: { mode: "none", stop }, source: "settings" },
      {
        onSuccess: (result) => {
          switch (result.kind) {
            case "applied":
              props.onClose();
              return;
            case "superseded":
              props.onClose();
              toast.info(HOST_LIFECYCLE_SUPERSEDED_TITLE, {
                description: HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION,
              });
              return;
            case "stop-refused":
              setRefusal(hostLifecycleSetRefusalCopy(result.reason));
              if (result.reason === "host-busy") {
                setForceNext(true);
                status.recheck();
              }
              return;
            case "failed":
              setRefusal(hostLifecycleSetRefusalCopy(result.reason));
              return;
          }
        },
      },
    );
  };

  return (
    <HostQuitDialogView
      open
      stateKind={busy ? "busy" : verdict.kind}
      title={title}
      description={HOST_NONE_CONFIRM_DESCRIPTION}
      detail={detail}
      countsLine={
        facts === null
          ? null
          : hostQuitCountsLine({
              // The host's own busy refusal outranks an idle list read
              // before it, as the title does.
              busy,
              busySessionCount: facts.busySessionCount,
              breakdown: facts.breakdown,
              statusMinor: facts.statusMinor,
            })
      }
      sessionsHostId={busy ? status.localHostId : null}
      stoppingLine={null}
      remember={null}
      keepLabel={null}
      stopLabel={HOST_NONE_CONFIRM_STOP_LABEL}
      stopDisabled={!forceNext && verdict.kind === "checking"}
      pendingAction={setMode.isPending ? "stop" : null}
      onKeep={() => undefined}
      onStop={onStop}
      onCancel={props.onClose}
      onNavigate={props.onClose}
    />
  );
}
