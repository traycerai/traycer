/**
 * Docs: see ../SETTINGS.md (Providers ▸ CLI & Args ▸ Model list).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ConfigCatalogSetRequest } from "@traycer/protocol/host/config/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { GUI_HARNESS_BY_PROVIDER_ID } from "@traycer-clients/shared/providers/provider-harness-ids";
import { SettingsSegmentedControl } from "@/components/settings/controls/settings-segmented-control";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { PROVIDERS } from "@/components/settings/panels/providers-settings.definitions";
import {
  catalogTimeoutOptions,
  catalogTimeoutRowsSupported,
} from "@/components/settings/panels/providers-catalog-timeout-options";
import { resolveAutoCleanupGate } from "@/components/settings/panels/worktree-auto-cleanup-gate";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Switch } from "@/components/ui/switch";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useHostQuery } from "@/hooks/host/use-host-query";
import {
  useConfigCatalogSetMutation,
  useConfigCatalogSetOutstanding,
} from "@/hooks/config/use-config-catalog-set-mutation";
import { trackSettingChanged } from "@/lib/analytics";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";

const CATALOG_GET = "config.catalog.get";
const CATALOG_SET = "config.catalog.set";

const READ_ERROR_STATUS =
  "Couldn't read this host's setting. Repair ~/.traycer/cli/config.json on that machine, or back it up before resetting it, then reopen Settings.";

/**
 * Settings ▸ Providers ▸ <provider> ▸ CLI & Args ▸ Model list: how long the
 * scoped host waits for this provider to list its models (and commands).
 *
 * Two rows. **Timeout** is a segmented picker. **Same for all providers** is a
 * switch: on (no value of its own stored for this provider), the picker shows
 * and edits the value every such provider shares (`scope: "all"`, which leaves
 * other providers' own values alone); off, the provider has its own value and
 * the picker edits only that (`scope: "harness"`). Turning the switch off
 * starts the provider's own value at the shared one; turning it on clears it.
 * Stored in the `catalog` block of `~/.traycer/cli/config.json` on the scoped
 * host and read at every catalog probe, so a change applies to the next read.
 *
 * Mounted under the panel's `HostScopeGate`, so the scope is usable and the
 * ambient binding is the scoped host's. It also resolves the Worktrees chips'
 * gate (reachable host, BOTH methods negotiated - at 1.1, the line that knows
 * per-provider values). Anything short of `ready` renders nothing, so a host
 * too old for the setting, a 1.0 one included, has no rows.
 */
export function ProviderCatalogTimeoutGroup(props: {
  readonly providerId: ProviderId;
  readonly hostId: string | null;
}): ReactNode {
  const { providerId, hostId } = props;
  const client = useHostClient();
  const reachability = useHostReachability(hostId ?? "");
  // Two statements, not one `&&` - a short-circuited hook call is a
  // rules-of-hooks violation.
  const getVersion = useHostNegotiatedMethodVersion(client, CATALOG_GET);
  const setVersion = useHostNegotiatedMethodVersion(client, CATALOG_SET);
  const gate = resolveAutoCleanupGate({
    hostId,
    // The panel's gate mounts this subtree only on a usable scope.
    scopeUsable: true,
    reachabilityStatus: reachability.status,
    hasClient: true,
    supported: catalogTimeoutRowsSupported(getVersion, setVersion),
  });
  if (gate !== "ready" || hostId === null) return null;
  // Keyed by host: a switch straight from one usable host to another must not
  // carry the outgoing host's pending write across.
  return (
    <CatalogTimeoutRows
      key={hostId}
      client={client}
      hostId={hostId}
      harnessId={GUI_HARNESS_BY_PROVIDER_ID[providerId]}
    />
  );
}

function CatalogTimeoutRows(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly harnessId: string;
}): ReactNode {
  const { client, hostId, harnessId } = props;
  const query = useHostQuery<HostRpcRegistry, "config.catalog.get">({
    cacheKeyIdentity: undefined,
    client,
    method: CATALOG_GET,
    params: {},
    options: { enabled: true },
  });
  // Files the host's answer into the read before it settles, so the rows never
  // re-enable on the state before a write (see the hook).
  const setCatalogTimeout = useConfigCatalogSetMutation(client, hostId);
  // Every outstanding write on this host, including one sent by rows that
  // have since unmounted - not just this observer's own.
  const writeOutstanding = useConfigCatalogSetOutstanding(hostId);
  const state = query.data ?? null;
  const ownSeconds =
    state !== null && Object.hasOwn(state.overrides, harnessId)
      ? state.overrides[harnessId]
      : null;
  const sameForAll = ownSeconds === null;
  const shownSeconds = ownSeconds ?? state?.probeTimeoutSeconds ?? null;
  const disabled = state === null || writeOutstanding;
  const options = catalogTimeoutOptions(state?.bounds ?? null, shownSeconds);

  const write = (
    request: ConfigCatalogSetRequest,
    setting: "catalogProbeTimeout" | "catalogProbeTimeoutSameForAll",
  ): void => {
    trackSettingChanged("providers", setting);
    setCatalogTimeout.mutate(request);
  };

  return (
    <SettingsGroup
      group={PROVIDERS.definitions.modelList}
      showTitle
      tone="default"
      dataTestId="provider-catalog-timeout-group"
      fill={false}
    >
      <SettingsRow
        row={PROVIDERS.definitions.modelListTimeout}
        // The repair sentence only when there is no value to show: the read
        // failed before anything was known. A failed RE-read behind a value
        // (the last read, or a write's answer) keeps that value, and the next
        // write reports its own failure.
        status={
          query.isError && state === null ? (
            <div className="flex flex-col gap-1">
              <p>{PROVIDERS.definitions.modelListTimeout.description}</p>
              <p role="alert">{READ_ERROR_STATUS}</p>
            </div>
          ) : undefined
        }
        control={
          <div className="flex items-center gap-2">
            {writeOutstanding ? (
              <AgentSpinningDots
                className={undefined}
                testId="provider-catalog-timeout-saving"
                variant={undefined}
                tone="muted"
              />
            ) : null}
            <SettingsSegmentedControl
              value={shownSeconds === null ? "" : String(shownSeconds)}
              options={options.map((option) => ({
                value: String(option.seconds),
                label: option.label,
              }))}
              ariaLabel="Model list timeout"
              disabled={disabled}
              onChange={(next) => {
                const seconds = Number(next);
                if (seconds === shownSeconds) return;
                write(
                  sameForAll
                    ? { scope: "all", probeTimeoutSeconds: seconds }
                    : {
                        scope: "harness",
                        harnessId,
                        probeTimeoutSeconds: seconds,
                      },
                  "catalogProbeTimeout",
                );
              }}
            />
          </div>
        }
      />
      <SettingsRow
        row={PROVIDERS.definitions.modelListSameForAll}
        control={
          <Switch
            checked={sameForAll}
            disabled={disabled}
            aria-label="Same for all providers"
            onCheckedChange={(checked) => {
              if (state === null) return;
              write(
                {
                  scope: "harness",
                  harnessId,
                  // Off: this provider's own value starts at the shared one,
                  // so nothing changes until the picker moves. On: clear it.
                  probeTimeoutSeconds: checked
                    ? null
                    : state.probeTimeoutSeconds,
                },
                "catalogProbeTimeoutSameForAll",
              );
            }}
          />
        }
      />
    </SettingsGroup>
  );
}
