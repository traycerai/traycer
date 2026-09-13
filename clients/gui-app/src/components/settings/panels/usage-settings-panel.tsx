import { useMemo, type ReactNode } from "react";
import { LineChart } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useUsageSummarySupported } from "@/hooks/usage-analytics/use-usage-summary-support";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { UsageSummaryPanel } from "@/components/usage-analytics/usage-summary-panel";
import { negotiatedUsageServesLocalOnly } from "@/lib/usage-plane-admission";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

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
 * It still reads through a host CLIENT - every RPC does - but that transport
 * comes from the APP-WIDE active host, not from the sidebar's host-group
 * picker. The two are different questions, and conflating them was a real
 * defect: the picker's pick is remembered across sections, so choosing an
 * unreachable or since-removed host under the Host group left
 * `HostScopeGate` hiding this account-level dashboard behind that host's
 * notice - even though the active host was perfectly able to serve the
 * account-wide request, and even though the page's own default is "All
 * hosts". `group: "account"` in `settings-sections.ts` is the statement that
 * this section is not host-scoped; the gate is for the sections that are.
 *
 * `useHostScope` stays, but only as the NAME DIRECTORY: `scope.hosts` is the
 * merged directory-plus-registry host model, which is what turns the host
 * ids in the summary into names for the filter and the by-host breakdown. No
 * client, no gating, no status - none of which this section's scope depends
 * on.
 */
export function UsageSettingsPanel(): ReactNode {
  const activeHostId = useAddressableHostId();
  const client = useHostClient();
  const scope = useHostScope();
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
  // `useHostMethodSupport`, not the boolean `useUsageSummarySupported`: this
  // distinguishes "the host answered and does not have it" from "no
  // handshake has completed yet", so a cold start shows a spinner instead of
  // claiming the active host is too old to report usage.
  const support = useHostMethodSupport(activeHostId, "host.usage.summary");
  // The VERSION on the same manifest `support` reads. `@2.0` carries the
  // `plane: "local-only"` selector, which is the only route a session without
  // a cloud verdict has into this section.
  const usageVersion = useHostNegotiatedMethodVersion(
    client,
    "host.usage.summary",
  );
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
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
      <UsageSettingsPanelBody
        support={support}
        cloudAuthorized={cloudAuthorized}
        servesLocalOnly={negotiatedUsageServesLocalOnly(usageVersion)}
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
  /** `null` = no handshake yet, so neither "supported" nor "too old" is known. */
  readonly support: boolean | null;
  /** `authorizesCloudCapability(status)` - see the notice below for why. */
  readonly cloudAuthorized: boolean;
  /**
   * `host.usage.summary@2.0` negotiated, i.e. this host takes the
   * `plane: "local-only"` selector. Fails closed - see
   * `negotiatedUsageServesLocalOnly`.
   */
  readonly servesLocalOnly: boolean;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostNames: ReadonlyMap<string, string>;
  readonly activeHostId: string | null;
  readonly activeHostLabel: string;
  /** The host lists are still in flight, so a null active host is not yet an answer. */
  readonly hostsResolving: boolean;
}): ReactNode {
  // Checked BEFORE `support`, because with no active host `support` is
  // permanently `null` - there is no host to hand shake with, so the pending
  // branch below could never resolve and would spin forever. This section is
  // reachable on a fresh install, so that state is genuinely reachable and
  // needs a terminal answer, which is what
  // `HostScopeGate`'s own empty branch used to provide here.
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
  // The cloud-verdict gate, and the one capability that lifts it. Ordered
  // BELOW the two `support` branches on purpose: a host that does not have the
  // method at all cannot serve this cohort either, and "update this host" is
  // then the true blocker - telling that user to sign in would send them to
  // fix the one thing that would not help. The pending branch above covers the
  // same manifest read this gate depends on, so a cold start never asserts
  // "needs a verified sign-in" before the host has had a chance to say `@2.0`.
  if (!props.cloudAuthorized && !props.servesLocalOnly) {
    return <UsageUnverifiedNotice />;
  }
  return (
    <UsageSummaryPanel
      client={props.client}
      hostNames={props.hostNames}
      currentHostId={props.activeHostId}
      // Derived from the SAME `cloudAuthorized` the gate above just used, so
      // there is no path that admits a verdict-less session and then asks the
      // host for the cloud reader. A verdict-holding session sends nothing and
      // keeps the released host-picks-the-plane behavior.
      plane={props.cloudAuthorized ? null : "local-only"}
    />
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
  const usageVersion = useHostNegotiatedMethodVersion(
    props.client,
    "host.usage.summary",
  );
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  // Same two gates in the same order as `UsageSettingsPanelBody`, minus its
  // pending branch: `useUsageSummarySupported` is the boolean form, which
  // collapses "not yet known" into "unsupported", so there is no third state
  // to wait on here.
  if (!supported) {
    return (
      <UsageNotice
        title={`Usage isn't available on ${hostId ?? "this host"} yet`}
        detail="This host predates usage analytics. Update it to see token and cost usage here."
        testId="usage-unsupported-notice"
      />
    );
  }
  if (!cloudAuthorized && !negotiatedUsageServesLocalOnly(usageVersion)) {
    return <UsageUnverifiedNotice />;
  }
  return (
    <UsageSummaryPanel
      client={props.client}
      hostNames={EMPTY_HOST_NAMES}
      currentHostId={hostId}
      plane={cloudAuthorized ? null : "local-only"}
    />
  );
}

/** Stable identity so the panel's `hostOptions` memo is not invalidated every render. */
const EMPTY_HOST_NAMES: ReadonlyMap<string, string> = new Map();

/**
 * What an `unverified` session sees instead of the dashboard, on a host that
 * cannot serve it locally.
 *
 * Originally this cohort saw it unconditionally: `host.usage.summary` was
 * served by whichever reader the HOST picked (the protocol says so, via
 * `servedBy`) and the client had no selector to ask for the local one, so a
 * session whose cloud verdict authn could not confirm would otherwise read
 * account-wide usage through the retained local-host credential. Withholding
 * the whole panel, rather than just its initial fetch, also covers the manual
 * Retry and the window/metric changes that refetch. That comment then closed
 * with "a negotiated local-only selector could give this cohort the genuinely
 * local reads back" - `@2.0` is that selector, so the notice is now the
 * NEGATIVE branch of an admission rather than the whole cohort's answer.
 *
 * It still says "reads account-wide data", and that is still true of what is
 * being withheld here: this branch is reached only when the host cannot be
 * asked for anything narrower.
 */
function UsageUnverifiedNotice(): ReactNode {
  return (
    <UsageNotice
      title="Usage needs a verified sign-in"
      detail="Traycer couldn't confirm your session with the account service. Usage reads account-wide data, so it stays hidden until you're signed in again."
      testId="usage-unverified-notice"
    />
  );
}

/**
 * Same anatomy as `HostScopeGate`'s internal `HostScopeNotice` (icon chip +
 * title + detail, `role="status"` since this is an idle capability gap, not
 * an error) so it reads as one honest-state vocabulary across Settings
 * rather than a bespoke banner.
 */
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
