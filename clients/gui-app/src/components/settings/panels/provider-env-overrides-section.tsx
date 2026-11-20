import { useSubmittedSecretInput } from "@/hooks/use-submitted-secret-input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
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
  const submittedValue = useSubmittedSecretInput<string | null>(
    "Provider variable input is unavailable.",
  );
  const setOverride = useProvidersSetEnvOverride(
    submittedValue.read,
    submittedValue.clear,
  );
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
      submittedValue.set(entry.value);
      await setOverride.mutateAsync({
        providerId,
        key: entry.key,
        executableWriteGrant: null,
      });
      await clearOwnValue.mutateAsync({
        target: { kind: "env_override", providerId, key: entry.key },
      });
    },
  });
  const commitOverride = useMutation({
    onSettled: submittedValue.clear,
    mutationFn: async (entry: {
      readonly oldKey: string;
      readonly newKey: string;
    }) => {
      await setOverride.mutateAsync({
        providerId,
        key: entry.newKey,
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
  // The overrides re-read after a write: `disabled` ends with the write, and
  // the spinner stays until the re-read lands.
  const [saving, setSaving] = useState(false);
  const notes = usePersonalRowNotes({
    kind: "env_override",
    providerId,
    keyPrefix: `${providerIdToGuiHarnessId(providerId)}:`,
  });
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
    submittedValue.set(value);
    setSaving(true);
    try {
      await commitOverride.mutateAsync({ oldKey, newKey });
      await rereadOverrides(hostId);
    } finally {
      setSaving(false);
    }
  };
  const onDelete = async (key: string): Promise<void> => {
    const hostId = hostClient?.getActiveHostId() ?? null;
    setSaving(true);
    try {
      await deleteOverride.mutateAsync({ providerId, key });
      await rereadOverrides(hostId);
    } finally {
      setSaving(false);
    }
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
        {saving || disabled ? <MutedAgentSpinner /> : null}
      </div>
      <EnvOverrideEditor
        key={JSON.stringify([viewerId, configurationKey, providerId])}
        rowNotes={rowNotes}
        overrides={overrides}
        disabled={disabled}
        namePlaceholder={envNamePlaceholder(providerId)}
        emptyLabel={`No variables for ${providerName}.`}
        staleRefusal={null}
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
