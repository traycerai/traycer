import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useProvidersSetEnvOverride } from "@/hooks/providers/use-providers-set-env-override-mutation";
import { useProvidersDeleteEnvOverride } from "@/hooks/providers/use-providers-delete-env-override-mutation";
import { EnvOverrideEditor } from "./env-override-editor";
import { envNamePlaceholder } from "./provider-env-name-placeholder";

type ProviderId = ProviderCliState["providerId"];

export function ProviderEnvOverridesSection({
  providerId,
  overrides,
}: {
  readonly providerId: ProviderId;
  readonly overrides: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
}) {
  const providerName = PROVIDER_DISPLAY_NAMES[providerId];
  const setOverride = useProvidersSetEnvOverride();
  const deleteOverride = useProvidersDeleteEnvOverride();
  const disabled = setOverride.isPending || deleteOverride.isPending;

  // A rename is set-new → delete-old so a failed delete leaves a harmless
  // duplicate rather than a lost value.
  const onCommit = (
    oldKey: string,
    newKey: string,
    value: string | null,
  ): void => {
    setOverride.mutate(
      { providerId, key: newKey, value },
      {
        onSuccess: () => {
          if (oldKey.length > 0 && oldKey !== newKey) {
            deleteOverride.mutate({ providerId, key: oldKey });
          }
        },
      },
    );
  };

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">
            Environment variables
          </div>
          <p className="text-ui-xs text-muted-foreground">
            Applied when Traycer spawns the {providerName} harness. Use Unset to
            drop a variable inherited from your shell.
          </p>
        </div>
        {disabled ? <MutedAgentSpinner /> : null}
      </div>
      <EnvOverrideEditor
        overrides={overrides}
        disabled={disabled}
        namePlaceholder={envNamePlaceholder(providerId)}
        emptyLabel={`No environment variables for ${providerName}.`}
        onCommit={onCommit}
        onDelete={(key) => deleteOverride.mutate({ providerId, key })}
      />
    </div>
  );
}
