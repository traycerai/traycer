import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { hostLifecycleViewQueryOptions } from "@/hooks/runner/use-runner-host-lifecycle-query";
import {
  hostLifecycleModeSetAnalyticsFor,
  type HostLifecycleModeSetAnalytics,
} from "@/lib/host/host-lifecycle-mode-set-analytics";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/** One lock for the whole app origin: its holder reports CLI writes. */
const CLI_REPORTER_LOCK = "traycer:host-lifecycle-cli-reporter";

/**
 * Reports `host_lifecycle_mode_set` from main's lifecycle push, in every
 * window (see `HostLifecycleModeSetAnalytics`). Mounted once at the root
 * beside `HostQuitDecisionBridge`, on every route, so a change is seen
 * whatever surface is open.
 *
 * Every subscription here is external sync: main's change push, the quit
 * round-trip's cancellation, and the cross-window leader lock.
 */
export function HostLifecycleAnalyticsBridge(): ReactNode {
  const runnerHost = useRunnerHostOrNull();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (runnerHost === null) return;
    const hostLifecycle = runnerHost.hostLifecycle;
    if (hostLifecycle === null) return;
    const tracker = hostLifecycleModeSetAnalyticsFor(hostLifecycle);
    let disposed = false;
    const change = hostLifecycle.onChange((view) => {
      tracker.observe(view);
    });
    // The baseline a first push is compared against. A push that lands first
    // wins (`seed` keeps it).
    void queryClient.fetchQuery(hostLifecycleViewQueryOptions(runnerHost)).then(
      (view) => {
        if (!disposed) tracker.seed(view);
      },
      () => undefined,
    );
    const quit = hostLifecycle.quit;
    const quitState =
      quit === null
        ? null
        : quit.onQuitState((event) => {
            // A cancelled quit applies nothing it was answered with.
            if (event.phase === "cancelled") tracker.withdraw("quit-modal");
          });
    const leadership = holdCliReporterLock(tracker);
    return () => {
      disposed = true;
      change.dispose();
      if (quitState !== null) quitState.dispose();
      leadership.release();
    };
  }, [runnerHost, queryClient]);

  return null;
}

interface Leadership {
  readonly release: () => void;
}

/**
 * Queue for the app-wide reporter lock and hold it until released. The app
 * origin is a privileged secure scheme, so Web Locks span its windows; a
 * shell without them (tests, a plain browser tab) is its own leader.
 */
function holdCliReporterLock(
  tracker: HostLifecycleModeSetAnalytics,
): Leadership {
  const navigatorWithLocks: { readonly locks?: LockManager } = navigator;
  const locks = navigatorWithLocks.locks;
  if (locks === undefined) {
    tracker.setLeader(true);
    return { release: () => tracker.setLeader(false) };
  }
  const abort = new AbortController();
  let releaseHold: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releaseHold = () => {
      resolve();
    };
  });
  void locks
    .request(CLI_REPORTER_LOCK, { signal: abort.signal }, () => {
      tracker.setLeader(true);
      return held;
    })
    .catch(() => undefined);
  return {
    release: () => {
      tracker.setLeader(false);
      // Still queued: leave the queue. Granted: let the next window have it.
      abort.abort();
      releaseHold();
    },
  };
}
