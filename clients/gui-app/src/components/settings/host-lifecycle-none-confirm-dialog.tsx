import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { HostQuitDialogView } from "@/components/host/host-quit-dialog-view";
import {
  useLocalHostQuitStatus,
  type LocalHostQuitStatus,
} from "@/components/host/use-local-host-quit-status";
import { useRunnerHostLifecycleSetMutation } from "@/hooks/runner/use-runner-host-lifecycle-set-mutation";
import { useHostBinding } from "@/lib/host";
import {
  HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION,
  HOST_LIFECYCLE_SUPERSEDED_TITLE,
  HOST_NONE_CONFIRM_DESCRIPTION,
  HOST_NONE_CONFIRM_STOP_LABEL,
  HOST_NONE_CONFIRM_TITLE_BUSY,
  HOST_NONE_CONFIRM_TITLE_IDLE,
  HOST_QUIT_HOST_CHANGED_DESCRIPTION,
  HOST_QUIT_HOST_CHANGED_TITLE,
  HOST_QUIT_TITLE_CHECKING,
  HOST_QUIT_TITLE_UNKNOWN,
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
  if (binding === null) {
    return <NoneConfirm status={UNBOUND_STATUS} onClose={props.onClose} />;
  }
  return <BoundNoneConfirm onClose={props.onClose} />;
}

function BoundNoneConfirm(props: { readonly onClose: () => void }): ReactNode {
  const status = useLocalHostQuitStatus(true);
  return <NoneConfirm status={status} onClose={props.onClose} />;
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
  // Force only after disclosure: a busy list, an unreadable one, or the
  // host's own busy refusal. An idle list stops if idle.
  const stop =
    busy || verdict.kind === "unknown"
      ? ("force" as const)
      : ("if-idle" as const);

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
              setRefusal(result.message);
              if (result.reason === "host-busy") {
                setForceNext(true);
                status.recheck();
              }
              return;
            case "failed":
              setRefusal(result.message);
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
              busy: facts.kind === "busy",
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
