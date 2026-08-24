import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ReactNode } from "react";
import type { HostRpcRegistry } from "@/lib/host";
import type { ClonedChatProfileRecoveryRequired } from "@/lib/commands/actions/resolve-cloned-chat-settings";
import { ProfileDropdown } from "@/components/providers/profile-dropdown";
import { Button } from "@/components/ui/button";
import {
  profileCommitId,
  profileDisplayLabel,
} from "@/components/providers/provider-profile-model";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import {
  useProviderProfileEnablementPending,
  useProvidersSetProfileEnabledForClient,
} from "@/hooks/providers/use-providers-set-profile-enabled-mutation";
import { providerDisplayName } from "@/lib/provider-ordering";

const FINAL_ENABLED_REASON =
  "Enable another profile before disabling this one.";

export function CloneProfileRecovery(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly resolution: ClonedChatProfileRecoveryRequired;
  readonly targetHostLabel: string;
  readonly onChooseProfile: (profileId: string | null) => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
  readonly onOpenProviderSettings: () => void;
}) {
  const providersQuery = useProvidersListForClient(props.client, {
    enabled: props.resolution.status === "profile-selection-required",
    subscribed: false,
  });
  const provider = providersQuery.data?.providers.find(
    (candidate) => candidate.providerId === props.resolution.providerId,
  );
  const profiles =
    provider?.profiles ??
    (props.resolution.status === "profile-selection-required"
      ? props.resolution.targetProfiles
      : []);
  const mutation = useProvidersSetProfileEnabledForClient(
    props.client,
    props.resolution.providerId,
  );
  const profileEnablementPending = useProviderProfileEnablementPending(
    props.client,
    props.resolution.providerId,
  );
  const enabledProfileCount = profiles.filter(
    (profile) => profile.enabled,
  ).length;
  const matchedProfile = profiles.find(
    (profile) =>
      props.resolution.status === "profile-selection-required" &&
      profileCommitId(profile) === props.resolution.matchedProfileId,
  );
  const firstProfile = profiles.at(0);
  let activeProfileId: string | null = null;
  if (firstProfile !== undefined)
    activeProfileId = profileCommitId(firstProfile);
  if (matchedProfile !== undefined) {
    activeProfileId = profileCommitId(matchedProfile);
  }
  if (props.resolution.status === "catalog-unavailable") {
    return (
      <RecoveryBar>
        <span className="min-w-0 flex-1">
          Profiles on {props.targetHostLabel} couldn&apos;t be loaded. Check the
          connection and try again.
        </span>
        <Button type="button" size="sm" onClick={props.onRetry}>
          Retry
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      </RecoveryBar>
    );
  }

  return (
    <RecoveryBar>
      <span className="min-w-0 flex-1">
        {props.resolution.reason === "matching-profile-disabled" &&
        matchedProfile !== undefined
          ? `${profileDisplayLabel(matchedProfile)} is disabled on ${props.targetHostLabel}. Enable it or choose an enabled profile before cloning.`
          : `Choose an enabled ${providerDisplayName(props.resolution.providerId)} profile on ${props.targetHostLabel} before cloning.`}
      </span>
      {profiles.length > 0 ? (
        <div className="w-full max-w-64">
          <ProfileDropdown
            providerLabel={providerDisplayName(props.resolution.providerId)}
            profiles={profiles}
            activeProfileId={activeProfileId}
            onSelectProfile={props.onChooseProfile}
            onCreateProfile={() => undefined}
            createProfileDisabled
            createProfileDisabledReason="Add profiles from Settings."
            shortcutHintForIndex={() => null}
            contentContainer={null}
            onCloseAutoFocus={null}
            usagePresentation={null}
            profileEnablementAvailable={profiles.some(
              (profile) => profile.kind === "managed",
            )}
            profileEnablementPending={profileEnablementPending}
            profileEnablementDisabledReason={(profileId) => {
              const row = profiles.find(
                (profile) => profileCommitId(profile) === profileId,
              );
              return provider?.enabled !== false &&
                row?.enabled === true &&
                enabledProfileCount <= 1
                ? FINAL_ENABLED_REASON
                : null;
            }}
            disabledProfilesSelectable={false}
            onSetProfileEnabled={(profileId, enabled) => {
              const row = profiles.find(
                (profile) => profileCommitId(profile) === profileId,
              );
              if (
                row === undefined ||
                profileEnablementPending(profileCommitId(row))
              ) {
                return;
              }
              mutation.mutate({
                providerId: props.resolution.providerId,
                profileId: row.profileId,
                enabled,
              });
            }}
            admissionByProfileId={null}
          />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="font-medium">
            No profiles are configured on this host.
          </span>
          <Button
            type="button"
            size="sm"
            onClick={props.onOpenProviderSettings}
          >
            Open provider settings
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={props.onCancel}
          >
            Cancel
          </Button>
        </div>
      )}
    </RecoveryBar>
  );
}

function RecoveryBar({ children }: { readonly children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-warning/40 bg-warning/5 px-4 py-2 text-ui-sm text-warning-foreground"
    >
      {children}
    </div>
  );
}
