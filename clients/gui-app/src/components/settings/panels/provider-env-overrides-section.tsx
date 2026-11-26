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
  usePersonalHostName,
  usePersonalPageHost,
  usePersonalRowNotes,
} from "@/components/settings/personal/personal-page-context";
import { OwnSlotRowNoteText } from "@/components/settings/personal/own-slot-row-note";
import {
  useOwnSlotRowNote,
  type OwnSlotHostBinding,
} from "@/components/settings/personal/use-own-slot-row-note";
import { PersonalRowNoteText } from "@/components/settings/personal/personal-row-note";
import { useSaveOwnValueEverywhere } from "@/hooks/environment/use-save-own-value-everywhere";
import { queryKeys } from "@/lib/query-keys";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostBinding } from "@/lib/host";
import { hostNameFromLabel } from "@/lib/host/host-name";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
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
  const useEverywhere = useSaveOwnValueEverywhere(
    "providers.setEnvOverride",
    "providers.list",
    ({ target, value }) => {
      submittedValue.set(value);
      return setOverride.mutateAsync({ providerId, key: target.key });
    },
  );
  const commitOverride = useMutation({
    onSettled: submittedValue.clear,
    mutationFn: async (entry: {
      readonly oldKey: string;
      readonly newKey: string;
    }) => {
      await setOverride.mutateAsync({
        providerId,
        key: entry.newKey,
      });
      if (entry.oldKey.length > 0 && entry.oldKey !== entry.newKey) {
        await deleteOverride.mutateAsync({ providerId, key: entry.oldKey });
      }
    },
  });
  const disabled =
    setOverride.isPending ||
    deleteOverride.isPending ||
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
        disabled={disabled || !useEverywhere.available}
        onUseEverywhere={(key, value) =>
          useEverywhere.mutate({
            target: { kind: "env_override", providerId, key },
            value,
          })
        }
      />,
    );
  }

  const ownSlots = useOwnSlotProviderOverrideNotes(
    providerId,
    overrides,
    saving || disabled,
    rowNotes,
  );

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
        rowNotes={ownSlots.rowNotes}
        overrides={overrides}
        disabled={disabled}
        namePlaceholder={envNamePlaceholder(providerId)}
        emptyLabel={
          ownSlots.missing.length === 0
            ? `No variables for ${providerName}.`
            : null
        }
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
      {ownSlots.missing.length === 0 ? null : (
        <ul className="divide-y divide-border/40 rounded-lg border border-border/60">
          {ownSlots.missing.map((entry) => {
            const name = entry.key.slice(ownSlots.keyPrefix.length);
            return (
              <li
                key={entry.key}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <span className="text-ui-sm text-foreground">{name}</span>
                <p className="text-ui-xs text-muted-foreground">
                  <OwnSlotProviderOverrideRowNote
                    itemKey={entry.key}
                    hostBinding={ownSlots.hostBinding}
                    disabled={saving || disabled}
                    fallback={null}
                  />
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function useOwnSlotProviderOverrideNotes(
  providerId: ProviderId,
  overrides: readonly { readonly key: string }[],
  disabled: boolean,
  baseRowNotes: ReadonlyMap<string, ReactNode>,
) {
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;
  const hostId = binding?.hostId ?? client?.getActiveHostId() ?? null;
  const hostEntry = useHostDirectoryEntryForHostId(hostId);
  const personalHostName = usePersonalHostName();
  const personalHost = usePersonalPageHost();
  const selectedName = personalHost.hostId === hostId ? personalHostName : null;
  const pick = useEnvironmentPick();
  const hostBinding: OwnSlotHostBinding = {
    client,
    hostId,
    hostName:
      hostId === null
        ? (personalHostName ?? "this computer")
        : hostNameFromLabel(hostEntry?.label ?? selectedName, hostId),
    enabled: pick.kind === "personal" && hostId !== null && client !== null,
  };
  const ownSlots = useOwnSlotRowNote(
    { kind: "env_override", key: null, os: "any" },
    hostBinding,
  );
  const keyPrefix = `${providerIdToGuiHarnessId(providerId)}:`;
  const absent = ownSlots.entries.filter(
    (entry) =>
      entry.kind === "env_override" &&
      entry.os === "any" &&
      entry.state === "absent" &&
      entry.key.startsWith(keyPrefix),
  );
  const existingKeys = new Set(overrides.map((override) => override.key));
  const rowNotes = new Map(baseRowNotes);
  for (const entry of absent) {
    const name = entry.key.slice(keyPrefix.length);
    if (!existingKeys.has(name)) continue;
    rowNotes.set(
      name,
      <OwnSlotProviderOverrideRowNote
        itemKey={entry.key}
        hostBinding={hostBinding}
        disabled={disabled}
        fallback={rowNotes.get(name) ?? null}
      />,
    );
  }
  const missing = absent.filter(
    (entry) => !existingKeys.has(entry.key.slice(keyPrefix.length)),
  );
  return { rowNotes, missing, hostBinding, keyPrefix };
}

function OwnSlotProviderOverrideRowNote(props: {
  readonly itemKey: string;
  readonly hostBinding: OwnSlotHostBinding;
  readonly disabled: boolean;
  readonly fallback: ReactNode;
}): ReactNode {
  const ownSlot = useOwnSlotRowNote(
    { kind: "env_override", key: props.itemKey, os: "any" },
    props.hostBinding,
  );
  if (ownSlot.entry?.state !== "absent") return props.fallback;
  return (
    <OwnSlotRowNoteText
      entry={ownSlot.entry}
      hostName={ownSlot.hostName}
      valueDescription={null}
      disabled={props.disabled || ownSlot.disabled}
      onChange={ownSlot.change}
    />
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
