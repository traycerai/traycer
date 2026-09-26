import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { HostBusyBreakdownV2 } from "@traycer/protocol/host/status/index";
import type {
  HostQuitDecision,
  HostQuitDecisionRequest,
} from "@traycer-clients/shared/platform/runner-host";
import {
  HostQuitDialogView,
  type HostQuitDialogAction,
} from "@/components/host/host-quit-dialog-view";
import {
  useLocalHostQuitStatus,
  type LocalHostQuitStatus,
} from "@/components/host/use-local-host-quit-status";
import { useRunnerHostQuitRespondMutation } from "@/hooks/runner/use-runner-host-quit-respond-mutation";
import { useHostBinding } from "@/lib/host";
import {
  automaticHostQuitDecision,
  describeHostQuitPrompt,
  hostQuitPromptVisible,
} from "@/components/host/host-quit-prompt-model";
import {
  HOST_QUIT_DESCRIPTION_STOPPING,
  HOST_QUIT_HOST_CHANGED_DESCRIPTION,
  HOST_QUIT_HOST_CHANGED_TITLE,
  HOST_QUIT_KEEP_LABEL,
  HOST_QUIT_STOP_LABEL,
  HOST_QUIT_TITLE_STOPPING,
  hostQuitStoppingLine,
} from "@/lib/host/host-lifecycle-copy";

export interface HostQuitDialogProps {
  readonly request: HostQuitDecisionRequest;
  /** Main reported `stopping` for this request. */
  readonly stopping: boolean;
  /**
   * The stop main reported is idle-only (`--if-idle`): it ends no work, so
   * the progress names none. Meaningful only while `stopping`.
   */
  readonly idleOnly: boolean;
  /** The Remember checkbox, carried across a busy-retry round of one quit. */
  readonly remember: boolean;
  readonly onRememberChange: (remember: boolean) => void;
  /** The answer reached main and needs no more UI (Keep, Cancel). */
  readonly onDone: () => void;
}

/**
 * The host quit modal: main holds a quit open and asks this window what to do
 * with this machine's host.
 *
 * Split on the host-runtime binding, as `LocalHostRestartFlow` is:
 * `useHostClientForHostId` throws without one, and the quit prompt must never
 * be the thing that crashes the root. Unbound, the host cannot be asked
 * anything, so the modal says it can't tell.
 */
export function HostQuitDialog(props: HostQuitDialogProps): ReactNode {
  const binding = useHostBinding();
  if (binding === null) {
    return <HostQuitPrompt {...props} status={UNBOUND_STATUS} />;
  }
  return <BoundHostQuitDialog {...props} />;
}

function BoundHostQuitDialog(props: HostQuitDialogProps): ReactNode {
  const status = useLocalHostQuitStatus(true);
  return <HostQuitPrompt {...props} status={status} />;
}

const UNBOUND_STATUS: LocalHostQuitStatus = {
  localHostId: null,
  verdict: { kind: "unknown", reason: "no-connection" },
  liveLocalHostIdNow: () => null,
  recheck: () => undefined,
};

