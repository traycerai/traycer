import { useCallback } from "react";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useTabProvidersList } from "@/hooks/providers/use-tab-providers-list-query";
import { useRateLimitSwitchPromptDismissalsStore } from "@/stores/rate-limits/rate-limit-switch-prompt-dismissals-store";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { providerIdForHarness } from "./use-provider-reauth-gate";

export type ProfileRateLimitSeverity = "near_limit" | "hard_limit";

export interface ProfileRateLimitDestination {
  readonly profile: ProviderProfile;
  /** Normalized for composer-selection semantics: `null` is the ambient
   * profile even though its wire id is the literal ambient sentinel. */
  readonly profileId: string | null;
  readonly selectable: boolean;
}

interface HiddenProfileRateLimitPrompt {
  readonly kind: "hidden";
  readonly dismiss: () => void;
}

interface VisibleProfileRateLimitPrompt {
  readonly kind: "visible";
  readonly warningKey: string;
  readonly providerId: ProviderId;
  readonly severity: ProfileRateLimitSeverity;
  readonly current: ProviderProfile;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  /** Every other provider profile in the host's stable order. Rows that
   * are unavailable for switching stay here so the menu can explain why. */
  readonly destinations: ReadonlyArray<ProfileRateLimitDestination>;
  /** First selectable destination in provider order. Usage is never used
   * to rank this default action. */
  readonly primaryTarget: ProfileRateLimitDestination | null;
  readonly dismiss: () => void;
}

export type ProfileRateLimitSwitchPrompt =
  HiddenProfileRateLimitPrompt | VisibleProfileRateLimitPrompt;

interface ProfileRateLimitWarningProjection {
  readonly warningKey: string;
  readonly providerId: ProviderId;
  readonly severity: ProfileRateLimitSeverity;
  readonly current: ProviderProfile;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly destinations: ReadonlyArray<ProfileRateLimitDestination>;
  readonly primaryTarget: ProfileRateLimitDestination | null;
}

const NO_PROFILES: ReadonlyArray<ProviderProfile> = [];
function noop(): void {}

function rateLimitSeverity(
  profile: ProviderProfile,
): ProfileRateLimitSeverity | null {
  if (profile.rateLimitStatus === "near_limit") return "near_limit";
  if (profile.rateLimitStatus === "hard_limit") return "hard_limit";
  return null;
}

function hiddenPrompt(): HiddenProfileRateLimitPrompt {
  return { kind: "hidden", dismiss: noop };
}

function findLimitedProfile(
  profiles: ReadonlyArray<ProviderProfile>,
  profileId: string | null,
): {
  readonly current: ProviderProfile;
  readonly severity: ProfileRateLimitSeverity;
} | null {
  if (profiles.length < 2) return null;
  const current = profiles.find(
    (profile) => profileCommitId(profile) === profileId,
  );
  if (current === undefined) return null;
  const severity = rateLimitSeverity(current);
  return severity === null ? null : { current, severity };
}

function selectableDestination(profile: ProviderProfile): boolean {
  return (
    profile.auth.status === "authenticated" &&
    rateLimitSeverity(profile) === null
  );
}

function destinationsForLimitedProfile(
  profiles: ReadonlyArray<ProviderProfile>,
  current: ProviderProfile,
): ReadonlyArray<ProfileRateLimitDestination> {
  return profiles
    .filter((profile) => profile.profileId !== current.profileId)
    .map((profile) => ({
      profile,
      profileId: profileCommitId(profile),
      selectable: selectableDestination(profile),
    }));
}

function warningProjection(input: {
  readonly harnessId: GuiHarnessId;
  readonly providerId: ProviderId | null;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly profileId: string | null;
}): ProfileRateLimitWarningProjection | null {
  if (input.providerId === null) return null;
  const limited = findLimitedProfile(input.profiles, input.profileId);
  if (limited === null) return null;
  const destinations = destinationsForLimitedProfile(
    input.profiles,
    limited.current,
  );
  const primaryTarget =
    destinations.find((destination) => destination.selectable) ?? null;
  return {
    warningKey: JSON.stringify([
      input.harnessId,
      limited.current.profileId,
      limited.severity,
      destinations
        .filter((destination) => destination.selectable)
        .map((destination) => destination.profile.profileId)
        .toSorted(),
    ]),
    providerId: input.providerId,
    severity: limited.severity,
    current: limited.current,
    profiles: input.profiles,
    destinations,
    primaryTarget,
  };
}

/**
 * Composer-facing rate-limit warning projection. Its eligibility comes only
 * from the subscribed tab-host `providers.list` snapshot; detailed usage is a
 * separate, cache-only presentation concern in the banner. The visible state
 * deliberately remains representable with no selectable alternative so the
 * user can inspect profile limits instead of losing the warning entirely.
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
  const profiles: ReadonlyArray<ProviderProfile> =
    query.data?.providers.find((provider) => provider.providerId === providerId)
      ?.profiles ?? NO_PROFILES;
  const projection = warningProjection({
    harnessId,
    providerId,
    profiles,
    profileId,
  });
  const dismissed = useRateLimitSwitchPromptDismissalsStore(
    (state) =>
      projection !== null && state.dismissedKeys.has(projection.warningKey),
  );
  const dismiss = useCallback((): void => {
    if (projection !== null) dismissPromptKey(projection.warningKey);
  }, [dismissPromptKey, projection]);

  if (projection === null || dismissed) return hiddenPrompt();

  return {
    kind: "visible",
    ...projection,
    dismiss,
  };
}
