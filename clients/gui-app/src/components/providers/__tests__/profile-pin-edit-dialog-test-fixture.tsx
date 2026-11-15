import { render } from "@testing-library/react";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  pinProfile,
  providerState,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import {
  createProfileListHost,
  type ProfileListAnswer,
  type ProfileListHost,
} from "@/components/providers/__tests__/profile-pin-host-fixture";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { profileUsesRecord } from "@/components/providers/provider-profile-model";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  ListedDropdown,
  RecordEnvironmentIdReadout,
} from "@/components/providers/__tests__/profile-pin-edit-dialog-test-consumers";

export function profileListAnswer(
  profiles: readonly ProviderProfile[],
): ProfileListAnswer {
  return {
    providers: [
      providerState({
        providerId: "opencode",
        authStatus: "authenticated",
        profiles,
      }),
    ],
    native: null,
    removedProfiles: [],
  };
}

export function managedProfileForTest(input: {
  readonly profileId: string;
  readonly label: string;
  readonly otherNames: readonly string[];
}): ProviderProfile {
  return pinProfile({
    profileId: input.profileId,
    label: input.label,
    kind: "managed",
    enabled: true,
    authStatus: "authenticated",
    aliases: [],
    personNotice: null,
    terminalOnThisComputer: false,
    otherNames: input.otherNames,
  });
}

export function mountProfileEditDialog(input: {
  readonly profiles: readonly ProviderProfile[];
  readonly profile: ProviderProfile;
  readonly methods: readonly string[];
  readonly offersSignIns: boolean | undefined;
  readonly answerProfileName: (
    request: RequestOfMethod<HostRpcRegistry, "providers.answerProfileName">,
  ) => ResponseOfMethod<HostRpcRegistry, "providers.answerProfileName">;
  readonly bindHost: (
    client: HostClient<HostRpcRegistry>,
    hostId: string,
  ) => void;
}): ProfileListHost {
  const answer = profileListAnswer(input.profiles);
  const host = createProfileListHost({
    answer,
    answerProfileName: input.answerProfileName,
    failSetEnabled: false,
  });
  host.setOffersSignIns(input.offersSignIns);
  input.bindHost(host.client, host.hostId);
  const recordRow = profileUsesRecord(input.profile);
  if (recordRow) host.exposeEnvironmentBinding();
  const methods = [
    ...input.methods,
    ...(recordRow ? ["environment.status", "environment.host.read"] : []),
  ];
  recordNegotiatedHostManifest(
    host.hostId,
    Object.fromEntries(
      methods.map((method) => [method, methodVersion(method)]),
    ),
  );
  const state = answer.providers[0];
  render(
    <host.Wrapper>
      <TooltipProvider>
        <ListedDropdown
          client={host.client}
          hostId={host.hostId}
          activeProfileId={input.profile.profileId}
        />
        {recordRow ? <RecordEnvironmentIdReadout client={host.client} /> : null}
        <ProfileEditDialog
          state={state}
          profile={input.profile}
          profiles={input.profiles}
          canOauth={false}
          oauthUnavailableHint={null}
          startInReauth={false}
          isLocalHost
          open
          onOpenChange={() => undefined}
          remainingProfilesAfterRemoval={input.profiles}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable={false}
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </host.Wrapper>,
  );
  return host;
}

function methodVersion(method: string): {
  readonly major: number;
  readonly minor: number;
} {
  if (method === "environment.status") return { major: 1, minor: 2 };
  if (method === "environment.host.read") return { major: 1, minor: 1 };
  if (method === "providers.list") return { major: 10, minor: 13 };
  if (method === "providers.setEnabled") return { major: 2, minor: 1 };
  return { major: 1, minor: 0 };
}
