import { useEffect, useState, type ReactNode } from "react";
import type { HostQuitDecisionRequest } from "@traycer-clients/shared/platform/runner-host";
import {
  HostQuitDialog,
  HostQuitStoppingDialog,
} from "@/components/host/host-quit-dialog";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

interface ActiveQuitRequest {
  readonly request: HostQuitDecisionRequest;
  /** Main reported `stopping` for this request. */
  readonly stopping: boolean;
  /** That stop is idle-only: it ends no work, so none is named. */
  readonly idleOnly: boolean;
}

/** A stop no prompt preceded is running. */
interface UnpromptedStopping {
  readonly idleOnly: boolean;
}

/**
 * Answers desktop main's host quit questions in this window.
 *
 * Mounted at the root route beside `DesktopDialogHost`, outside
 * `HostReadyGate`, so it is live on EVERY route - signed out, onboarding, a
 * readiness gate, Settings - and the subscription itself is what tells main
 * this window can answer (the preload reports readiness on the first
 * subscriber). A window that never subscribed gets main's native prompt.
 *
 * Both handlers only set state, so neither can throw: a handler that threw
 * would skip the preload's servicing ack, and main would ask natively.
 *
 * Main sends a request to the most recent window only, and fans `stopping` /
 * `quitting` / `cancelled` out to every window. A phase naming a request this
 * window never received is ignored, except `requestId: null` - a stop no
 * prompt preceded (Linked, or Stop-if-idle's automatic attempt) - which every
 * window shows, because the person may be looking at any of them. Its
 * `idleOnly` says whether that stop can end work at all: Stop-if-idle's
 * attempt cannot, so its progress names none, busy host or not.
 */
export function HostQuitDecisionBridge(): ReactNode {
  const runnerHost = useRunnerHostOrNull();
  const quit =
    runnerHost === null || runnerHost.hostLifecycle === null
      ? null
      : runnerHost.hostLifecycle.quit;
  const [active, setActive] = useState<ActiveQuitRequest | null>(null);
  const [unpromptedStopping, setUnpromptedStopping] =
    useState<UnpromptedStopping | null>(null);
  // "Remember my choice" belongs to one quit: kept across its busy-retry
  // round, cleared on a quit's first ask - `initial`, or Stop-if-idle's
  // `busy` round, which nothing was shown before.
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (quit === null) return;
    const requests = quit.onQuitRequest((request) => {
      setActive({ request, stopping: false, idleOnly: false });
      setUnpromptedStopping(null);
      if (request.round !== "busy-retry") setRemember(false);
    });
    const states = quit.onQuitState((event) => {
      if (event.phase === "stopping") {
        if (event.requestId === null) {
          setUnpromptedStopping({ idleOnly: event.idleOnly });
          return;
        }
        setActive((current) =>
          current !== null && current.request.requestId === event.requestId
            ? {
                request: current.request,
                stopping: true,
                idleOnly: event.idleOnly,
              }
            : current,
        );
        return;
      }
      // `quitting` and `cancelled` end the whole transaction.
      setActive(null);
      setUnpromptedStopping(null);
    });
    return () => {
      requests.dispose();
      states.dispose();
    };
  }, [quit]);

  if (active !== null) {
    return (
      <HostQuitDialog
        key={active.request.requestId}
        request={active.request}
        stopping={active.stopping}
        idleOnly={active.idleOnly}
        remember={remember}
        onRememberChange={setRemember}
        onDone={() => {
          setActive(null);
        }}
      />
    );
  }
  if (unpromptedStopping !== null) {
    return <HostQuitStoppingDialog idleOnly={unpromptedStopping.idleOnly} />;
  }
  return null;
}
