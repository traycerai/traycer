import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import type {
  LocalHostUnresponsive,
  LocalHostUnresponsiveOffer,
} from "@traycer-clients/shared/platform/runner-host";
import { ActionToastContent } from "@/components/layout/bridges/action-toast-content";
import { useRunnerForceRestartUnresponsiveHost } from "@/hooks/runner/use-runner-force-restart-unresponsive-host-mutation";
import { useRunnerHost } from "@/providers/use-runner-host";

const HOST_UNRESPONSIVE_TOAST_ID = "host-unresponsive";
const HOST_UNRESPONSIVE_TITLE = "Host is not responding. Force restart?";
const HOST_UNRESPONSIVE_NOTICE_TITLE = "Host is not responding.";

// The shell reports the outage once, when it passes the busy window, and the
// offer stays up for as long as the outage lasts - so the duration it carries
// is a lower bound, not a running count.
function unansweredFor(state: LocalHostUnresponsive): string {
  const minutes = Math.floor(state.unreachableForMs / 60_000);
  return `It has not answered for at least ${minutes} min.`;
}

/**
 * Offers the person a force restart once the shell reports this machine's
 * host alive but not answering past its busy window, and withdraws the offer
 * when the host answers again or goes away.
 *
 * The shell kills nothing on that verdict - a host that is merely busy must
 * not be restarted from under its work - so this offer is the only way the
 * verdict turns into a restart. It names the offer it was made from, so a host
 * that answered again or was replaced since is not restarted.
 */
export function HostUnresponsivePrompt() {
  const runnerHost = useRunnerHost();
  // `mutate` is stable across renders, so the subscription below is not torn
  // down (dismissing an open offer) each time the mutation's state changes.
  const { mutate: restartHost } = useRunnerForceRestartUnresponsiveHost();
  const forceRestart = useCallback(
    (offer: LocalHostUnresponsiveOffer) => {
      restartHost(offer);
    },
    [restartHost],
  );

  useEffect(() => {
    const subscription = runnerHost.onLocalHostUnresponsive((state) => {
      if (state === null) {
        toast.dismiss(HOST_UNRESPONSIVE_TOAST_ID);
        return;
      }
      // No offer: the shell could not hold a restart to this host (it
      // published no start identity), so the person is told and offered
      // nothing.
      const { offerId } = state;
      if (offerId === null) {
        toast(HOST_UNRESPONSIVE_NOTICE_TITLE, {
          id: HOST_UNRESPONSIVE_TOAST_ID,
          description: unansweredFor(state),
          duration: Infinity,
        });
        return;
      }
      toast(
        <ActionToastContent
          toastId={HOST_UNRESPONSIVE_TOAST_ID}
          eyebrow={null}
          title={HOST_UNRESPONSIVE_TITLE}
          description={`${unansweredFor(state)} A force restart ends any work in progress on it.`}
          actionLabel="Force restart"
          onAction={() => {
            forceRestart({ pid: state.pid, offerId });
          }}
          onLater={null}
        />,
        {
          id: HOST_UNRESPONSIVE_TOAST_ID,
          description: null,
          duration: Infinity,
          cancel: null,
        },
      );
    });
    return () => {
      subscription.dispose();
      toast.dismiss(HOST_UNRESPONSIVE_TOAST_ID);
    };
  }, [forceRestart, runnerHost]);

  return null;
}
