import { PickerProfileDropdown } from "@/components/home/pickers/picker-profile-dropdown";
import { useProfileRecordEnvironmentId } from "@/hooks/providers/use-profile-record-environment-id";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { RefObject } from "react";

const INPUT_REF: RefObject<HTMLInputElement | null> = { current: null };

export function ListedDropdown(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly activeProfileId: string;
}) {
  const list = useProvidersListForClient(props.client, {
    enabled: true,
    subscribed: true,
  });
  const state = list.data?.providers.find(
    (provider) => provider.providerId === "opencode",
  );
  if (state === undefined) return null;
  return (
    <PickerProfileDropdown
      providerId="opencode"
      providerLabel="OpenCode"
      profiles={state.profiles}
      activeProfileId={props.activeProfileId}
      onSelectProfile={() => undefined}
      onCreateProfile={() => undefined}
      createProfileDisabled={false}
      createProfileDisabledReason={undefined}
      shortcutHintForIndex={() => null}
      profileEnablementPending={() => false}
      contentContainer={null}
      inputRef={INPUT_REF}
      runTargetHostId={props.hostId}
      admissionByProfileId={null}
    />
  );
}

export function RecordEnvironmentIdReadout(props: {
  readonly client: HostClient<HostRpcRegistry>;
}) {
  const environmentId = useProfileRecordEnvironmentId(props.client, true);
  return <output>{environmentId}</output>;
}
