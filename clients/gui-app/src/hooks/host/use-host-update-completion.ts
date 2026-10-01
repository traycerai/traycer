import { useEffect } from "react";
import type { FleetUpdateView } from "@/lib/host/fleet-update/fleet-update-view";
import {
  HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS,
  useHostUpdateBannerStore,
} from "@/stores/settings/host-update-banner-store";

export interface HostUpdateCompletion {
  readonly dismissed: boolean;
  readonly dismiss: (() => void) | null;
}

/**
 * Dismiss terminal update notices in host Settings, and auto-collapse the
 * successful ones.
 *
 * The Overview calls this once, at PANEL level, and hands the answer to its
 * update card. The card unmounts whenever the view goes quiet or the host goes
 * offline, so a timer that lived in it would restart each time it came back.
 *
 * A failure is dismissible too, by the person and never by the timer. The
 * record it describes is retained on the host for days and, until something
 * supersedes it, this card would otherwise sit red on the one page a person
 * opens to act on the host. Dismissing hides the card and nothing else: the
 * record stays on disk, the Doctor card on the same page still reports it,
 * and the dismissal is keyed by attempt id, so the next failure on the same
 * host arrives undismissed. The landing banner writes the same list, so a
 * failure dismissed on either surface is dismissed on both.
 */
export function useHostUpdateCompletion(
  view: FleetUpdateView,
): HostUpdateCompletion {
  const completionKind =
    view.kind === "unknown" ? view.lastKnownKind : view.kind;
  const autoCollapses =
    completionKind === "complete" || completionKind === "finalizing-record";
  const attemptId =
    autoCollapses || completionKind === "failed" ? view.attemptId : null;
  const dismissed = useHostUpdateBannerStore(
    (state) =>
      attemptId !== null &&
      state.landingDismissedAttemptIds.includes(attemptId),
  );
  const dismissAttempt = useHostUpdateBannerStore(
    (state) => state.dismissLandingAttempt,
  );

  useEffect(() => {
    if (attemptId === null || dismissed || !autoCollapses) return;
    const timer = setTimeout(() => {
      dismissAttempt(attemptId);
    }, HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [attemptId, dismissed, autoCollapses, dismissAttempt]);

  return {
    dismissed,
    dismiss:
      attemptId === null
        ? null
        : () => {
            dismissAttempt(attemptId);
          },
  };
}
