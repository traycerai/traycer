import type { QueryClient } from "@tanstack/react-query";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  isOutcomePromoted,
  isOutcomeSettled,
  profileCopyAttemptKey,
  profileCopyGuiProvider,
  type ProfileCopyOutcome,
  type ProfileCopyWireProvider,
} from "@/lib/profile-copy/profile-copy-model";
import { invalidateProfileCopyDestinationProviders } from "@/hooks/providers/profile-copy/profile-copy-cache";

// Window-lifetime memory: which attempts this renderer has already reported
// and refreshed for. Two surfaces watching one attempt (the operation view and
// an incoming draft) share it, so neither doubles the other. It is the signed-
// in account's, so `EpicSessionLifecycleBridge` clears it on sign-out and on a
// user switch.
const reportedSettled = new Set<string>();
const refreshedPromotions = new Set<string>();
const reportedStarts = new Set<string>();

/**
 * A start the source answered with at least one attempt, reported once per
 * operation from the start hook's own `onSuccess`: the dialog that sent it may
 * have closed before the answer arrived, and a "Start again" that rejoins a
 * start already reported here is not counted twice. Enum-only: the operation
 * id keys the memory and never reaches the event.
 */
export function reportProfileCopyStarted(input: {
  readonly operationId: string;
  readonly providerId: ProfileCopyWireProvider;
  readonly sourceProfileId: string;
  readonly startedCount: number;
}): void {
  if (reportedStarts.has(input.operationId)) return;
  reportedStarts.add(input.operationId);
  Analytics.getInstance().track(AnalyticsEvent.ProfileCopyStarted, {
    provider: profileCopyGuiProvider(input.providerId),
    source_kind: input.sourceProfileId === "ambient" ? "ambient" : "managed",
    destination_count: input.startedCount,
  });
}

/**
 * What a surface does the FIRST time it sees an outcome:
 *
 * - a promotion refreshes the DESTINATION's provider surfaces (the source's
 *   `status` can report `signed-in` before anything read the destination);
 * - a settled attempt is reported once, as wire enums only - provider, state,
 *   reason - never a label, host id, operation id or account detail.
 */
export function observeProfileCopyOutcome(
  queryClient: QueryClient,
  outcome: ProfileCopyOutcome,
): void {
  const key = profileCopyAttemptKey(outcome.attempt);
  if (isOutcomePromoted(outcome) && !refreshedPromotions.has(key)) {
    refreshedPromotions.add(key);
    invalidateProfileCopyDestinationProviders(
      queryClient,
      outcome.attempt.destinationHostId,
    );
  }
  if (isOutcomeSettled(outcome) && !reportedSettled.has(key)) {
    reportedSettled.add(key);
    Analytics.getInstance().track(AnalyticsEvent.ProfileCopyAttemptSettled, {
      provider: profileCopyGuiProvider(outcome.attempt.providerId),
      state: outcome.state,
      reason: outcome.reason ?? "none",
    });
  }
}

/** Forgets what this window observed: an identity teardown, or a test. */
export function clearProfileCopyObservations(): void {
  reportedSettled.clear();
  refreshedPromotions.clear();
  reportedStarts.clear();
}
