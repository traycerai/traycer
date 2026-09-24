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
 * Dismiss and auto-collapse successful update notices in host Settings.
 *
 * The Overview calls this once, at PANEL level, and hands the answer to both
 * readers: the Status tab's success card and the header's "Updated to vX"
 * pill. Status mounts only once visited, so a timer that lived in the card
 * would never start for someone who stayed on another tab, and the pill
 * would never leave.
 */
export function useHostUpdateCompletion(
  view: FleetUpdateView,
): HostUpdateCompletion {
  const completionKind =
    view.kind === "unknown" ? view.lastKnownKind : view.kind;
  const attemptId =
    completionKind === "complete" || completionKind === "finalizing-record"
      ? view.attemptId
      : null;
  const dismissed = useHostUpdateBannerStore(
    (state) =>
      attemptId !== null &&
      state.landingDismissedAttemptIds.includes(attemptId),
  );
  const dismissAttempt = useHostUpdateBannerStore(
    (state) => state.dismissLandingAttempt,
  );

  useEffect(() => {
    if (attemptId === null || dismissed) return;
    const timer = setTimeout(() => {
      dismissAttempt(attemptId);
    }, HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [attemptId, dismissed, dismissAttempt]);

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
