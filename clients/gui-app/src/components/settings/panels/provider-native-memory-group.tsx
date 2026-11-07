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
import { Button } from "@/components/ui/button";
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
 * binary.
 *
 * A stored OFF then needs a way out, and the switch is gone. It gets the
 * enable-only action below instead of a disabled switch: rendering an off
 * control that cannot act is the thing the third gate exists to prevent, while
 * a button that can only ever write `true` promises nothing the binary cannot
 * do. See its own comment for why neither of the alternatives works.
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

  if (setSupported !== true || !readable) return null;
  const providerName = PROVIDER_DISPLAY_NAMES[providerId];

  // The switch cannot be offered for an executable that cannot enforce it. A
  // stored OFF still has to be clearable though, or hiding the control traps
  // the user: the host refuses to start a session it cannot honour, and
  // `providers.settingsFile.resetProvider` is NOT a way out - it resets a
  // MALFORMED row and answers `readable` for a well-formed one, so it leaves a
  // stored `false` exactly where it is. Choosing a supported executable is the
  // other route, and it is no route at all for someone whose only copy of the
  // provider is the unsupported one.
  //
  // So this state gets an enable-only action, which is not the "off switch that
  // does nothing" the gate exists to prevent: it can only ever write `true`,
  // the one value this host can promise for any binary, and the setter accepts
  // it at any version while refusing an unenforceable `false`. Keyed on `value`
  // rather than `stored` so a successful write clears the row immediately,
  // under the same echo this group already holds.
  if (!enforceable) {
    if (value) return null;
    return (
      <SettingsGroup
        group={PROVIDERS.definitions.nativeMemory}
        showTitle
        tone="default"
        dataTestId="provider-native-memory-group"
        fill={false}
      >
        <SettingsRow
          row={PROVIDERS.definitions.nativeMemoryUnenforceable}
          control={
            <div className="flex items-center gap-2">
              {settling ? <MutedAgentSpinner /> : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={settling}
                data-testid="provider-native-memory-enable-only"
                onClick={() => {
                  setEcho({
                    chosen: true,
                    against: stored,
                    seenAt: providersUpdatedAt,
                  });
                  setNativeMemory.mutate(
                    { harnessId, nativeMemory: true },
                    { onError: () => setEcho(null) },
                  );
                }}
              >
                Turn on
              </Button>
            </div>
          }
        />
      </SettingsGroup>
    );
  }

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
