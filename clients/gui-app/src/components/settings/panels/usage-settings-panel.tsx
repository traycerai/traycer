import { useMemo, type ReactNode } from "react";
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
 *
 * Ticket 13 moved this section out of the HOST group and into ACCOUNT.
 * `settings-sections.ts` states the rule the groups encode - "if it varies
 * by host it sits under the picker" - and usage stopped varying by host the
 * moment the dashboard gained its own All-hosts default: what it reports is
 * the ACCOUNT's spend, with the host as one filter inside the page rather
 * than as the page's scope. Leaving it under the sidebar's host picker would
 * have put two competing host scopes on one screen, with the outer one
 * unable to describe the number the inner one produced.
 *
 * It still reads through a host CLIENT - every RPC does - so it keeps
 * `useHostScope` for the client and the capability check. That is a
 * transport fact, not a scope one, the same distinction `requiresLocalHost`
 * already draws for Shell and Diagnostics.
 */
export function UsageSettingsPanel(): ReactNode {
  const scope = useHostScope();
  return (
    <SettingsPanelShell
      title="Usage"
      // Scope-neutral by design. The read's actual scope is a property of
      // the RESPONSE plus the in-page host filter, not of the section's
      // placement: `servedBy: "cloud"` spans every device on the account
      // (narrowed only if the reader picks a host), while `"local"` is this
      // machine only. A static "on this host" was therefore a standing false
      // claim for every cloud-served read, and nothing corrected it - the
      // corrective note `servedByScopeNote` renders under the headline is
      // deliberately `null` only for an unfiltered cloud read, where the
      // account-wide total is exactly what the reader expects. Leaving that
      // helper as the one place scope is asserted keeps a single source of
      // truth for it.
      description="Token and cost usage across your agents."
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

/**
 * Direct-client entry point for tests - bypasses `useHostScope`, mirroring
 * `NotificationsSettingsPanelForClient`. Passes an EMPTY host-name map,
 * which is the honest shape without the settings shell around it: every host
 * id then renders through the truncated-id fallback, exactly as one absent
 * from a real directory would.
 */
export function UsageSettingsPanelForClient(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
}): ReactNode {
  const hostId = props.client?.getActiveHostId() ?? null;
  const supported = useUsageSummarySupported(hostId);
  if (!supported) {
    return <UsageUnsupportedNotice hostLabel={hostId ?? "this host"} />;
  }
  return (
    <UsageSummaryPanel
      client={props.client}
      hostNames={EMPTY_HOST_NAMES}
      currentHostId={hostId}
    />
  );
}

/** Stable identity so the panel's `hostOptions` memo is not invalidated every render. */
const EMPTY_HOST_NAMES: ReadonlyMap<string, string> = new Map();

function UsageSettingsPanelBody(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  const supported = useUsageSummarySupported(scope.hostId);
  // Names come from the scope's merged host model - the union of the runtime
  // directory and the account's registry (see SETTINGS.md's "One host
  // model"), so a host the account owns but this client cannot dial is still
  // named rather than falling back to its id. The summary itself carries no
  // host name: a name is directory state that changes without the fact
  // changing, so it is joined here, at read time.
  const hostNames = useMemo(
    () => new Map(scope.hosts.map((host) => [host.hostId, host.name])),
    [scope.hosts],
  );
  if (!supported) return <UsageUnsupportedNotice hostLabel={scope.hostLabel} />;
  return (
    <UsageSummaryPanel
      client={scope.client}
      hostNames={hostNames}
      currentHostId={scope.hostId}
    />
  );
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
