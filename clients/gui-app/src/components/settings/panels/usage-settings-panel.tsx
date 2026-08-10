import type { ReactNode } from "react";
import { LineChart } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import {
  useHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { useUsageSummarySupported } from "@/hooks/usage-analytics/use-usage-summary-support";
import { UsageSummaryPanel } from "@/components/usage-analytics/usage-summary-panel";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The route / modal entry point. `host.usage.summary` is an OPTIONAL RPC
 * (see the protocol registry's `degrade: { kind: "unsupported" }`), so an
 * older host simply omits it from its handshake - this section stays in the
 * static `SETTINGS_SECTIONS` list either way (that list's ordering is
 * load-bearing for the leader-digit shortcuts, so it cannot vanish based on
 * runtime host capability) and instead swaps its BODY for a capability
 * notice, presented the same way `HostScopeGate` already presents every
 * other "nothing to show for this host" case - a normal host-capability
 * gap, not an error.
 */
export function UsageSettingsPanel(): ReactNode {
  const scope = useHostScope();
  return (
    <SettingsPanelShell
      title="Usage"
      description="Token and cost usage across your agents on this host."
      fillHeight
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
      headerAction={undefined}
    >
      <HostScopeGate
        scope={scope}
        skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
      >
        <UsageSettingsPanelBody scope={scope} />
      </HostScopeGate>
    </SettingsPanelShell>
  );
}

/** Direct-client entry point for tests - bypasses `useHostScope`, mirroring `NotificationsSettingsPanelForClient`. */
export function UsageSettingsPanelForClient(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
}): ReactNode {
  const hostId = props.client?.getActiveHostId() ?? null;
  const supported = useUsageSummarySupported(hostId);
  if (!supported) {
    return <UsageUnsupportedNotice hostLabel={hostId ?? "this host"} />;
  }
  return <UsageSummaryPanel client={props.client} />;
}

function UsageSettingsPanelBody(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  const supported = useUsageSummarySupported(scope.hostId);
  if (!supported) return <UsageUnsupportedNotice hostLabel={scope.hostLabel} />;
  return <UsageSummaryPanel client={scope.client} />;
}

/**
 * Same anatomy as `HostScopeGate`'s internal `HostScopeNotice` (icon chip +
 * title + detail, `role="status"` since this is an idle capability gap, not
 * an error) so it reads as one honest-state vocabulary across the Host
 * section group rather than a bespoke banner.
 */
function UsageUnsupportedNotice(props: {
  readonly hostLabel: string;
}): ReactNode {
  return (
    <div
      role="status"
      className="flex flex-col items-start gap-2 rounded-lg border border-border/60 bg-card/40 px-5 py-6"
      data-testid="usage-unsupported-notice"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
        <LineChart className="size-4.5" />
      </span>
      <div className="max-w-[60ch] space-y-1">
        <p className="font-medium text-ui-sm text-foreground">
          Usage isn't available on {props.hostLabel} yet
        </p>
        <p className="text-ui-sm text-muted-foreground">
          This host predates usage analytics. Update it to see token and cost
          usage here.
        </p>
      </div>
    </div>
  );
}
