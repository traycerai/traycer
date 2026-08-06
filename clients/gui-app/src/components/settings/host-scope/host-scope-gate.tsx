import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import { useRunnerHost } from "@/providers/use-runner-host";
import { cn } from "@/lib/utils";

/**
 * The honest-state gate for a host-scoped panel.
 *
 * Every host-scoped section renders its body through this. The point is not
 * decoration — it is that three of the scope's states (`connecting`,
 * `unreachable`, `vanished`) MUST NOT render panel content, because there is
 * no client behind the host name at the top of the screen. Leaving that
 * decision to each panel is how the old surface ended up showing one host's
 * providers under another host's label.
 *
 * The scope's control lives in the sidebar, once. This renders no picker: it
 * is a readout plus, where a state is recoverable, the one action that
 * recovers it.
 */
export function HostScopeGate(props: {
  readonly scope: HostScope;
  /** What the panel shows once a client is genuinely available. */
  readonly children: ReactNode;
  /** Panel-specific loading shape, so `connecting` isn't a bare spinner. */
  readonly skeleton: ReactNode;
}): ReactNode {
  const { scope } = props;

  if (scope.status === "vanished") {
    return (
      <HostScopeNotice
        tone="warn"
        title={`${scope.hostLabel} is no longer registered`}
        detail="It was removed from your account, or signed out. Nothing here can act on it."
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={scope.returnToActive}
            data-testid="host-scope-return-to-active"
          >
            Back to {scope.activeHost?.name ?? "your active host"}
          </Button>
        }
        testId="host-scope-vanished"
      />
    );
  }

  // A failed list is NOT an empty account. Both render with no hosts in hand,
  // but "you own no machines" is a confident claim, and making it on the back
  // of a request that errored told people to go install a host they already
  // had. This branch precedes the empty one so the confident copy can only be
  // reached by a list that actually answered.
  if (scope.host === null && scope.listsFailed) {
    return (
      <HostScopeNotice
        tone="warn"
        title="Couldn't load your hosts"
        detail="The list of machines on your account didn't come back. Nothing here is missing — it just hasn't loaded."
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={scope.retryLists}
            data-testid="host-scope-retry-lists"
          >
            Try again
          </Button>
        }
        testId="host-scope-lists-failed"
      />
    );
  }

  if (scope.host === null) {
    return (
      <HostScopeNotice
        tone="idle"
        title={scope.isLoading ? "Finding your hosts…" : "No hosts yet"}
        detail={
          scope.isLoading
            ? null
            : "Install the Traycer host on a computer and sign in — it appears here on its own."
        }
        action={null}
        testId="host-scope-empty"
      />
    );
  }

  if (scope.status === "unreachable") {
    return <UnreachableNotice scope={scope} host={scope.host} />;
  }

  if (scope.status === "connecting") {
    return <>{props.skeleton}</>;
  }

  return <>{props.children}</>;
}

function UnreachableNotice(props: {
  readonly scope: HostScope;
  readonly host: HostScopeOption;
}): ReactNode {
  const { scope, host } = props;
  // A plan-gated route is not a broken one. The server would refuse the
  // attach (`plan_restricted`) while the host keeps working on its own
  // machine — so the remedy is an upgrade, and presenting it as "can't
  // reach" sends people debugging connectivity over a billing limit. The
  // deleted My Hosts list carried exactly this notice; the scope model now
  // preserves the reason so this gate can keep making the distinction.
  if (host.planRestricted) {
    return (
      <HostScopeNotice
        tone="warn"
        title={`Connecting to ${host.name} needs a paid plan`}
        detail="It keeps working on its own machine, and account-level settings here still apply. This app just can't attach to it remotely on the current plan."
        action={<PlanRestrictedUpgradeAction />}
        testId="host-scope-plan-restricted"
      />
    );
  }
  return (
    <HostScopeNotice
      tone="warn"
      title={`Can't reach ${host.name} from here`}
      // The two causes read the same to a user but have different fixes, so
      // the copy names which one this is rather than offering a generic
      // "try again" against a route that does not exist.
      detail={
        host.registered && !host.connectable
          ? "This host is in your account, but this app has no connection to it right now. Its status above is from your account, not a live link."
          : "No connection is available to this host."
      }
      // Gated on `!scope.isViewingActive` — and that arm is live now, though
      // it genuinely was dead when this was written. The reasoning then was
      // that `deriveHostScopeStatus` answers "following" before it can ever
      // answer "unreachable", so the active host could not reach this branch.
      // Asking `connectable` BEFORE `isFollowing` — so an active host whose
      // directory entry goes `unavailable` stops mounting RPC panels — made
      // the combination reachable, and with it a button offering to take you
      // "Back to" the host you are already on by clearing an override that is
      // already null. There is nothing to return to, so nothing is offered:
      // the notice above already names the host and says why it is stuck.
      action={
        scope.isViewingActive ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={scope.returnToActive}
            data-testid="host-scope-return-to-active"
          >
            Back to {scope.activeHost?.name ?? "your active host"}
          </Button>
        )
      }
      testId="host-scope-unreachable"
    />
  );
}

/**
 * Its own component so `useRunnerHost` mounts only in the plan-restricted
 * branch — the gate itself stays renderable without the runner provider.
 */
function PlanRestrictedUpgradeAction(): ReactNode {
  const runnerHost = useRunnerHost();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void runnerHost.openExternalLink(
          resolveManageSubscriptionUrl(runnerHost.authnBaseUrl),
        );
      }}
      data-testid="host-scope-plan-upgrade"
    >
      Upgrade plan
    </Button>
  );
}

function HostScopeNotice(props: {
  readonly tone: "warn" | "idle";
  readonly title: string;
  readonly detail: string | null;
  readonly action: ReactNode;
  readonly testId: string;
}): ReactNode {
  return (
    <div
      // The notice swaps in for the panel body without a navigation, so
      // without a live region a screen reader hears nothing change. `warn`
      // states interrupt; `idle` states wait their turn.
      role={props.tone === "warn" ? "alert" : "status"}
      className="flex flex-col items-start gap-2 rounded-lg border border-border/60 bg-card/40 px-5 py-6"
      data-testid={props.testId}
    >
      <div
        className={cn(
          "font-medium text-ui-sm",
          props.tone === "warn" ? "text-amber-500" : "text-foreground",
        )}
      >
        {props.title}
      </div>
      {props.detail === null ? null : (
        <p className="max-w-[68ch] text-ui-sm text-muted-foreground">
          {props.detail}
        </p>
      )}
      {props.action}
    </div>
  );
}

/** The default `connecting` shape for panels with nothing more specific. */
export function HostScopeConnecting(props: {
  readonly hostName: string;
}): ReactNode {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-5 py-6 text-ui-sm text-muted-foreground"
      data-testid="host-scope-connecting"
    >
      <AgentSpinningDots
        testId={undefined}
        variant="orbit"
        className="text-muted-foreground"
      />
      Connecting to {props.hostName}…
    </div>
  );
}
