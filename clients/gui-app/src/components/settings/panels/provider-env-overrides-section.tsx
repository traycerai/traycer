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
import { CredentialRefusalNote } from "@/components/providers/credential-refusal-note";
import { useHostCredentialRefusal } from "@/hooks/host/use-host-credential-refusal";
import { useHeldValueReviews } from "@/components/settings/personal/use-held-value-reviews";
import { useKeyShapedSecret } from "@/components/settings/personal/use-key-shaped-secret";
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
import {
  EnvOverrideEditor,
  type KeyRefusal,
  type KeyRefusalFor,
} from "./env-override-editor";
import { envNamePlaceholder } from "./provider-env-name-placeholder";
import {
  providerEnvSubtitle,
  providerNativeConfigOnlyEnvSubtitle,
} from "./provider-env-subtitle";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { useHostsRunningPersonal } from "@/components/settings/environment/use-hosts-running-configuration";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

type ProviderId = ProviderCliState["providerId"];

/**
 * A provider's variables refuse a key the way Variables does, except the
 * provider's own key variable, whose home is its Account tab: the value is
 * cleared, not carried, so the key neither stays in the row nor travels.
 */
function providerKeyRefusal(
  refusal: KeyRefusal | null,
  keyVariable: string,
  providerName: string,
  onOpenAccount: (() => void) | null,
): KeyRefusalFor {
  if (refusal === null) return null;
  return (name) =>
    onOpenAccount === null || name !== keyVariable
      ? refusal
      : {
          before: `This is ${providerName}'s key. Set it on `,
          link: `${providerName}'s Account tab`,
          after: ".",
          clearsValue: true,
          onLink: onOpenAccount,
        };
}

export function ProviderEnvOverridesSection({
  providerId,
  overrides,
  envOverrideScope,
  onOpenAccount,
}: {
  readonly providerId: ProviderId;
  /**
   * Opens this provider's Account tab, where its own key is kept; `null` for
   * a provider without one.
   */
  readonly onOpenAccount: (() => void) | null;
  readonly overrides: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
  readonly envOverrideScope: ProviderCliState["nativeCapabilities"]["envOverrideScope"];
}) {
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
  // A provider's env overrides are where its keys live (`ANTHROPIC_API_KEY`,
  // a base URL's token), so a sandbox gets none: the editor is disabled and
  // nothing is sent.
  const credentialRefusal = useHostCredentialRefusal(null);
  // The same rule as Variables: a key-shaped value is refused for Secrets.
  const keyShaped = useKeyShapedSecret();
  const onHold = useHeldValueReviews(
    "env_override",
    `${providerIdToGuiHarnessId(providerId)}:`,
  );
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
    commitOverride.isPending ||
    credentialRefusal !== null;
  const notes = usePersonalRowNotes({
    kind: "env_override",
    providerId,
    keyPrefix: `${providerIdToGuiHarnessId(providerId)}:`,
  });
  const claimedBy = useSecretClaimedNames({ kind: "provider", providerId });
  // Every name a Personal secret is set under in Variables & shells, which
  // every provider's env inherits regardless of its own bindings: a plain
  // override of the same name - one this provider's OWN binding (claimedBy)
  // does not claim - shadows that secret rather than reading from it, and
  // the row says so.
  const globalClaims = useSecretClaimedNames({ kind: "variable" });
  // The hosts this save propagates to, for the pending row's own label; a
  // Local row's save reaches only this computer, so it keeps the plain
  // Adding/Saving/Removing text instead. Only once the list has actually
  // answered with at least one host - `loading`/`failed` is not a count, and
  // `ready` with zero is not either: the list goes `ready` as soon as the
  // cloud read answers, while this computer's own status can still be
  // unresolved and held out of `hosts` a moment longer - presenting any of
  // that as an exact "on N hosts" would misstate the reach the save has.
  const hostsRunningPersonal = useHostsRunningPersonal(!local);
  const applyingHostsCount =
    !local &&
    hostsRunningPersonal.state === "ready" &&
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
  addShadowedSecretNotes({
    rowNotes,
    overrides,
    claimedBy,
    globalClaims,
    providerName,
  });

  // A rename is set-new → delete-old so a failed delete leaves a harmless
  // duplicate rather than a lost value.
  const onCommit = async (
    oldKey: string,
    newKey: string,
    value: string | null,
  ): Promise<void> => {
    if (credentialRefusal !== null)
      return Promise.reject(new Error(credentialRefusal));
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
            {UNRELEASED_FEATURES_ENABLED
              ? "Variables"
              : "Environment variables"}
          </div>
          <ProviderEnvSubtitleLine
            providerName={providerName}
            nativeConfigOnly={envOverrideScope === "native-config-only"}
            local={local}
          />
        </div>
        {setOverride.isPending || deleteOverride.isPending ? (
          <MutedAgentSpinner />
        ) : null}
      </div>
      <CredentialRefusalNote refusal={credentialRefusal} />
      <EnvOverrideEditor
        key={JSON.stringify([viewerId, configurationKey, providerId])}
        rowNotes={rowNotes}
        onHold={onHold}
        claimedBy={claimedBy}
        keyRefusal={providerKeyRefusal(
          keyShaped.refusal,
          envNamePlaceholder(providerId),
          providerName,
          onOpenAccount,
        )}
        credentialRefusal={credentialRefusal}
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
      {keyShaped.dialog}
    </div>
  );
}

/**
 * What the provider's variables apply to. A build without environments
 * (`unreleased-features.ts`) keeps the wording from before them.
 */
function ProviderEnvSubtitleLine(props: {
  readonly providerName: string;
  readonly nativeConfigOnly: boolean;
  readonly local: boolean;
}): ReactNode {
  const { providerName } = props;
  if (!UNRELEASED_FEATURES_ENABLED) {
    return (
      <p className="text-ui-xs text-muted-foreground">
        {props.nativeConfigOnly
          ? "Applied to native configuration operations, such as MCP setup, but not chat turns. Use Unset to drop a variable inherited from your shell."
          : `Applied when Traycer spawns the ${providerName} harness. Use Unset to drop a variable inherited from your shell.`}
      </p>
    );
  }
  const configuration = props.local
    ? { kind: "local" as const }
    : { kind: "personal" as const };
  return props.nativeConfigOnly ? (
    <p className="text-ui-xs text-muted-foreground">
      {providerNativeConfigOnlyEnvSubtitle(providerName, configuration)}
    </p>
  ) : (
    <p className="text-ui-xs text-muted-foreground">
      {providerEnvSubtitle(providerName, configuration)}
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
  readonly claimedBy: ReadonlyMap<string, string>;
  readonly globalClaims: ReadonlyMap<string, string>;
  readonly providerName: string;
}): void {
  const { rowNotes, claimedBy, globalClaims, providerName } = props;
  for (const entry of props.overrides) {
    if (entry.value === null) continue;
    if (rowNotes.has(entry.key)) continue;
    if (claimedBy.has(entry.key)) continue;
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
