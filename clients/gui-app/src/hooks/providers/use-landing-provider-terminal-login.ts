import { useCallback, useRef } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  useProvidersStartTerminalLoginForClient,
  type StartTerminalLoginMutationResult,
} from "@/hooks/providers/use-providers-start-terminal-login-mutation";
import { openLandingSignInTerminal } from "@/lib/terminals/landing-sign-in-terminal";

/** `start` takes the start page to open into, resolved by the caller AT PRESS TIME rather than held as a hook argument: an unbound start page has to be bound (its draft minted) before it has a panel to open into, and doing that during render would mint a draft for merely showing the button. */
export type LandingProviderTerminalLoginStarter =
  StartTerminalLoginMutationResult<string | null> & {
    readonly start: (landingPageId: string) => void;
  };

/** Independent-scope terminal sign-in on the picker's run-target host. */
export function useLandingProviderStartTerminalLogin(args: {
  readonly providerId: ProviderId;
  readonly hostId: string | null;
  /** The dead sign-in tab this gesture was launched FROM (its "Start again" button), retired on success unless the host already reported it as the replaced session. */
  readonly launchedFromSessionId: string | null;
}): LandingProviderTerminalLoginStarter {
  const { providerId, hostId, launchedFromSessionId } = args;
  const client = useHostClientForHostId(hostId);
  // Press order. `start` pushes, the capture below shifts; TanStack runs each
  // mutation's `onMutate` in the order the `mutate()`s were called.
  const queuedLandingPageIdsRef = useRef<string[]>([]);

  const onSuccess = useCallback(
    (
      result: {
        readonly sessionId: string;
        readonly replacedSessionId: string | null;
      },
      _variables: unknown,
      // NOT the client's current host: the landing composer's target host can move while the call is in flight, which re-points `client` underneath and would file the new session against the wrong machine - or discard it when that client is now null - leaving a live sign-in terminal that no tab points at.
      requestHostId: string | null,
      // The page THIS press bound, dequeued for this request.
      landingPageId: string | null,
    ): void => {
      if (requestHostId === null || landingPageId === null) return;
      openLandingSignInTerminal({
        landingPageId,
        hostId: requestHostId,
        providerId,
        sessionId: result.sessionId,
        replacedSessionId: result.replacedSessionId,
        launchedFromSessionId,
      });
    },
    [launchedFromSessionId, providerId],
  );

  const startTerminalLogin = useProvidersStartTerminalLoginForClient(
    client,
    onSuccess,
    // One dequeue per request. `null` only if `mutate` was reached without
    // `start`, which nothing does; the open then skips rather than guessing.
    (): string | null => queuedLandingPageIdsRef.current.shift() ?? null,
  );

  const start = useCallback(
    (landingPageId: string): void => {
      queuedLandingPageIdsRef.current.push(landingPageId);
      startTerminalLogin.mutate({
        providerId,
        scope: { kind: "independent" },
        // An initial size only; the panel tile resizes on mount. Same fixed
        // geometry the epic hook sends, for the same reason.
        cols: 80,
        rows: 24,
      });
    },
    [providerId, startTerminalLogin],
  );

  return { ...startTerminalLogin, start };
}
