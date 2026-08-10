import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ModelOption } from "@/components/home/data/landing-options";
import { type HostRpcRegistry } from "@/lib/host";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useRateLimitSwitchPromptDismissalsStore } from "@/stores/rate-limits/rate-limit-switch-prompt-dismissals-store";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import {
  assessProfileRateLimit,
  effectiveProfileRateLimitSeverity,
  matchingRateLimitScopes,
  rateLimitSeverityTier,
  type ProfileRateLimitSeverity,
} from "@/lib/rate-limits/rate-limit-scope-match";
import { providerCliIdForHarness } from "@/lib/provider-ordering";

export type { ProfileRateLimitSeverity };

export interface ProfileRateLimitDestination {
  readonly profile: ProviderProfile;
  /** Normalized for composer-selection semantics: `null` is the ambient
   * profile even though its wire id is the literal ambient sentinel. */
  readonly profileId: string | null;
  /** Whether the user may deliberately choose this destination. An
   * authenticated profile with unknown usage remains selectable, but is never
   * promoted to `primaryTarget` until a rate-limit read proves it is better. */
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
  /** First proven-better destination in provider order. Unknown-usage
   * profiles may be selectable from the menu, but never become this confident
   * one-click recommendation. Usage is not used to rank eligible targets. */
  readonly primaryTarget: ProfileRateLimitDestination | null;
  /** Set only when `primaryTarget` is null: the first authenticated
   * destination with UNKNOWN rate-limit state, for the banner's single
   * automatic `ensureFresh` check. See `findProbeTarget`. */
  readonly probeTarget: ProfileRateLimitDestination | null;
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
  readonly probeTarget: ProfileRateLimitDestination | null;
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
 * A user may deliberately choose an authenticated destination unless it is
 * known to be no better for the selected model. Unknown (never read, stale,
 * or failed-probe gauge) is therefore a menu option, but remains incomparable
 * rather than weakly healthy; `recommendedDestination` separately prevents it
 * from powering the confident one-click switch. A destination limited only
 * on a family the selected model does not use stays selectable.
 */
function selectableDestination(
  profile: ProviderProfile,
  selectedModel: ModelOption | null,
  currentSeverity: ProfileRateLimitSeverity,
): boolean {
  const assessment = assessProfileRateLimit(profile, selectedModel);
  return (
    profile.auth.status === "authenticated" &&
    (!assessment.known ||
      rateLimitSeverityTier(assessment.severity) <
        rateLimitSeverityTier(currentSeverity))
  );
}

/** The stricter confidence gate for the banner's one-click recommendation. */
function recommendedDestination(
  destination: ProfileRateLimitDestination,
  selectedModel: ModelOption | null,
  currentSeverity: ProfileRateLimitSeverity,
): boolean {
  if (!destination.selectable) return false;
  const assessment = assessProfileRateLimit(destination.profile, selectedModel);
  return (
    assessment.known &&
    rateLimitSeverityTier(assessment.severity) <
      rateLimitSeverityTier(currentSeverity)
  );
}

/**
 * The one destination worth spending an automatic usage check on: the first
 * authenticated profile whose rate-limit state is unknown, and only when no
 * known strictly-better destination already exists. The banner fires a
 * single non-forced (`ensureFresh`) check for it; a successful reading
 * lands in the gauge and the next `providers.list` snapshot promotes it to
 * `primaryTarget` through the normal projection. Never a cascade - one
 * candidate, one attempt.
 */
function findProbeTarget(
  destinations: ReadonlyArray<ProfileRateLimitDestination>,
  selectedModel: ModelOption | null,
): ProfileRateLimitDestination | null {
  return (
    destinations.find(
      (destination) =>
        destination.profile.auth.status === "authenticated" &&
        !assessProfileRateLimit(destination.profile, selectedModel).known,
    ) ?? null
  );
}

/**
 * The banner's default menu preview target, before any hover/keyboard
 * preview overrides it. `profileId` is the commit id, which is `null` for
 * the ambient profile - a plain `??` chain on `.profileId` would treat a
 * legitimately-ambient primary/first-selectable target as absent and fall
 * through to the wrong destination. Each candidate is therefore null-checked
 * on the destination object itself, not its `profileId`.
 */
export function initialPreviewProfileId(
  primaryTarget: ProfileRateLimitDestination | null,
  current: ProviderProfile,
  destinations: ReadonlyArray<ProfileRateLimitDestination>,
): string | null {
  if (primaryTarget !== null) return primaryTarget.profileId;
  const firstSelectable = destinations.find(
    (destination) => destination.selectable,
  );
  return firstSelectable !== undefined
    ? firstSelectable.profileId
    : profileCommitId(current);
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

/**
 * Families named in the banner line - only the scopes AT the effective
 * severity (a hard-limit banner must not name a merely near-limit family),
 * and only when every scope behind the warning names a model family.
 */
function limitedFamiliesForCopy(
  current: ProviderProfile,
  selectedModel: ModelOption | null,
  severity: ProfileRateLimitSeverity,
): ReadonlyArray<string> {
  const matching = matchingRateLimitScopes(current, selectedModel);
  if (matching === null || matching.length === 0) return NO_FAMILIES;
  if (!matching.every((scope) => scope.family !== null)) return NO_FAMILIES;
  return [
    ...new Set(
      matching
        .filter((scope) => scope.severity === severity)
        .map((scope) => scope.family),
    ),
  ].filter((family): family is string => family !== null);
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
    destinations.find((destination) =>
      recommendedDestination(
        destination,
        input.selectedModel,
        limited.severity,
      ),
    ) ?? null;
  const probeTarget =
    primaryTarget === null
      ? findProbeTarget(destinations, input.selectedModel)
      : null;
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
      // suppress a later shared-window warning (and vice versa), moving the
      // composer to a model gated by different scopes re-evaluates the
      // dismissal, and each scope carries its severity so a hard limit moving
      // between the same families resurfaces too. `null` = no per-scope data
      // (profile-level fallback).
      matchingScopes === null
        ? null
        : matchingScopes
            .map((scope) => `${scope.family ?? ""}\u0000${scope.severity}`)
            .toSorted(),
      // Destination identity: each destination contributes {profileId,
      // recommended} rather than mere membership in the selectable set. A
      // probe that proves an unknown destination strictly better flips its
      // `recommended` flag false -> true, changing the key and re-arming the
      // dismissal - the banner just gained a confident one-click switch. A
      // probe that instead proves it known-but-not-better only drops the
      // destination out of the selectable set; `recommended` was false and
      // stays false, so the key is unchanged - no fresh warning episode, and
      // (because the composer keys the banner by this key) no remount to
      // re-arm the banner's single automatic probe onto the next unknown
      // profile. A destination that appears or disappears entirely still
      // changes the array and re-arms, as before.
      destinations
        .map(
          (destination) =>
            `${destination.profile.profileId}\u0000${
              recommendedDestination(
                destination,
                input.selectedModel,
                limited.severity,
              )
                ? "1"
                : "0"
            }`,
        )
        .toSorted(),
    ]),
    providerId: input.providerId,
    severity: limited.severity,
    limitedFamilies: limitedFamiliesForCopy(
      limited.current,
      input.selectedModel,
      limited.severity,
    ),
    current: limited.current,
    profiles: input.profiles,
    destinations,
    primaryTarget,
    probeTarget,
  };
}

