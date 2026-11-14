import { useState, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { isProviderKeyProviderId } from "@traycer-clients/shared/host-client/provider-api-key-change";
import { useHostClient } from "@/lib/host";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { ProviderApiKeySection } from "@/components/settings/panels/provider-api-key-section";

interface TeamProviderApiKeySectionProps {
  readonly providerId: ProviderId;
  readonly environmentId: string;
  readonly environmentName: string | null;
  readonly mayManageAccounts: boolean;
}

/** The team's page edits a key only through the window's own joined computer. */
export function TeamProviderApiKeySection(
  props: TeamProviderApiKeySectionProps,
): ReactNode {
  if (!props.mayManageAccounts || !isProviderKeyProviderId(props.providerId))
    return null;
  return (
    <TeamProviderApiKeyEditor
      key={`${props.environmentId}:${props.providerId}`}
      {...props}
    />
  );
}

function TeamProviderApiKeyEditor(
  props: TeamProviderApiKeySectionProps,
): ReactNode {
  // TeamProviders does not re-provide the selected viewing computer's runtime.
  const client = useHostClient();
  const hostId = useAddressableHostId();
  const begin = useHostNegotiatedMethodVersion(
    client,
    "providers.beginApiKeyChange",
  );
  const supported = begin !== null && begin !== false;
  const status = useEnvironmentStatusRead(client, hostId, supported);
  const list = useProvidersListForClient(client, {
    enabled: supported,
    subscribed: true,
  });
  const [draft, setDraft] = useState("");
  const state = list.data?.providers.find(
    (row) => row.providerId === props.providerId,
  );
  if (
    !supported ||
    hostId === null ||
    status.isError ||
    status.data?.principal?.kind !== "team" ||
    list.isError ||
    state === undefined ||
    !state.apiKey.supported ||
    state.apiKey.recordEnvironmentId !== props.environmentId
  ) {
    return null;
  }
  return (
    <ProviderApiKeySection
      key={hostId}
      state={state}
      draft={draft}
      onDraftChange={setDraft}
      expectedEnvironmentId={props.environmentId}
      environmentName={props.environmentName}
    />
  );
}
