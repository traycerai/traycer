import { Activity, memo, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { PlanRestrictedUpgradeAction } from "@/components/settings/host-scope/plan-restricted-upgrade-action";
import { PortalConcealmentProvider } from "@/components/ui/portal-concealment-context";
import { cn } from "@/lib/utils";

/** Its contract has two planes, and keeping them distinct is the whole design. */
export function HostScopeGate(props: {
  readonly scope: HostScope;
  readonly children: ReactNode;
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

  // Both render with no hosts in hand, but "you own no machines" is a confident claim, and making it on the back
  // of a request that errored told people to go install a host they already had.
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

  const usable = isHostScopeUsable(scope.status);
  let notice: ReactNode = null;
  if (scope.status === "unreachable") {
    notice = <UnreachableNotice scope={scope} host={scope.host} />;
  } else if (scope.status === "connecting") {
    notice = <>{props.skeleton}</>;
  }

  return (
    <>
      {notice}
      <Activity key={scope.host.hostId} mode={usable ? "visible" : "hidden"}>
        {/* The provider sits inside the Activity but outside the freeze. */}
        <PortalConcealmentProvider value={!usable}>
          <FrozenWhileConcealed usable={usable}>
            {props.children}
          </FrozenWhileConcealed>
        </PortalConcealmentProvider>
      </Activity>
    </>
  );
}

/** Holds the concealed subtree on its last usable render. */
const FrozenWhileConcealed = memo(
  function FrozenWhileConcealed(props: {
    readonly usable: boolean;
    readonly children: ReactNode;
  }) {
    return <>{props.children}</>;
  },
  (_prev, next) => !next.usable,
);

function UnreachableNotice(props: {
  readonly scope: HostScope;
  readonly host: HostScopeOption;
}): ReactNode {
  const { scope, host } = props;
  // The server would refuse the attach (`plan_restricted`) while the host keeps working on its own machine.
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
      // The two causes read the same to a user but have different fixes, so the copy names which one this is rather
      // than offering a generic "try again" against a route that does not exist.
      detail={
        host.registered && !host.connectable
          ? "This host is in your account, but this app has no connection to it right now. Its status above is from your account, not a live link."
          : "No connection is available to this host."
      }
      // The reasoning then was that `deriveHostScopeStatus` answers "following" before it can ever answer
      // "unreachable", so the active host could not reach this branch.
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

function HostScopeNotice(props: {
  readonly tone: "warn" | "idle";
  readonly title: string;
  readonly detail: string | null;
  readonly action: ReactNode;
  readonly testId: string;
}): ReactNode {
  return (
    <div
      // The notice swaps in for the panel body without a navigation, so without a live region a screen reader hears
      // nothing change.
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
