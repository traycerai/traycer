import { useCallback } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useProvidersStartTerminalLoginForClient } from "@/hooks/providers/use-providers-start-terminal-login-mutation";
import type { ProviderTerminalLoginStarter } from "@/hooks/providers/use-provider-terminal-login";
import { openLandingSignInTerminal } from "@/lib/terminals/landing-sign-in-terminal";

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
 *
 * Against an old host that only speaks `providers.startTerminalLogin@1.0`
 * the client's downgrade path refuses the independent scope as
 * `DOWNGRADE_UNSUPPORTED`; the mutation's error toast reports it, and the
 * guidance's manual command remains the way through.
 */
export function useLandingProviderTerminalLogin(args: {
  readonly providerId: ProviderId;
  readonly hostId: string | null;
  readonly landingPageId: string;
  /**
   * The dead sign-in tab this gesture was launched FROM (its "Start again"
   * button), retired on success unless the host already reported it as the
   * replaced session. After a host restart the coordinator has no pointer,
   * so it reports `replacedSessionId: null` and nothing else would retire the
   * dead tab - every press would add another.
   */
  readonly launchedFromSessionId: string | null;
}): ProviderTerminalLoginStarter {
  const { providerId, hostId, landingPageId, launchedFromSessionId } = args;
  const client = useHostClientForHostId(hostId);

  const onSuccess = useCallback(
    (result: {
      readonly sessionId: string;
      readonly replacedSessionId: string | null;
    }): void => {
      // The client that answered names the host the PTY lives on - read from
      // it rather than from `hostId`, which is `null` while following the
      // app-wide default.
      const resolvedHostId = client?.getActiveHostId() ?? null;
      if (resolvedHostId === null) return;
      openLandingSignInTerminal({
        landingPageId,
        hostId: resolvedHostId,
        providerId,
        sessionId: result.sessionId,
        replacedSessionId: result.replacedSessionId,
        launchedFromSessionId,
      });
    },
    [client, landingPageId, launchedFromSessionId, providerId],
  );

  const startTerminalLogin = useProvidersStartTerminalLoginForClient(
    client,
    onSuccess,
  );

  const start = useCallback((): void => {
    startTerminalLogin.mutate({
      providerId,
      scope: { kind: "independent" },
      // An initial size only; the panel tile resizes on mount. Same fixed
      // geometry the epic hook sends, for the same reason.
      cols: 80,
      rows: 24,
    });
  }, [providerId, startTerminalLogin]);

  return { start, isPending: startTerminalLogin.isPending };
}
