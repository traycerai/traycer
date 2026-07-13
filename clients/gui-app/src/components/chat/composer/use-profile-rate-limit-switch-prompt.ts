import { useCallback } from "react";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useTabProvidersList } from "@/hooks/providers/use-tab-providers-list-query";
import { useRateLimitSwitchPromptDismissalsStore } from "@/stores/rate-limits/rate-limit-switch-prompt-dismissals-store";
import {
  profileCommitId,
  profileDisplayLabel,
} from "@/components/providers/provider-profile-model";
import { providerIdForHarness } from "./use-provider-reauth-gate";

function isLimited(profile: ProviderProfile): boolean {
  return (
    profile.rateLimitStatus === "near_limit" ||
    profile.rateLimitStatus === "hard_limit"
  );
}

export interface ProfileRateLimitProfileChip {
  /** Normalized for `onSwitchProfile`/composer-selection semantics - `null`
   *  for the ambient profile. */
  readonly profileId: string | null;
  /** The raw, always-present `ProviderProfile.profileId` (never `null` even
   *  for ambient) - the stable key `AccentDot`'s hash fallback needs. */
  readonly accentDotId: string;
  readonly label: string;
  readonly accentColor: string | null;
}

export type ProfileRateLimitAlternative = ProfileRateLimitProfileChip;

export interface ProfileRateLimitSwitchPrompt {
  /** True only when the composer's OWN committed profile is near/at its limit,
   *  at least one authenticated non-limited alternative exists, and the user
   *  has not dismissed this exact warning. */
  readonly limited: boolean;
  readonly hardLimited: boolean;
  /** The limited profile the banner switches away from. Remains populated
   *  after dismissal while the underlying rate-limit condition still holds. */
  readonly current: ProfileRateLimitProfileChip | null;
  readonly alternatives: ReadonlyArray<ProfileRateLimitAlternative>;
  /** Hides this exact warning in EVERY composer for the rest of the app
   *  session (shared dismissal store, not per-composer state). A change in
   *  source profile, severity, or viable alternatives creates a new warning. */
  readonly dismiss: () => void;
}

const NO_ALTERNATIVES: ReadonlyArray<ProfileRateLimitAlternative> = [];
const NO_PROFILES: ReadonlyArray<ProviderProfile> = [];

function noop(): void {}

/**
 * Composer-facing rate-limit signal for the mid-chat "Continue on <profile>"
 * switch prompt (multi-profile decision log's "Rate-limit moment"). Derives
 * everything from the SAME `providers.list` read the reauth gate already
 * queries (dedupes via the query cache - no new host RPC), reading the
 * per-profile `rateLimitStatus` the host derives from its passive-capture
 * gauge cache. Never switches automatically - this is a read-only signal the
 * banner turns into a user-confirmed action.
 */
export function useProfileRateLimitSwitchPrompt(
  harnessId: GuiHarnessId,
  profileId: string | null,
  active: boolean,
): ProfileRateLimitSwitchPrompt {
  const dismissPromptKey = useRateLimitSwitchPromptDismissalsStore(
    (state) => state.dismiss,
  );
  const providerId = providerIdForHarness(harnessId);
  const enabled = active && providerId !== null;
  const query = useTabProvidersList({ enabled, subscribed: enabled });

  const profiles =
    query.data?.providers.find((p) => p.providerId === providerId)?.profiles ??
    NO_PROFILES;
  const current =
    profiles.length < 2
      ? undefined
      : profiles.find((profile) => profileCommitId(profile) === profileId);
  const currentChip: ProfileRateLimitProfileChip | null =
    current !== undefined && isLimited(current)
      ? {
          profileId: profileCommitId(current),
          accentDotId: current.profileId,
          label: profileDisplayLabel(current),
          accentColor: current.accentColor,
        }
      : null;
  const alternatives =
    currentChip === null
      ? NO_ALTERNATIVES
      : profiles
          .filter(
            (profile) =>
              profileCommitId(profile) !== profileId &&
              profile.auth.status === "authenticated" &&
              !isLimited(profile),
          )
          .map((profile) => ({
            profileId: profileCommitId(profile),
            accentDotId: profile.profileId,
            label: profileDisplayLabel(profile),
            accentColor: profile.accentColor,
          }));
  const hardLimited = current?.rateLimitStatus === "hard_limit";
  const promptKey =
    currentChip === null
      ? null
      : JSON.stringify([
          harnessId,
          currentChip.accentDotId,
          hardLimited,
          alternatives.map((alternative) => alternative.accentDotId).sort(),
        ]);
  // Subscribes to this exact key's dismissed bit (a boolean, so a dismissal
  // of an unrelated prompt key never re-renders this composer).
  const dismissed = useRateLimitSwitchPromptDismissalsStore(
    (state) => promptKey !== null && state.dismissedKeys.has(promptKey),
  );
  const dismiss = useCallback((): void => {
    if (promptKey !== null) dismissPromptKey(promptKey);
  }, [dismissPromptKey, promptKey]);

  if (currentChip === null || promptKey === null) {
    return {
      limited: false,
      hardLimited: false,
      current: null,
      alternatives: NO_ALTERNATIVES,
      dismiss: noop,
    };
  }

  return {
    limited: alternatives.length > 0 && !dismissed,
    hardLimited,
    current: currentChip,
    alternatives,
    dismiss,
  };
}
