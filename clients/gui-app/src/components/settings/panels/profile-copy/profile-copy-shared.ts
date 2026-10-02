import { useCallback, useMemo } from "react";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  isProfileEnabled,
  PROVIDER_DISPLAY_NAMES,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import {
  profileCopyGuiProvider,
  type ProfileCopyWireProvider,
} from "@/lib/profile-copy/profile-copy-model";
import type { ProfileCopyExistingProfileState } from "@/lib/profile-copy/profile-copy-presentation";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/** What a device is called in copy. Never a raw host id. */
const UNNAMED_DEVICE = "that device";

export interface ProfileCopyHosts {
  /** Every host this account owns or this client can dial. */
  readonly options: readonly HostScopeOption[];
  readonly nameFor: (hostId: string) => string;
  /** The device is THIS machine - the only place a local challenge may open. */
  readonly isLocalMachine: (hostId: string) => boolean;
}

/**
 * Names and locality for host ids the flow CAPTURED. This reads the account's
 * host list only to label a machine; it never decides which host a request
 * goes to.
 */
export function useProfileCopyHosts(): ProfileCopyHosts {
  const { hosts } = useHostOptions();
  return useMemo(
    () => ({
      options: hosts,
      nameFor: (hostId) =>
        hosts.find((host) => host.hostId === hostId)?.name ?? UNNAMED_DEVICE,
      isLocalMachine: (hostId) =>
        hosts.find((host) => host.hostId === hostId)?.isLocalMachine ?? false,
    }),
    [hosts],
  );
}

export interface ProfileCopySourceProfile {
  readonly profileName: string;
  /** The profile is on the source's list (`false` while the list loads). */
  readonly available: boolean;
  /** The source answered, and the profile is not on it. */
  readonly missing: boolean;
}

/** One profile on a host's own `providers.list` answer, or `null`. */
function listedProfile(
  response: ResponseOfMethod<HostRpcRegistry, "providers.list"> | undefined,
  provider: ProfileCopyWireProvider,
  profileId: string,
): ProviderProfile | null {
  return (
    response?.providers
      .find((state) => state.providerId === profileCopyGuiProvider(provider))
      ?.profiles.find((profile) => profile.profileId === profileId) ?? null
  );
}

/**
 * The source profile as the SOURCE lists it, read through the captured source
 * host's client - never the host Settings shows.
 */
export function useProfileCopySourceProfile(
  sourceHostId: string,
  provider: ProfileCopyWireProvider,
  sourceProfileId: string,
): ProfileCopySourceProfile {
  const sourceClient = useHostClientForHostId(sourceHostId);
  const providersQuery = useProvidersListForClient(sourceClient, {
    enabled: true,
    subscribed: true,
  });
  const sourceProfile = listedProfile(
    providersQuery.data,
    provider,
    sourceProfileId,
  );
  return {
    profileName: sourceProfile?.label ?? "this profile",
    available: sourceProfile !== null,
    missing: providersQuery.isSuccess && sourceProfile === null,
  };
}

/**
 * A profile the DESTINATION already had (an already-present copy), as the
 * destination's own `providers.list` states it: read through the captured
 * destination host's client, keyed by the outcome's `targetProfileId`. `null`
 * until the destination answers, or once it no longer lists that profile.
 * Display only - nothing here decides a route or a capability.
 */
export function useProfileCopyExistingProfile(
  destinationHostId: string,
  provider: ProfileCopyWireProvider,
  profileId: string,
): ProfileCopyExistingProfileState | null {
  const destinationClient = useHostClientForHostId(destinationHostId);
  const providersQuery = useProvidersListForClient(destinationClient, {
    enabled: true,
    subscribed: true,
  });
  const profile = listedProfile(providersQuery.data, provider, profileId);
  if (profile === null) return null;
  return {
    enabled: isProfileEnabled(profile),
    authStatus: profile.auth.status,
  };
}

export function profileCopyProviderLabel(
  provider: ProfileCopyWireProvider,
): string {
  return PROVIDER_DISPLAY_NAMES[profileCopyGuiProvider(provider)];
}

/**
 * A request error as a sentence about the host it went to. Chosen by code:
 * a host's own message is never rendered, and no id or account detail is.
 * FORBIDDEN reads as temporary - during an account-directory outage it is.
 */
export function profileCopyRequestErrorText(
  error: HostRpcError,
  hostName: string,
): string {
  switch (error.code) {
    case "E_HOST_UNSUPPORTED":
      return `Update Traycer on ${hostName} to copy profiles.`;
    case "FORBIDDEN":
    case "UNAUTHORIZED":
      return "Traycer couldn't confirm your devices right now. Try again in a moment.";
    case "E_INVALID_ARGUMENT":
      return `${hostName} couldn't do that with what it has now. Review it and try again.`;
    default:
      return `Couldn't reach ${hostName} right now. Try again.`;
  }
}

export interface ProfileCopySettingsNavigation {
  /** Settings ▸ Providers on the DESTINATION, on the copied profile. */
  readonly openDestinationProfile: (input: {
    readonly destinationHostId: string;
    readonly provider: ProfileCopyWireProvider;
    readonly profileId: string;
  }) => void;
  /** Settings ▸ Providers ▸ CLI & Args on the destination (install lives there). */
  readonly openDestinationSetup: (input: {
    readonly destinationHostId: string;
    readonly provider: ProfileCopyWireProvider;
  }) => void;
}

/**
 * Moves Settings to a destination the copy named, then closes the copy
 * surface. The move goes through the focus store the same way every other
 * deep link does, so it is a one-shot intent consumed by that host's rail.
 */
export function useProfileCopySettingsNavigation(): ProfileCopySettingsNavigation {
  const { openSettings } = useSystemTabModalActions();
  const closeFlow = useProfileCopyFlowStore((state) => state.close);
  const openDestinationProfile = useCallback(
    (input: {
      readonly destinationHostId: string;
      readonly provider: ProfileCopyWireProvider;
      readonly profileId: string;
    }) => {
      const focus = useProvidersFocusStore.getState();
      focus.setProfileFocus({
        harnessId: providerIdToGuiHarnessId(
          profileCopyGuiProvider(input.provider),
        ),
        hostId: input.destinationHostId,
        profileId: input.profileId,
        startSignIn: false,
      });
      focus.setFocusTab("usage");
      closeFlow();
      openSettings({
        section: "providers",
        resetToGeneral: false,
        tab: null,
        draft: null,
        // The providers focus set above carries the destination host.
        hostId: null,
      });
    },
    [closeFlow, openSettings],
  );
  const openDestinationSetup = useCallback(
    (input: {
      readonly destinationHostId: string;
      readonly provider: ProfileCopyWireProvider;
    }) => {
      useProvidersFocusStore.getState().setHostProviderFocus({
        harnessId: providerIdToGuiHarnessId(
          profileCopyGuiProvider(input.provider),
        ),
        hostId: input.destinationHostId,
        tab: "general",
      });
      closeFlow();
      openSettings({
        section: "providers",
        resetToGeneral: false,
        tab: null,
        draft: null,
        // The providers focus set above carries the destination host.
        hostId: null,
      });
    },
    [closeFlow, openSettings],
  );
  return { openDestinationProfile, openDestinationSetup };
}
