import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AppliedProviderItemDetails } from "@/components/settings/environment/applied-provider-item-details";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useProvidersSetEnvOverride } from "@/hooks/providers/use-providers-set-env-override-mutation";
import { useProvidersDeleteEnvOverride } from "@/hooks/providers/use-providers-delete-env-override-mutation";
import {
  usePersonalPageHost,
  usePersonalRowNotes,
} from "@/components/settings/personal/personal-page-context";
import { PersonalRowNoteText } from "@/components/settings/personal/personal-row-note";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { environmentMutationKeys, queryKeys } from "@/lib/query-keys";
import { useHostBinding } from "@/lib/host";
import { EnvOverrideEditor } from "./env-override-editor";
import { envNamePlaceholder } from "./provider-env-name-placeholder";
import { PROVIDER_ENV_TAB_SUBTITLE } from "./provider-env-subtitle";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { useHostsRunningPersonal } from "@/components/settings/environment/use-hosts-running-configuration";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";

type ProviderId = ProviderCliState["providerId"];

export function ProviderEnvOverridesSection(props: {
  readonly providerId: ProviderId;
  readonly overrides: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
  /**
   * Still required from the provider row. The Env line no longer changes
   * with it: every scope uses {@link PROVIDER_ENV_TAB_SUBTITLE}.
   */
  readonly envOverrideScope: ProviderCliState["nativeCapabilities"]["envOverrideScope"];
}) {
  const { providerId, overrides } = props;
  const providerName = PROVIDER_DISPLAY_NAMES[providerId];
  const queryClient = useQueryClient();
  const hostClient = useHostBinding()?.hostClient ?? null;
  // Join the mutation's invalidation fetch. Completion also covers reads whose
  // values are unchanged by structural sharing or supersede the submitted value.
  const rereadOverrides = (hostId: string | null): Promise<void> =>
    hostId === null
      ? Promise.resolve()
      : queryClient.refetchQueries(
          { queryKey: queryKeys.hostMethodScope(hostId, "providers.list") },
          { cancelRefetch: false, throwOnError: true },
        );
  const viewerId = useCloudChatViewerId();
  const configurationKey = useConfigurationKey();
  // A team is read from the cloud (`TeamProviders`): this tab is Personal on
  // a host running it, or a Local row's computer.
  const local = useEnvironmentPick().kind === "local";
  const setOverride = useProvidersSetEnvOverride();
  const deleteOverride = useProvidersDeleteEnvOverride();
  // Use everywhere: this host's own value becomes Personal's, then the host
  // stops keeping one; cleared only after the save landed.
  const pageHost = usePersonalPageHost();
  const clearOwnValue = useHostScopedMutationForClient(pageHost.client, {
    method: "config.env.localOverride.clear",
    mutationKey: environmentMutationKeys.localOverrideClear(),
    errorMessage: "Couldn't stop this computer keeping its own value.",
    scope: { id: "config.env.localOverride" },
    invalidateMethods: ["environment.localOverrides", "providers.list"],
  });
  const useEverywhere = useMutation({
    mutationFn: async (entry: {
      readonly key: string;
      readonly value: string;
    }) => {
      await setOverride.mutateAsync({
        providerId,
        ...entry,
        executableWriteGrant: null,
      });
      await clearOwnValue.mutateAsync({
        target: { kind: "env_override", providerId, key: entry.key },
      });
    },
  });
  const commitOverride = useMutation({
    mutationFn: async (entry: {
      readonly oldKey: string;
      readonly newKey: string;
      readonly value: string | null;
    }) => {
      await setOverride.mutateAsync({
        providerId,
        key: entry.newKey,
        value: entry.value,
        executableWriteGrant: null,
      });
      if (entry.oldKey.length > 0 && entry.oldKey !== entry.newKey) {
        await deleteOverride.mutateAsync({ providerId, key: entry.oldKey });
      }
    },
  });
  const disabled =
    setOverride.isPending ||
    deleteOverride.isPending ||
    clearOwnValue.isPending ||
    useEverywhere.isPending ||
    commitOverride.isPending;
  const notes = usePersonalRowNotes({
    kind: "env_override",
    providerId,
    keyPrefix: `${providerIdToGuiHarnessId(providerId)}:`,
  });
  // The hosts this save propagates to, for the pending row's own label; a
  // Local row's save reaches only this computer, so it keeps the plain
  // Adding/Saving/Removing text instead. Only once the list has actually
  // answered with at least one host - `loading`/`failed` is not a count, and
  // `ready` with zero is not either: the list goes `ready` as soon as the
  // cloud read answers, while this computer's own status can still be
  // unresolved and held out of `hosts` a moment longer - presenting any of
  // that as an exact "on N hosts" would misstate the reach the save has. Nor
  // while this computer's own status is unread even with another host
  // already listed (`thisComputerUnread`): `hosts` can already hold that
  // other host while this computer's own membership is still unknown, and an
  // exact count taken then would understate the real total.
  const hostsRunningPersonal = useHostsRunningPersonal(!local);
  const applyingHostsCount =
    !local &&
    hostsRunningPersonal.state === "ready" &&
    !hostsRunningPersonal.thisComputerUnread &&
    hostsRunningPersonal.hosts.length > 0
      ? hostsRunningPersonal.hosts.length
      : null;
  const rowNotes = new Map<string, ReactNode>();
  for (const [key, note] of notes) {
    rowNotes.set(
      key,
      <PersonalRowNoteText
        name={key}
        note={note}
        disabled={disabled}
        onUseEverywhere={(key, value) => useEverywhere.mutate({ key, value })}
      />,
    );
  }

  // A rename is set-new → delete-old so a failed delete leaves a harmless
  // duplicate rather than a lost value.
  const onCommit = async (
    oldKey: string,
    newKey: string,
    value: string | null,
  ): Promise<void> => {
    const hostId = hostClient?.getActiveHostId() ?? null;
    await commitOverride.mutateAsync({ oldKey, newKey, value });
    await rereadOverrides(hostId);
  };
  const onDelete = async (key: string): Promise<void> => {
    const hostId = hostClient?.getActiveHostId() ?? null;
    await deleteOverride.mutateAsync({ providerId, key });
    await rereadOverrides(hostId);
  };

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">
            Variables
          </div>
          <ProviderEnvSubtitleLine />
        </div>
        {setOverride.isPending || deleteOverride.isPending ? (
          <MutedAgentSpinner />
        ) : null}
      </div>
      <EnvOverrideEditor
        key={JSON.stringify([viewerId, configurationKey, providerId])}
        rowNotes={rowNotes}
        overrides={overrides}
        disabled={disabled}
        namePlaceholder={envNamePlaceholder(providerId)}
        emptyLabel={`No variables for ${providerName}.`}
        staleRefusal={null}
        applyingHostsCount={applyingHostsCount}
        renderDetails={(key) => (
          <AppliedProviderItemDetails
            kind="env_override"
            itemKey={`${providerIdToGuiHarnessId(providerId)}:${key}`}
            title={key}
          />
        )}
        onCommit={onCommit}
        onDelete={onDelete}
      />
    </div>
  );
}

/** The Env tab's one line. Reach does not change it. */
function ProviderEnvSubtitleLine(): ReactNode {
  return (
    <p className="text-ui-xs text-muted-foreground">
      {PROVIDER_ENV_TAB_SUBTITLE}
    </p>
  );
}
