import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
  type AnalyticsSource,
} from "@/lib/analytics";

/**
 * Binds update download outcomes to THIS window's user-initiated download.
 *
 * Update snapshots are broadcast to every window and replayed to late
 * subscribers, so emitting `update_download_succeeded` / `update_failed` from
 * snapshot processing double-counts (a second window replays the same
 * `ready`). Instead, the download gestures arm a single window-local flow
 * flag, and the first terminal snapshot after it settles the flow exactly
 * once. A download that outlives this renderer loses its outcome event -
 * accepted best-effort.
 */
let userDownloadInFlight = false;

export function trackUpdateDownloadStarted(source: AnalyticsSource): void {
  userDownloadInFlight = true;
  Analytics.getInstance().track(AnalyticsEvent.UpdateDownloadStarted, {
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
