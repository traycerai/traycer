import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AppliedProviderItemDetails } from "@/components/settings/environment/applied-provider-item-details";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useProvidersSetEnvOverride } from "@/hooks/providers/use-providers-set-env-override-mutation";
import { useProvidersDeleteEnvOverride } from "@/hooks/providers/use-providers-delete-env-override-mutation";
import {
  usePersonalPageHost,
  usePersonalRowNotes,
} from "@/components/settings/personal/personal-page-context";
import { PersonalRowNoteText } from "@/components/settings/personal/personal-row-note";
import { useSecretClaimedNames } from "@/components/settings/personal/use-secret-claimed-names";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { environmentMutationKeys, queryKeys } from "@/lib/query-keys";
import { useHostBinding } from "@/lib/host";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { EnvOverrideEditor } from "./env-override-editor";
import { envNamePlaceholder } from "./provider-env-name-placeholder";
import { PROVIDER_ENV_TAB_SUBTITLE } from "./provider-env-subtitle";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { useHostsRunningPersonal } from "@/components/settings/environment/use-hosts-running-configuration";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";

type ProviderId = ProviderCliState["providerId"];

/**
 * No name in a provider's env is a secret's own: a secret reaches a provider
 * only through the variables of Variables & shells, which every provider's
 * env inherits, so this tab has no claim row of its own and an override of
 * such a name gets the shadow note instead.
 */
const NO_PROVIDER_CLAIMS: ReadonlyMap<string, string> = new Map();

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
  // Every name a Personal secret is set under in Variables & shells, which
  // every provider's env inherits: a plain override of the same name shadows
  // that secret rather than reading from it, and the row says so. Nothing
  // binds a secret to a name in one provider's env, so no binding of this
  // provider's own can claim the name first.
  const globalClaims = useSecretClaimedNames();
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
  addShadowedSecretNotes({ rowNotes, overrides, globalClaims, providerName });

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
        claimedBy={NO_PROVIDER_CLAIMS}
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

/**
 * Adds a {@link ShadowedSecretNote} for every SET override whose key is a
 * name some Personal secret is set under in Variables & shells - which every
 * provider's env inherits - without this provider's own binding claiming it,
 * skipping a key that already carries a note (a host's own value, say), that
 * this provider's own binding does claim (`EnvClaimedRow` already says so),
 * or an explicit Unset (`value === null`): it receives no value from
 * anything, so there is nothing to say the provider gets "instead of the
 * secret".
 */
function addShadowedSecretNotes(props: {
  readonly rowNotes: Map<string, ReactNode>;
  readonly overrides: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
  readonly globalClaims: ReadonlyMap<string, string>;
  readonly providerName: string;
}): void {
  const { rowNotes, globalClaims, providerName } = props;
  for (const entry of props.overrides) {
    if (entry.value === null) continue;
    if (rowNotes.has(entry.key)) continue;
    const secretName = globalClaims.get(entry.key);
    if (secretName === undefined) continue;
    rowNotes.set(
      entry.key,
      <ShadowedSecretNote
        providerName={providerName}
        secretName={secretName}
      />,
    );
  }
}

/**
 * A row note for a plain override whose key is a name some Personal secret
 * is set under in Variables & shells, which every provider's env inherits,
 * without this provider's own binding claiming it: accepted as an ordinary
 * variable, but worth saying so, since the person may expect the secret's
 * value here instead.
 */
function ShadowedSecretNote(props: {
  readonly providerName: string;
  readonly secretName: string;
}): ReactNode {
  return (
    <>
      {props.providerName} gets this value instead of the secret{" "}
      <span className="font-mono">{props.secretName}</span>
      {" · "}
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        onClick={() => navigateToSettingsSection("secrets")}
      >
        Secrets
      </Button>
    </>
  );
}
