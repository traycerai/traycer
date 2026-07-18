import { useCallback } from "react";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ModelOption } from "@/components/home/data/landing-options";
import { useTabProvidersList } from "@/hooks/providers/use-tab-providers-list-query";
import { useRateLimitSwitchPromptDismissalsStore } from "@/stores/rate-limits/rate-limit-switch-prompt-dismissals-store";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import {
  effectiveProfileRateLimitSeverity,
  matchingRateLimitScopes,
  rateLimitSeverityTier,
  type ProfileRateLimitSeverity,
} from "@/lib/rate-limits/rate-limit-scope-match";
import { providerIdForHarness } from "./use-provider-reauth-gate";

export type { ProfileRateLimitSeverity };

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
  /** Model families named by the limits behind this warning, for copy like
   * "running low on Fable usage". Empty when any triggering limit is shared
   * (or per-scope data is unavailable) - the warning is then profile-wide and
   * the generic copy applies. */
  readonly limitedFamilies: ReadonlyArray<string>;
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
  readonly limitedFamilies: ReadonlyArray<string>;
  readonly current: ProviderProfile;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly destinations: ReadonlyArray<ProfileRateLimitDestination>;
  readonly primaryTarget: ProfileRateLimitDestination | null;
}

const NO_PROFILES: ReadonlyArray<ProviderProfile> = [];
const NO_FAMILIES: ReadonlyArray<string> = [];
function noop(): void {}

function hiddenPrompt(): HiddenProfileRateLimitPrompt {
  return { kind: "hidden", dismiss: noop };
}

function findLimitedProfile(
  profiles: ReadonlyArray<ProviderProfile>,
  profileId: string | null,
  selectedModel: ModelOption | null,
): {
  readonly current: ProviderProfile;
  readonly severity: ProfileRateLimitSeverity;
} | null {
  if (profiles.length < 2) return null;
  const current = profiles.find(
    (profile) => profileCommitId(profile) === profileId,
  );
  if (current === undefined) return null;
  const severity = effectiveProfileRateLimitSeverity(current, selectedModel);
  return severity === null ? null : { current, severity };
}

/**
 * A destination is worth suggesting only when, for the selected model, it
 * sits in a strictly better tier than the limited current profile (not
 * limited < near_limit < hard_limit) - same-or-worse is no escape. A
 * destination that is limited only on a family the selected model doesn't use
 * stays selectable; one with no data at all ("unknown") counts as not limited
 * rather than being greyed out on zero evidence.
 */
function selectableDestination(
  profile: ProviderProfile,
  selectedModel: ModelOption | null,
  currentSeverity: ProfileRateLimitSeverity,
): boolean {
  return (
    profile.auth.status === "authenticated" &&
    rateLimitSeverityTier(
      effectiveProfileRateLimitSeverity(profile, selectedModel),
    ) < rateLimitSeverityTier(currentSeverity)
  );
}

function destinationsForLimitedProfile(
  profiles: ReadonlyArray<ProviderProfile>,
  current: ProviderProfile,
  selectedModel: ModelOption | null,
  currentSeverity: ProfileRateLimitSeverity,
): ReadonlyArray<ProfileRateLimitDestination> {
  return profiles
    .filter((profile) => profile.profileId !== current.profileId)
    .map((profile) => ({
      profile,
      profileId: profileCommitId(profile),
      selectable: selectableDestination(
        profile,
        selectedModel,
        currentSeverity,
      ),
    }));
}

/** Non-null iff every scope behind the warning names a model family. */
function limitedFamiliesForCopy(
  current: ProviderProfile,
  selectedModel: ModelOption | null,
): ReadonlyArray<string> {
  const matching = matchingRateLimitScopes(current, selectedModel);
  if (matching === null || matching.length === 0) return NO_FAMILIES;
  const families = matching.map((scope) => scope.family);
  return families.every((family) => family !== null)
    ? [...new Set(families)]
    : NO_FAMILIES;
}

function warningProjection(input: {
  readonly harnessId: GuiHarnessId;
  readonly providerId: ProviderId | null;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly profileId: string | null;
  readonly selectedModel: ModelOption | null;
}): ProfileRateLimitWarningProjection | null {
  if (input.providerId === null) return null;
  const limited = findLimitedProfile(
    input.profiles,
    input.profileId,
    input.selectedModel,
  );
  if (limited === null) return null;
  const destinations = destinationsForLimitedProfile(
    input.profiles,
    limited.current,
    input.selectedModel,
    limited.severity,
  );
  const primaryTarget =
    destinations.find((destination) => destination.selectable) ?? null;
  const matchingScopes = matchingRateLimitScopes(
    limited.current,
    input.selectedModel,
  );
  return {
    warningKey: JSON.stringify([
      input.harnessId,
      limited.current.profileId,
      limited.severity,
      // Scope identity: dismissing a "Fable is running low" warning must not
      // suppress a later shared-window warning (and vice versa), and moving
      // the composer to a model gated by different scopes re-evaluates the
      // dismissal. `null` = no per-scope data (profile-level fallback).
      matchingScopes === null
        ? null
        : matchingScopes.map((scope) => scope.family).toSorted(),
      destinations
        .filter((destination) => destination.selectable)
        .map((destination) => destination.profile.profileId)
        .toSorted(),
    ]),
    providerId: input.providerId,
    severity: limited.severity,
    limitedFamilies: limitedFamiliesForCopy(
      limited.current,
      input.selectedModel,
    ),
    current: limited.current,
    profiles: input.profiles,
    destinations,
    primaryTarget,
  };
}

/**
 * Composer-facing rate-limit warning projection. Its eligibility comes only
 * from the subscribed tab-host `providers.list` snapshot; detailed usage is a
 * separate, cache-only presentation concern in the banner. Eligibility is
 * scoped to the composer's selected model: a limit that only gates another
 * model family (per `rateLimitLimitedScopes`) neither shows the warning nor
 * disqualifies a destination. When per-scope data is unavailable (old host,
 * never-read gauge, unresolved model) it falls back to the profile-level
 * enum - every uncertain path shows the warning rather than hiding a real
 * one. The visible state deliberately remains representable with no
 * selectable alternative so the user can inspect profile limits instead of
 * losing the warning entirely.
 */
export function useProfileRateLimitSwitchPrompt(
  harnessId: GuiHarnessId,
  profileId: string | null,
  selectedModel: ModelOption | null,
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
    selectedModel,
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
