import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
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
    return (
      <HostScopeNotice
        tone="warn"
        title={`Can't reach ${scope.host.name} from here`}
        // The two causes read the same to a user but have different fixes, so
        // the copy names which one this is rather than offering a generic
        // "try again" against a route that does not exist.
        detail={
          scope.host.registered && !scope.host.connectable
            ? "This host is in your account, but this app has no connection to it right now. Its status above is from your account, not a live link."
            : "No connection is available to this host."
        }
        // Unconditional. This used to be gated on `!scope.isViewingActive`,
        // which is dead: `isViewingActive` IS `isFollowing`, and the status
        // derivation returns "following" before it can ever return
        // "unreachable" — so the null arm could not be reached. Stating the
        // action plainly beats a condition that reads like it protects
        // something and does not.
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
        testId="host-scope-unreachable"
      />
    );
  }

  if (scope.status === "connecting") {
    return <>{props.skeleton}</>;
  }

  return <>{props.children}</>;
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
