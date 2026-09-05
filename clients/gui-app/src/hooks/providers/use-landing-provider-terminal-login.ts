import { useCallback, useRef } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  useProvidersStartTerminalLoginForClient,
  type StartTerminalLoginMutationResult,
} from "@/hooks/providers/use-providers-start-terminal-login-mutation";
import { openLandingSignInTerminal } from "@/lib/terminals/landing-sign-in-terminal";

/**
 * The landing counterpart of `ProviderTerminalLoginStarter`. `start` takes the
 * start page to open into, resolved by the caller AT PRESS TIME rather than
 * held as a hook argument: an unbound start page has to be bound (its draft
 * minted) before it has a panel to open into, and doing that during render
 * would mint a draft for merely showing the button.
 */
export type LandingProviderTerminalLoginStarter =
  StartTerminalLoginMutationResult<string | null> & {
    readonly start: (landingPageId: string) => void;
  };

/**
 * The landing page's terminal sign-in gesture: ask the host for a fresh
 * sign-in terminal in the INDEPENDENT scope - the scope the landing terminal
 * panel lists - retire the one it replaced, and open the new one as a panel
 * tab. `useProviderTerminalLogin` is the epic counterpart; the two differ only
 * in where the session lands, which is decided by the scope on the wire.
 *
 * `hostId` is the picker's run-target host (`null` follows the app-wide
 * default, exactly as the landing composer's picker does), resolved to a
 * client here so the PTY is minted on the host the composer would run on.
 * That is also the host the panel binds the new tab to: a landing tab carries
 * its own `hostId` for life, so the panel can show it even while the panel's
 * active host is a different machine.
 *
 * The open runs from the MUTATION's `onSuccess`, not a per-`mutate` one, for
 * the same reason the epic hook's does: the picker closes on click, so the
 * button that started this is gone before the host answers, and a live
 * sign-in PTY with no tab in front of it is exactly the failure to avoid.
 * The target page reaches that callback through the mutation's own
 * `captureContext`: the id is only known once the press has bound the page,
 * and the mutation-level `onSuccess` cannot read a per-`mutate` variable.
 * `start` QUEUES the page and the capture dequeues it - one per request, in
 * press order - rather than reading "the current" page from a ref: two
 * presses on one instance before the first answer (a double click ahead of
 * the pending re-render) would otherwise open the first session on the
 * second page, and `onMutate` is not synchronous with `mutate()`, so even the
 * capture cannot trust a single slot.
 *
 * Against an old host that only speaks `providers.startTerminalLogin@1.0`
 * the client's downgrade path refuses the independent scope as
 * `DOWNGRADE_UNSUPPORTED`; the mutation's error toast reports it, and the
 * guidance's manual command remains the way through.
 */
export function useLandingProviderStartTerminalLogin(args: {
  readonly providerId: ProviderId;
  readonly hostId: string | null;
  /**
   * The dead sign-in tab this gesture was launched FROM (its "Start again"
   * button), retired on success unless the host already reported it as the
   * replaced session. After a host restart the coordinator has no pointer,
   * so it reports `replacedSessionId: null` and nothing else would retire the
   * dead tab - every press would add another.
   */
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
      // The host this request was SENT on, captured in `onMutate`. NOT the
      // client's current host: the landing composer's target host can move
      // while the call is in flight, which re-points `client` underneath and
      // would file the new session against the wrong machine - or discard it
      // when that client is now null - leaving a live sign-in terminal that no
      // tab points at. `hostId` (the hook argument) is no good either: it is
      // `null` while following the app-wide default.
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
