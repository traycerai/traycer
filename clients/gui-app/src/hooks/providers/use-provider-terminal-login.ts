import { useCallback } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  useProvidersStartTerminalLoginForClient,
  type StartTerminalLoginMutationResult,
} from "@/hooks/providers/use-providers-start-terminal-login-mutation";
import { useFocusEpicTerminalSession } from "@/components/epic-canvas/renderers/chat-tile-focus-terminal";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { recordProviderLoginTerminal } from "@/stores/providers/provider-login-terminals";

/** The tile's `cwd` is display-only for a sign-in terminal: the host chose the working directory (the user's home) when it created the PTY, and this tile never runs `terminal.create`, so there is nothing for a real path to feed. */
const SIGN_IN_TERMINAL_CWD = "~";

/**
 * Full mutation result plus `start`, so consumers can read `error`/`status`/`reset` without a second hook.
 */
export type ProviderTerminalLoginStarter =
  StartTerminalLoginMutationResult<undefined> & {
    readonly start: () => void;
  };

/** Do not call from a surface whose composer host differs from the tab. */
export function useProviderTerminalLogin(args: {
  readonly providerId: ProviderId;
  readonly epicId: string | null;
  readonly viewTabId: string | null;
  /**
   * Close the launching tile on success unless the host already reported it as the replaced session. `replacedSessionId: null` after restart would otherwise leave the dead panel offering Start again.
   */
  readonly launchedFromTile: {
    readonly sessionId: string;
    readonly close: () => void;
  } | null;
}): ProviderTerminalLoginStarter {
  const { providerId, epicId, viewTabId, launchedFromTile } = args;
  const tabClient = useTabHostClient();
  const hostId = useTabHostId();
  // The hook needs a tab id at call time; outside an epic view there is no
  // terminal surface to open into, and `start` below refuses before using it.
  const focusTerminal = useFocusEpicTerminalSession(viewTabId ?? "");
  const navigateNested = useEpicNestedFocusNavigation();
  // The `prepare...FocusTarget` variant, not the raw `closeCanvasTab`: a close
  // moves focus, and a focus move that never reaches the route is re-applied
  // from the stale route on the next sync.
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );

  const onSuccess = useCallback(
    (result: {
      readonly sessionId: string;
      readonly replacedSessionId: string | null;
    }): void => {
      if (epicId === null || viewTabId === null) return;
      // Recorded before any tile exists, and independently of one: every path
      // that can later reopen this session (sidebar, command palette, drag)
      // builds its ref from `terminal.list`, which carries no origin.
      recordProviderLoginTerminal({
        hostId,
        sessionId: result.sessionId,
        providerId,
      });
      if (result.replacedSessionId !== null) {
        const replaced = findOpenArtifactInTab(
          viewTabId,
          result.replacedSessionId,
        );
        if (replaced !== null) {
          // Its own `navigateNested` rather than one composed with the open below: `prepare` runs synchronously inside the call, so the close still lands before the open, and the open's target - committed second - is the one the route ends on.
          navigateNested(epicId, viewTabId, () =>
            prepareCloseCanvasTabFocusTarget(
              viewTabId,
              replaced.paneId,
              replaced.instanceId,
            ),
          );
        }
      }
      if (
        launchedFromTile !== null &&
        launchedFromTile.sessionId !== result.replacedSessionId
      ) {
        launchedFromTile.close();
      }
      focusTerminal(result.sessionId, SIGN_IN_TERMINAL_CWD, {
        name: `${PROVIDER_DISPLAY_NAMES[providerId]} sign-in`,
        origin: "provider-login",
        originProviderId: providerId,
      });
    },
    [
      epicId,
      focusTerminal,
      hostId,
      launchedFromTile,
      navigateNested,
      prepareCloseCanvasTabFocusTarget,
      providerId,
      viewTabId,
    ],
  );

  const startTerminalLogin = useProvidersStartTerminalLoginForClient<undefined>(
    tabClient,
    onSuccess,
    undefined,
  );

  const start = useCallback((): void => {
    if (epicId === null || viewTabId === null) return;
    startTerminalLogin.mutate({
      providerId,
      scope: { kind: "epic", epicId },
      // The host resizes to these while the shell's output is still buffered,
      // so its first redraw is correctly sized. A concrete size beats guessing:
      // the tile resizes itself on mount anyway.
      cols: 80,
      rows: 24,
    });
  }, [epicId, providerId, startTerminalLogin, viewTabId]);

  return { ...startTerminalLogin, start };
}