/**
 * Composer-facing rate-limit warning projection. Its eligibility comes only
 * from the subscribed `providers.list` snapshot of `client`'s host; detailed
 * usage is a separate, cache-only presentation concern in the banner.
 * Eligibility is scoped to the composer's selected model: a limit that only
 * gates another model family (per `rateLimitLimitedScopes`) neither shows the
 * warning nor disqualifies a destination. When per-scope data is unavailable
 * (old host, never-read gauge, unresolved model) it falls back to the
 * profile-level enum - every uncertain path shows the warning rather than
 * hiding a real one. The visible state deliberately remains representable
 * with no selectable alternative so the user can inspect profile limits
 * instead of losing the warning entirely.
 *
 * `client` is caller-resolved rather than looked up internally, so each
 * surface can scope the read to the host it actually cares about (e.g. the
 * chat composer's tab host vs. a future landing composer's default host) -
 * mirrors `useResolvedSeededProfileId`'s identical `client` parameter.
 */
export function useProfileRateLimitSwitchPrompt(input: {
  readonly harnessId: GuiHarnessId;
  readonly profileId: string | null;
  readonly selectedModel: ModelOption | null;
  readonly active: boolean;
  readonly client: HostClient<HostRpcRegistry> | null;
}): ProfileRateLimitSwitchPrompt {
  const { harnessId, profileId, selectedModel, active, client } = input;
  const dismissPromptKey = useRateLimitSwitchPromptDismissalsStore(
    (state) => state.dismiss,
  );
  const providerId = providerCliIdForHarness(harnessId);
  const enabled = active && providerId !== null;
  const query = useProvidersListForClient(client, {
    enabled,
    subscribed: enabled,
  });
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