function HostQuitPrompt(
  props: HostQuitDialogProps & { readonly status: LocalHostQuitStatus },
): ReactNode {
  const { request, status } = props;
  const respond = useRunnerHostQuitRespondMutation();
  const [pendingAction, setPendingAction] =
    useState<HostQuitDialogAction | null>(null);
  // Set once Stop reached main: the modal shows progress from then on, with
  // the list it showed when the person chose, until main reports the quit.
  const [answeredStop, setAnsweredStop] = useState<{
    readonly breakdown: HostBusyBreakdownV2 | null;
  } | null>(null);
  const model = describeHostQuitPrompt(
    request,
    status.verdict,
    status.localHostId,
  );
  const automatic = automaticHostQuitDecision(request, status.verdict);

  // An automatic answer is sent exactly once per request, from an effect:
  // it answers main (an external system), and the verdict it depends on only
  // exists after the host has been asked.
  const automaticSentRef = useRef(false);
  const respondMutate = respond.mutate;
  useEffect(() => {
    if (automatic === null || automaticSentRef.current) return;
    automaticSentRef.current = true;
    respondMutate(
      {
        response: { requestId: request.requestId, decision: automatic },
        analytics: null,
      },
      {
        onSuccess: () => {
          if (automatic.kind === "stop") {
            setAnsweredStop({ breakdown: null });
          }
        },
      },
    );
  }, [automatic, request.requestId, respondMutate]);

  const answer = (decision: HostQuitDecision): void => {
    if (decision.kind !== "cancel") {
      // Re-read the LIVE local host at click time: a host replaced under an
      // open list must not have its replacement kept or stopped on the old
      // one's evidence.
      const liveHostId = status.liveLocalHostIdNow();
      if (
        liveHostId !== null &&
        status.localHostId !== null &&
        liveHostId !== status.localHostId
      ) {
        toast.info(HOST_QUIT_HOST_CHANGED_TITLE, {
          description: HOST_QUIT_HOST_CHANGED_DESCRIPTION,
        });
        status.recheck();
        return;
      }
    }
    setPendingAction(decision.kind);
    const displayedBreakdown = model.breakdown;
    respond.mutate(
      {
        response: { requestId: request.requestId, decision },
        analytics: { mode: request.mode, verdict: model.analyticsVerdict },
      },
      {
        onSuccess: () => {
          setPendingAction(null);
          if (decision.kind === "stop") {
            setAnsweredStop({ breakdown: displayedBreakdown });
            return;
          }
          props.onDone();
        },
        onError: () => {
          setPendingAction(null);
        },
      },
    );
  };

  const stopping = props.stopping || answeredStop !== null;
  if (stopping) {
    // Main's word on the running stop wins: an idle-only stop ends nothing,
    // whatever the live list has turned to since.
    const displayed =
      answeredStop === null ? model.breakdown : answeredStop.breakdown;
    const endingBreakdown = props.stopping && props.idleOnly ? null : displayed;
    return (
      <HostQuitDialogView
        open
        stateKind="stopping"
        title={HOST_QUIT_TITLE_STOPPING}
        description={HOST_QUIT_DESCRIPTION_STOPPING}
        detail={null}
        countsLine={null}
        sessionsHostId={null}
        stoppingLine={hostQuitStoppingLine(endingBreakdown)}
        remember={null}
        keepLabel={HOST_QUIT_KEEP_LABEL}
        stopLabel={model.stopLabel}
        stopDisabled
        pendingAction={null}
        onKeep={() => undefined}
        onStop={() => undefined}
        onCancel={() => undefined}
        onNavigate={() => undefined}
      />
    );
  }

  return (
    <HostQuitDialogView
      open={
        automatic === null && hostQuitPromptVisible(request, status.verdict)
      }
      stateKind={model.stateKind}
      title={model.title}
      description={model.description}
      detail={model.detail}
      countsLine={model.countsLine}
      sessionsHostId={model.sessionsHostId}
      stoppingLine={null}
      remember={{ checked: props.remember, onChange: props.onRememberChange }}
      keepLabel={HOST_QUIT_KEEP_LABEL}
      stopLabel={model.stopLabel}
      stopDisabled={model.stopDisabled}
      pendingAction={pendingAction}
      onKeep={() => answer({ kind: "keep", remember: props.remember })}
      onStop={() =>
        answer({
          kind: "stop",
          force: model.stopForce,
          remember: props.remember,
        })
      }
      onCancel={() => answer({ kind: "cancel" })}
      onNavigate={() => answer({ kind: "cancel" })}
    />
  );
}

/**
 * Progress for a stop no prompt preceded - Linked mode, or Stop-if-idle's
 * automatic attempt - which main announces with `requestId: null`. Names the
 * work being ended when this machine's host can still say, and only when the
 * stop can end work: Stop-if-idle's idle-only attempt is refused rather than
 * end anything, so naming the host's work there would announce an ending
 * that does not happen.
 */
export function HostQuitStoppingDialog(props: {
  readonly idleOnly: boolean;
}): ReactNode {
  const binding = useHostBinding();
  if (props.idleOnly || binding === null) {
    return <StoppingOnly breakdown={null} />;
  }
  return <BoundHostQuitStoppingDialog />;
}

function BoundHostQuitStoppingDialog(): ReactNode {
  const status = useLocalHostQuitStatus(true);
  const breakdown =
    status.verdict.kind === "busy" ? status.verdict.breakdown : null;
  return <StoppingOnly breakdown={breakdown} />;
}

function StoppingOnly(props: {
  readonly breakdown: HostBusyBreakdownV2 | null;
}): ReactNode {
  return (
    <HostQuitDialogView
      open
      stateKind="stopping"
      title={HOST_QUIT_TITLE_STOPPING}
      description={HOST_QUIT_DESCRIPTION_STOPPING}
      detail={null}
      countsLine={null}
      sessionsHostId={null}
      stoppingLine={hostQuitStoppingLine(props.breakdown)}
      remember={null}
      keepLabel={null}
      stopLabel={HOST_QUIT_STOP_LABEL}
      stopDisabled
      pendingAction={null}
      onKeep={() => undefined}
      onStop={() => undefined}
      onCancel={() => undefined}
      onNavigate={() => undefined}
    />
  );
}
