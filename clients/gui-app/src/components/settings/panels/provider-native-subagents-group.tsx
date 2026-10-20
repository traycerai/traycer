/**
 * Docs: see ../SETTINGS.md (Providers ▸ General ▸ Native subagents).
 * Update that file whenever this settings surface changes.
 */
import { useState, type ReactNode } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { PROVIDERS } from "@/components/settings/panels/providers-settings.definitions";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import {
  useHostMethodSchemaVersion,
  useHostMethodSupport,
} from "@/hooks/host/use-host-supports-method";
import { useProvidersSetNativeSubagents } from "@/hooks/providers/use-providers-set-native-subagents-mutation";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import {
  providerNativeSubagentsFor,
  providersListReportsNativeSubagents,
} from "@/lib/providers/provider-native-subagents";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

/**
 * Whether one provider's agents may start the provider's own built-in
 * subagents. Providers ▸ {provider} ▸ General is its only home.
 *
 * Drawn only when the surface's host can both READ the value back
 * (`providers.list@10.5`) and WRITE it (`providers.setNativeSubagents`, an
 * optional method): a switch the host cannot honour is worse than none, and
 * an older host has nothing new to configure. Both gates hold the render
 * until they can answer.
 *
 * Holds the choice this window just made until the host's own echo of it
 * comes back through `providers.list`, exactly as `ProviderJudgeSwitch` does
 * and for the same reason: the mutation reports success while the refetch it
 * triggered is still in flight.
 */
export function ProviderNativeSubagentsGroup(props: {
  readonly state: ProviderCliState;
}): ReactNode {
  const providerId = props.state.providerId;
  const hostId = useAddressableHostId();
  const setSupported = useHostMethodSupport(
    hostId,
    "providers.setNativeSubagents",
  );
  const readable = providersListReportsNativeSubagents(
    useHostMethodSchemaVersion(hostId, "providers.list"),
  );
  const harnessId = providerIdToGuiHarnessId(providerId);
  const setNativeSubagents = useProvidersSetNativeSubagents(harnessId);
  const stored = providerNativeSubagentsFor(props.state);
  const [echo, setEcho] = useState<{
    readonly chosen: boolean;
    readonly against: boolean;
    readonly seenAt: number;
  } | null>(null);
  const providersQuery = useProvidersList({
    enabled: true,
    subscribed: true,
  });
  const providersUpdatedAt = providersQuery.dataUpdatedAt;
  const settling = setNativeSubagents.isPending || providersQuery.isFetching;
  const value =
    echo !== null &&
    echo.against === stored &&
    echo.seenAt === providersUpdatedAt
      ? echo.chosen
      : stored;

  if (setSupported !== true || !readable) return null;
  const providerName = PROVIDER_DISPLAY_NAMES[providerId];

  return (
    <SettingsGroup
      group={PROVIDERS.definitions.nativeSubagents}
      showTitle
      tone="default"
      dataTestId="provider-native-subagents-group"
      fill={false}
    >
      <SettingsRow
        row={PROVIDERS.definitions.nativeSubagentsEnabled}
        control={
          <div className="flex items-center gap-2">
            {settling ? <MutedAgentSpinner /> : null}
            <Switch
              checked={value}
              disabled={settling}
              aria-label={`Allow ${providerName}'s native subagents`}
              data-testid="provider-native-subagents-switch"
              onCheckedChange={(next) => {
                if (next === value) return;
                setEcho({
                  chosen: next,
                  against: stored,
                  seenAt: providersUpdatedAt,
                });
                setNativeSubagents.mutate(
                  { harnessId, nativeSubagents: next },
                  // A refused write leaves the stored value where it was; the
                  // toast says what happened and this puts the switch back.
                  { onError: () => setEcho(null) },
                );
              }}
            />
          </div>
        }
      />
    </SettingsGroup>
  );
}
