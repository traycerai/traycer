import { useMemo, type RefObject } from "react";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  ProfileDropdown,
  type ProfileDropdownShortcutHint,
} from "@/components/providers/profile-dropdown";
import type { ProfileDropdownUsagePresentation } from "@/components/providers/profile-dropdown-usage";
import { useProfileUsagePresentation } from "@/hooks/rate-limits/use-profile-usage-presentation";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import { profileCommitId } from "@/components/providers/provider-profile-model";

const EMPTY_PROFILES: ReadonlyArray<ProviderProfile> = [];

interface PickerProfileDropdownProps {
  readonly providerId: GuiHarnessId;
  readonly providerLabel: string;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly activeProfileId: string | null;
  readonly onSelectProfile: (profileId: string | null) => void;
  readonly onCreateProfile: () => void;
  readonly createProfileDisabled: boolean;
  readonly createProfileDisabledReason: string | undefined;
  readonly shortcutHintForIndex: (
    index: number,
  ) => ProfileDropdownShortcutHint | null;
  readonly contentContainer: HTMLElement | null;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly runTargetHostId: string | null;
}

/** Picker-only opt-in boundary: Settings never mounts this component. */
export function PickerProfileDropdown(props: PickerProfileDropdownProps) {
  const providerId = guiHarnessIdToProviderId(props.providerId);
  if (providerId === null) {
    return <PickerProfileDropdownView props={props} usagePresentation={null} />;
  }
  return (
    <ProfileUsagePickerProfileDropdown props={props} providerId={providerId} />
  );
}

function ProfileUsagePickerProfileDropdown({
  props,
  providerId,
}: {
  readonly props: PickerProfileDropdownProps;
  readonly providerId: ProviderId;
}) {
  const runTargetClient = useHostClientForHostId(props.runTargetHostId);
  const runTargetProvidersQuery = useProvidersListForClient(runTargetClient, {
    enabled: true,
    subscribed: true,
  });
  const usageProfiles = useMemo(() => {
    if (runTargetClient === null) return EMPTY_PROFILES;
    const provider = runTargetProvidersQuery.data?.providers.find(
      (candidate) => candidate.providerId === providerId,
    );
    if (provider === undefined) return EMPTY_PROFILES;
    return resolveHostConsistentUsageProfiles(
      props.profiles,
      provider.profiles,
      props.runTargetHostId !== null,
    );
  }, [
    props.profiles,
    props.runTargetHostId,
    providerId,
    runTargetClient,
    runTargetProvidersQuery.data,
  ]);
  const usagePresentation = useProfileUsagePresentation({
    runTargetHostId: props.runTargetHostId,
    providerId,
    profiles: usageProfiles,
  });

  return (
    <PickerProfileDropdownView
      props={props}
      usagePresentation={usagePresentation}
    />
  );
}

/**
 * Usage rows must never combine one host's visible identity with another
 * host's rate-limit summary. Only enable comparison when the explicit run
 * target reports the same complete set of profile identities the dropdown is
 * rendering; return the target host's objects so every summary field consumed
 * by `useProfileUsageComparison` comes from that same host. A missing, partial,
 * renamed, recolored, or differently-authenticated target set stays
 * identity-only until the picker receives a coherent snapshot. An explicit
 * target host also requires a concrete account identity: two unresolved null
 * identities are not evidence that independently queried hosts use the same
 * account. The null/default target is already the visible profiles' host, so
 * it may use that host's unresolved snapshot without a cross-host join.
 */
function resolveHostConsistentUsageProfiles(
  visibleProfiles: ReadonlyArray<ProviderProfile>,
  runTargetProfiles: ReadonlyArray<ProviderProfile>,
  requireResolvedAccountIdentity: boolean,
): ReadonlyArray<ProviderProfile> {
  if (visibleProfiles.length !== runTargetProfiles.length) {
    return EMPTY_PROFILES;
  }
  const runTargetByCommitId = new Map(
    runTargetProfiles.map((profile) => [profileCommitId(profile), profile]),
  );
  const resolved = visibleProfiles.map((visibleProfile) => {
    const runTargetProfile = runTargetByCommitId.get(
      profileCommitId(visibleProfile),
    );
    if (
      runTargetProfile === undefined ||
      !hasSameVisibleProfileIdentity(
        visibleProfile,
        runTargetProfile,
        requireResolvedAccountIdentity,
      )
    ) {
      return null;
    }
    return runTargetProfile;
  });
  return resolved.every(
    (profile): profile is ProviderProfile => profile !== null,
  )
    ? resolved
    : EMPTY_PROFILES;
}

function hasSameVisibleProfileIdentity(
  left: ProviderProfile,
  right: ProviderProfile,
  requireResolvedAccountIdentity: boolean,
): boolean {
  return (
    left.kind === right.kind &&
    left.label === right.label &&
    left.auth.status === right.auth.status &&
    left.auth.badgeText === right.auth.badgeText &&
    left.auth.label === right.auth.label &&
    left.auth.detail === right.auth.detail &&
    hasSameAccountIdentity(left, right, requireResolvedAccountIdentity) &&
    left.accentColor === right.accentColor
  );
}

function hasSameAccountIdentity(
  left: ProviderProfile,
  right: ProviderProfile,
  requireResolvedAccountIdentity: boolean,
): boolean {
  if (left.identity === null || right.identity === null) {
    return !requireResolvedAccountIdentity && left.identity === right.identity;
  }
  const leftKey = left.identity.accountUuid ?? left.identity.email;
  const rightKey = right.identity.accountUuid ?? right.identity.email;
  if (
    requireResolvedAccountIdentity &&
    (leftKey === null || rightKey === null)
  ) {
    return false;
  }
  return (
    left.identity.email === right.identity.email &&
    left.identity.tier === right.identity.tier &&
    left.identity.accountUuid === right.identity.accountUuid
  );
}

function PickerProfileDropdownView({
  props,
  usagePresentation,
}: {
  readonly props: PickerProfileDropdownProps;
  readonly usagePresentation: ProfileDropdownUsagePresentation | null;
}) {
  return (
    <ProfileDropdown
      providerLabel={props.providerLabel}
      profiles={props.profiles}
      activeProfileId={props.activeProfileId}
      onSelectProfile={props.onSelectProfile}
      onCreateProfile={props.onCreateProfile}
      createProfileDisabled={props.createProfileDisabled}
      createProfileDisabledReason={props.createProfileDisabledReason}
      shortcutHintForIndex={props.shortcutHintForIndex}
      contentContainer={props.contentContainer}
      onCloseAutoFocus={() => props.inputRef.current?.focus()}
      usagePresentation={usagePresentation}
    />
  );
}
