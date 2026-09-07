import { useMemo, type ReactNode } from "react";
import { LineChart } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useUsageSummarySupported } from "@/hooks/usage-analytics/use-usage-summary-support";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { UsageSummaryPanel } from "@/components/usage-analytics/usage-summary-panel";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";

/** `host.usage.summary` is an optional RPC (see the protocol registry's `degrade: { kind: "unsupported" }`), so
 * an older host simply omits it from its handshake. */
export function UsageSettingsPanel(): ReactNode {
  const activeHostId = useAddressableHostId();
  const client = useHostClient();
  const scope = useHostScope();
  // Names come from the scope's merged host model.
  const hostNames = useMemo(
    () => new Map(scope.hosts.map((host) => [host.hostId, host.name])),
    [scope.hosts],
  );
  // `useHostMethodSupport`, not the boolean `useUsageSummarySupported`: this distinguishes "the host answered
  // and does not have it" from "no handshake has completed yet".
  const support = useHostMethodSupport(activeHostId, "host.usage.summary");
  return (
    <SettingsPanelShell
      title="Usage"
      // A static "on this host" was therefore a standing false claim for every cloud-served read.
      description="Token and cost usage across your agents."
      fillHeight
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
      headerAction={undefined}
    >
      <UsageSettingsPanelBody
        support={support}
        client={client}
        hostNames={hostNames}
        activeHostId={activeHostId}
        activeHostLabel={scope.activeHost?.name ?? activeHostId ?? "this host"}
        hostsResolving={scope.isLoading}
      />
    </SettingsPanelShell>
  );
}

function UsageSettingsPanelBody(props: {
  readonly support: boolean | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostNames: ReadonlyMap<string, string>;
  readonly activeHostId: string | null;
  readonly activeHostLabel: string;
  /** The host lists are still in flight, so a null active host is not yet an answer. */
  readonly hostsResolving: boolean;
}): ReactNode {
  // Checked before `support`, because with no active host `support` is permanently `null` - there is no host to
  // hand shake with, so the pending branch below could never resolve and would spin forever.
  if (props.activeHostId === null && !props.hostsResolving) {
    return (
      <UsageNotice
        title="No host connected"
        detail="Install the Traycer host on a computer and sign in — your usage appears here on its own."
        testId="usage-no-host-notice"
      />
    );
  }
  if (props.support === null) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-5 py-6 text-ui-sm text-muted-foreground"
        data-testid="usage-support-pending"
      >
        <AgentSpinningDots
          testId={undefined}
          variant="orbit"
          className="text-muted-foreground"
        />
        Loading usage…
      </div>
    );
  }
  if (!props.support) {
    return (
      <UsageNotice
        title={`Usage isn't available on ${props.activeHostLabel} yet`}
        detail="This host predates usage analytics. Update it to see token and cost usage here."
        testId="usage-unsupported-notice"
      />
    );
  }
  return (
    <UsageSummaryPanel
      client={props.client}
      hostNames={props.hostNames}
      currentHostId={props.activeHostId}
    />
  );
}

/** Passes an empty host-name map, which is the honest shape without the settings shell around it: every host id
 * then renders through the truncated-id fallback, exactly as one absent from a real directory would. */
export function UsageSettingsPanelForClient(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
}): ReactNode {
  const hostId = props.client?.getActiveHostId() ?? null;
  const supported = useUsageSummarySupported(hostId);
  if (!supported) {
    return (
      <UsageNotice
        title={`Usage isn't available on ${hostId ?? "this host"} yet`}
        detail="This host predates usage analytics. Update it to see token and cost usage here."
        testId="usage-unsupported-notice"
      />
    );
  }
  return (
    <UsageSummaryPanel
      client={props.client}
      hostNames={EMPTY_HOST_NAMES}
      currentHostId={hostId}
    />
  );
}

const EMPTY_HOST_NAMES: ReadonlyMap<string, string> = new Map();

/** Same anatomy as `HostScopeGate`'s internal `HostScopeNotice` (icon chip + title + detail, `role="status"`
 * since this is an idle capability gap. */
function UsageNotice(props: {
  readonly title: string;
  readonly detail: string;
  readonly testId: string;
}): ReactNode {
  return (
    <div
      role="status"
      className="flex flex-col items-start gap-2 rounded-lg border border-border/60 bg-card/40 px-5 py-6"
      data-testid={props.testId}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground">
        <LineChart className="size-4.5" />
      </span>
      <div className="max-w-[60ch] space-y-1">
        <p className="font-medium text-ui-sm text-foreground">{props.title}</p>
        <p className="text-ui-sm text-muted-foreground">{props.detail}</p>
      </div>
    </div>
  );
}
