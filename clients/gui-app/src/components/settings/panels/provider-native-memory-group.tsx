/**
 * Docs: see ../SETTINGS.md (Providers ▸ General ▸ Memories).
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
import { useProvidersSetNativeMemory } from "@/hooks/providers/use-providers-set-native-memory-mutation";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { providersListReportsNativeMemory } from "@/lib/providers/provider-native-memory";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

/**
 * Whether one provider's own memory is left as it ships for the sessions
 * Traycer launches. Providers ▸ {provider} ▸ General is its only home.
 *
 * Drawn only when the surface's host can READ the value back
 * (`providers.list@10.8`), WRITE it (`providers.setNativeMemory`, an optional
 * method), AND says it can enforce it for this provider
 * (`nativeMemorySupported`). The third gate is the one this switch adds over
 * its subagents neighbour, and it is the point: there is no prompt-level
 * fallback for memory, so a provider the host has no contract for must show
 * no control rather than one that would store a preference nothing acts on.
 * All three hold the render until they can answer, and an absent
 * `nativeMemorySupported` - every host below 10.8 - reads as cannot.
 *
 * That third answer is about the EXECUTABLE, not only the provider: the host
 * judges the binary it would actually run and reports cannot for a version
 * below its verified floor or one it cannot read at all. So this control can
 * disappear for a provider that had it, when the user points it at another
 * binary. A stored OFF survives that and is NOT stranded - the host refuses to
 * start a session it cannot honour and says how to recover, and
 * `providers.setNativeMemory` still accepts `true` while refusing an
 * unenforceable `false`. Deliberately no disabled-but-visible switch here:
 * rendering an off control that cannot act is the thing the third gate exists
 * to prevent.
 *
 * ON does not assert that the provider has memories switched on: it asserts
 * that Traycer applies no override, so a provider whose own default is off
 * stays off. The row's copy describes the OFF state for that reason.
 *
 * Holds the choice this window just made until the host's own echo of it
 * comes back through `providers.list`, exactly as `ProviderNativeSubagentsGroup`
 * does and for the same reason: the mutation reports success while the refetch
 * it triggered is still in flight.
 */
export function ProviderNativeMemoryGroup(props: {
  readonly state: ProviderCliState;
}): ReactNode {
  const providerId = props.state.providerId;
  const hostId = useAddressableHostId();
  const setSupported = useHostMethodSupport(
    hostId,
    "providers.setNativeMemory",
  );
  const readable = providersListReportsNativeMemory(
    useHostMethodSchemaVersion(hostId, "providers.list"),
  );
  const harnessId = providerIdToGuiHarnessId(providerId);
  const setNativeMemory = useProvidersSetNativeMemory(harnessId);
  const stored = props.state.nativeMemory ?? true;
  const enforceable = props.state.nativeMemorySupported ?? false;
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
  const settling = setNativeMemory.isPending || providersQuery.isFetching;
  const value =
    echo !== null &&
    echo.against === stored &&
    echo.seenAt === providersUpdatedAt
      ? echo.chosen
      : stored;

  if (setSupported !== true || !readable || !enforceable) return null;
  const providerName = PROVIDER_DISPLAY_NAMES[providerId];

  return (
    <SettingsGroup
      group={PROVIDERS.definitions.nativeMemory}
      showTitle
      tone="default"
      dataTestId="provider-native-memory-group"
      fill={false}
    >
      <SettingsRow
        row={PROVIDERS.definitions.nativeMemoryEnabled}
        control={
          <div className="flex items-center gap-2">
            {settling ? <MutedAgentSpinner /> : null}
            <Switch
              checked={value}
              disabled={settling}
              aria-label={`Use ${providerName} memories`}
              data-testid="provider-native-memory-switch"
              onCheckedChange={(next) => {
                if (next === value) return;
                setEcho({
                  chosen: next,
                  against: stored,
                  seenAt: providersUpdatedAt,
                });
                setNativeMemory.mutate(
                  { harnessId, nativeMemory: next },
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
