import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
  type AnalyticsSource,
} from "@/lib/analytics";

/** Binds update download outcomes to THIS window's user-initiated download. */
let userDownloadInFlight = false;

export function trackUpdateDownloadStarted(source: AnalyticsSource): void {
  userDownloadInFlight = true;
  Analytics.getInstance().track(AnalyticsEvent.UpdateDownloadStarted, {
    source,
  });
}

/**
 * The restart gestures ("Restart" on the ready toast, the header tick) install immediately - there is no confirmation step in between, so the gesture itself is the tracked intent.
 */
export function trackUpdateRestartRequested(source: AnalyticsSource): void {
  Analytics.getInstance().track(AnalyticsEvent.UpdateRestartRequested, {
    source,
  });
}

export function settleUpdateDownloadOutcome(
  status: "error" | "ready",
  errorMessage: string | null,
): void {
  if (!userDownloadInFlight) return;
  userDownloadInFlight = false;
  if (status === "ready") {
    Analytics.getInstance().track(AnalyticsEvent.UpdateDownloadSucceeded, null);
    return;
  }
  Analytics.getInstance().track(AnalyticsEvent.UpdateFailed, {
    blocker: analyticsBlockerFromError(errorMessage),
  });
}

/** Test-only: resets the window-local in-flight flag between tests. */
export function __resetAppUpdateAnalyticsForTests(): void {
  userDownloadInFlight = false;
}
