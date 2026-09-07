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
import {
  profileCommitId,
  type ProfileRowAdmission,
} from "@/components/providers/provider-profile-model";

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
  readonly profileEnablementPending: (profileId: string | null) => boolean;
  readonly contentContainer: HTMLElement | null;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly runTargetHostId: string | null;
  readonly admissionByProfileId: ReadonlyMap<
    string | null,
    ProfileRowAdmission
  > | null;
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
  const runTargetProvider = runTargetProvidersQuery.data?.providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  const usageProfiles = useMemo(() => {
    if (runTargetClient === null) return EMPTY_PROFILES;
    if (runTargetProvider === undefined) return EMPTY_PROFILES;
    return resolveHostConsistentUsageProfiles(
      props.profiles,
      runTargetProvider.profiles,
    );
  }, [props.profiles, runTargetClient, runTargetProvider]);
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

/** Usage rows must never combine one host's visible identity with another host's rate-limit summary. */
function resolveHostConsistentUsageProfiles(
  visibleProfiles: ReadonlyArray<ProviderProfile>,
  runTargetProfiles: ReadonlyArray<ProviderProfile>,
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
      !hasSameVisibleProfileIdentity(visibleProfile, runTargetProfile)
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
): boolean {
  return (
    left.kind === right.kind &&
    left.label === right.label &&
    left.auth.status === right.auth.status &&
    left.auth.badgeText === right.auth.badgeText &&
    left.auth.label === right.auth.label &&
    left.auth.detail === right.auth.detail &&
    hasSameAccountIdentity(left, right) &&
    left.accentColor === right.accentColor
  );
}

function hasSameAccountIdentity(
  left: ProviderProfile,
  right: ProviderProfile,
): boolean {
  if (left.identity === null || right.identity === null) {
    return left.identity === right.identity;
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
      profileEnablementPending={props.profileEnablementPending}
      contentContainer={props.contentContainer}
      onCloseAutoFocus={() => props.inputRef.current?.focus()}
      usagePresentation={usagePresentation}
      eligibilityControls={null}
      admissionByProfileId={props.admissionByProfileId}
    />
  );
}
