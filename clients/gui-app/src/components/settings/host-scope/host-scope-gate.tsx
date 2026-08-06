import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  HostGlyph,
  HostPresenceDot,
} from "@/components/settings/host-scope/host-glyph";
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
            Back to {scope.activeHost?.name ?? "your active machine"}
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
        title={scope.isLoading ? "Finding your machines…" : "No machines yet"}
        detail={
          scope.isLoading
            ? null
            : "Install the Traycer host on a machine and sign in — it appears here on its own."
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
            ? "This machine is in your account, but this app has no connection to it right now. Its status above is from your account, not a live link."
            : "No connection is available to this machine."
        }
        action={
          scope.isViewingActive ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={scope.returnToActive}
              data-testid="host-scope-return-to-active"
            >
              Back to {scope.activeHost?.name ?? "your active machine"}
            </Button>
          )
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

/**
 * A one-line readout naming the machine a panel is acting on.
 *
 * Panels that are scoped by the sidebar switcher still owe the reader an
 * answer to "which machine is this?" at the point of the content — the
 * sidebar is a glance away, but a destructive button is not the place to make
 * someone glance. It is deliberately inert: the accent-free styling and the
 * absence of a chevron say "this is a fact, the control is elsewhere".
 */
export function HostScopeLine(props: {
  readonly scope: HostScope;
  readonly className: string | undefined;
}): ReactNode {
  const { scope } = props;
  if (scope.host === null) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground",
        props.className,
      )}
      data-testid="host-scope-line"
    >
      <HostGlyph host={scope.host} className="size-3.5" />
      <span className="truncate">{scope.host.name}</span>
      <HostPresenceDot
        tone={scope.host.health.tone}
        animate={scope.host.health.live}
        className={undefined}
      />
      <span className="truncate">{scope.host.health.label}</span>
      {scope.isViewingActive ? null : (
        // The one asymmetry worth stating inline: you are configuring a
        // machine that is NOT the one this window's bell and new work use.
        // Without it, a person edits notification policy on B all evening and
        // wonders why the bell never changes.
        <span className="shrink-0">· not this window's active machine</span>
      )}
    </span>
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
