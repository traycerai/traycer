import { useCallback, useState, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { TerminalLoadingSkeleton } from "@/components/epic-canvas/renderers/terminal-loading-skeleton";
import { TerminalGridMeasureProbe } from "@/components/epic-canvas/renderers/terminal-grid-measure-probe";
import { TileHostLoadState } from "@/components/epic-canvas/renderers/tile-host-load-state";
import {
  useTerminalTileBootstrap,
  type TerminalCreatePayload,
} from "@/hooks/agent/use-terminal-tile-bootstrap";
import {
  useHostReachability,
  resolvedHostLabel,
} from "@/hooks/agent/use-host-reachability";
import { useBoundedHostLoad } from "@/hooks/host/use-bounded-host-load";
import { useLandingProviderTerminalLogin } from "@/hooks/providers/use-landing-provider-terminal-login";
import {
  LandingTerminalTileLive,
  TerminalDeadState,
  type LandingTerminalTileProps,
} from "./landing-terminal-tile";
import { useRemoveExitedLandingTab } from "./use-remove-exited-landing-tab";

const INDEPENDENT_SCOPE: TerminalScope = { kind: "independent" };

/**
 * The landing panel's tile for a HOST-created provider sign-in session (a tab
 * with `origin: "provider-login"`). The landing counterpart of the epic
 * canvas's sign-in tile, with the same two rules:
 *
 * - It never creates. The session carries the provider's spawn env; a
 *   `terminal.create` (or `terminal.plain.create`) under its id would spawn a
 *   bare shell that looks like the sign-in terminal and cannot sign anyone
 *   in, with no error saying so. `adoptOnly` keeps the bootstrap's create
 *   effect shut for life while still arming the measure-grid wait it needs
 *   to subscribe at a real size.
 * - It outlives its session. The interactive shell outlives the sign-in, so
 *   the session ending means the user (or a host restart) closed it; an
 *   ordinary tab would silently drop here, which for a sign-in retracts the
 *   only surface that can restart it. This shows the ended state with a
 *   restart instead.
 *
 * Independent of the host's plain-terminal authority on purpose: the session
 * is manager-owned on every host capability, so the tile reads the same
 * `terminal.list` + `terminal.subscribe` path whether the host is legacy or
 * capable, and the capable reconciliation leaves this tab out of migration.
 */
export function LandingSignInTerminalTile(
  props: LandingTerminalTileProps,
): ReactNode {
  const { tab, landingPageId } = props;
  const providerId = tab.originProviderId ?? null;
  const reachability = useHostReachability(tab.hostId);
  const hostLoad = useBoundedHostLoad({
    hostId: tab.hostId,
    hostLabel: resolvedHostLabel(reachability),
    pending:
      reachability.status === "checking" ||
      reachability.status === "host-starting",
  });
  // Never dispatched (`adoptOnly`), and returning `null` is the bootstrap's
  // own "abort the create" answer should that ever change underneath.
  const preparePayload = useCallback(
    (): Promise<TerminalCreatePayload | null> => Promise.resolve(null),
    [],
  );
  const bootstrap = useTerminalTileBootstrap({
    hostId: tab.hostId,
    scope: INDEPENDENT_SCOPE,
    sessionId: tab.sessionId,
    instanceId: tab.instanceId,
    sessionKind: "terminal",
    preparePayload,
    adoptOnly: true,
  });
  // The attached exit is read from the stream (immediate), not from
  // `terminal.list` (60 s stale, never polled): between the shell exiting and
  // the next invalidation the list still says the session is live.
  const [exitedWhileAttached, setExitedWhileAttached] = useState(false);
  const handleExited = useCallback((): void => {
    setExitedWhileAttached(true);
  }, []);
  const removeTab = useRemoveExitedLandingTab(landingPageId);
  const closeSelf = useCallback((): void => {
    removeTab(tab.instanceId);
  }, [removeTab, tab.instanceId]);

  if (reachability.status === "unreachable") {
    return (
      <TerminalDeadState
        hostLabel={reachability.hostLabel}
        unavailability={reachability.unavailability}
      />
    );
  }
  if (hostLoad.kind !== "ready") {
    return (
      <TileHostLoadState
        load={hostLoad}
        subject="terminal"
        onRetry={null}
        testId="landing-terminal-load"
      />
    );
  }
  // The host has settled on "this session is gone" (absent, or exited and
  // never attached), or the attached stream saw it end.
  const sessionGone =
    exitedWhileAttached ||
    (bootstrap.handle === null &&
      (bootstrap.hostHasSession === false || bootstrap.hostSessionExited));
  if (sessionGone) {
    return (
      <LandingSignInTerminalEnded
        providerId={providerId}
        hostId={tab.hostId}
        landingPageId={landingPageId}
        sessionId={tab.sessionId}
        closeSelf={closeSelf}
      />
    );
  }
  if (bootstrap.handle === null) {
    // Same layout box as the live tile so the measurement probe measures the
    // real grid before the subscribe is dispatched.
    return (
      <div className="relative flex h-full min-h-0 w-full flex-col bg-canvas">
        <div className="relative min-h-0 flex-1">
          <TerminalGridMeasureProbe
            sessionId={tab.sessionId}
            hostId={tab.hostId}
            instanceId={tab.instanceId}
            tileKind="terminal"
            chrome="flush"
            onMeasured={bootstrap.reportMeasuredGrid}
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <TerminalLoadingSkeleton />
          </div>
        </div>
      </div>
    );
  }
  return (
    <LandingTerminalTileLive
      handle={bootstrap.handle}
      tab={tab}
      onExited={handleExited}
      authoritativeTerminal={null}
    />
  );
}

/**
 * Shown when the sign-in session is gone. The button restarts the sign-in
 * through the same RPC the picker's setup CTA uses, which hands back a fresh
 * terminal and retires this tab. `providerId` can be absent on a persisted
 * tab whose marker survived without its provider; the copy then points at
 * the picker rather than offering a button that cannot know what to restart.
 */
function LandingSignInTerminalEnded(props: {
  readonly providerId: ProviderId | null;
  readonly hostId: string;
  readonly landingPageId: string;
  readonly sessionId: string;
  readonly closeSelf: () => void;
}): ReactNode {
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 bg-canvas p-4 text-center text-ui-sm text-muted-foreground"
      data-testid="landing-sign-in-terminal-ended"
    >
      <span>Sign-in terminal ended.</span>
      {props.providerId === null ? (
        <span className="text-ui-xs">
          Start a new one from the model picker's setup prompt.
        </span>
      ) : (
        <LandingSignInRestartButton
          providerId={props.providerId}
          hostId={props.hostId}
          landingPageId={props.landingPageId}
          sessionId={props.sessionId}
        />
      )}
      <Button type="button" variant="ghost" size="sm" onClick={props.closeSelf}>
        Close
      </Button>
    </div>
  );
}

// Split out so the login hook is only instantiated where a provider is
// actually known - no placeholder id standing in for "we do not know".
function LandingSignInRestartButton(props: {
  readonly providerId: ProviderId;
  readonly hostId: string;
  readonly landingPageId: string;
  readonly sessionId: string;
}): ReactNode {
  const login = useLandingProviderTerminalLogin({
    providerId: props.providerId,
    hostId: props.hostId,
    landingPageId: props.landingPageId,
    // After a host restart the coordinator has no pointer, so it reports
    // `replacedSessionId: null` and nothing else would retire this dead tab -
    // it would accumulate one per press.
    launchedFromSessionId: props.sessionId,
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={login.isPending}
      onClick={login.start}
    >
      Start again
      {login.isPending ? <MutedAgentSpinner /> : null}
    </Button>
  );
}
