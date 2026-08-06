import { Activity, memo, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { useRunnerHost } from "@/providers/use-runner-host";
import { PortalConcealmentProvider } from "@/components/ui/portal-concealment-context";
import { cn } from "@/lib/utils";

/**
 * The honest-state gate for a host-scoped panel. Its contract has two planes,
 * and keeping them distinct is the whole design:
 *
 * **Visibility and side-effects.** Three of the scope's states (`connecting`,
 * `unreachable`, `vanished`) MUST NOT show panel content or let it act,
 * because there is no client behind the host name at the top of the screen.
 * Leaving that decision to each panel is how the old surface ended up showing
 * one host's providers under another host's label. When the scope is not
 * usable this renders the state's notice, and the children are held inside a
 * hidden `<Activity>`: React tears their effects and subscriptions down, so a
 * query hook under the dead scope cannot fire — the same guarantee a full
 * unmount gave, without the cost below.
 *
 * **Component state.** A full unmount also destroyed every draft a panel held
 * — a hook being written, a pasted API key, an open dialog — on any TRANSIENT
 * same-host disconnect (host restart, sleep, relay blip). That produced a
 * review-round-per-editor stream of per-surface retention stores; the hidden
 * `<Activity>` retires the whole class, because React preserves the subtree's
 * state while it is hidden. The Activity is keyed by the host, so a REAL host
 * switch still discards everything: a draft belongs to one machine's files
 * and must never be re-pointed at another.
 *
 * `vanished` and the no-host states render the notice alone — there the host
 * is gone (or never resolved), so there is nothing a preserved draft could
 * honestly belong to.
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
        {/* The provider sits INSIDE the Activity but OUTSIDE the freeze:
            context, unlike props, must keep flowing while the subtree is
            frozen, so portal surfaces learn they are concealed (their DOM
            escapes the Activity's own styling — see the context's docs). */}
        <PortalConcealmentProvider value={!usable}>
          <FrozenWhileConcealed usable={usable}>
            {props.children}
          </FrozenWhileConcealed>
        </PortalConcealmentProvider>
      </Activity>
    </>
  );
}

/**
 * Holds the concealed subtree on its LAST USABLE render.
 *
 * Hiding alone is not enough: a hidden `<Activity>` still re-renders its
 * children when the panel above re-renders, and panels derive their tree
 * shape from client-bound queries. The moment the scope loses its client
 * those queries read as empty, the panel switches to its "unavailable"
 * branch, and the stateful editor underneath unmounts INSIDE the hidden
 * boundary — exactly the draft loss the Activity exists to prevent. The
 * comparator reports "equal" while the subtree is not usable, so React keeps
 * the last committed output (and its state) untouched until the scope is
 * usable again, when fresh props flow in as normal.
 */
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
 *
 * The open goes through `useRunnerOpenExternalLink` rather than the bridge
 * directly: the mutation owns the query key and the runner-error mapping, so
 * a shell that cannot open links says so instead of failing silently.
 */
function PlanRestrictedUpgradeAction(): ReactNode {
  const runnerHost = useRunnerHost();
  const openExternalLink = useRunnerOpenExternalLink();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={openExternalLink.isPending}
      onClick={() => {
        openExternalLink.mutate(
          resolveManageSubscriptionUrl(runnerHost.authnBaseUrl),
        );
      }}
      data-testid="host-scope-plan-upgrade"
    >
      {openExternalLink.isPending ? (
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant={undefined}
        />
      ) : null}
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
