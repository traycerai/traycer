import { useCallback } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useProvidersStartTerminalLoginForClient } from "@/hooks/providers/use-providers-start-terminal-login-mutation";
import { useFocusEpicTerminalSession } from "@/components/epic-canvas/renderers/chat-tile-focus-terminal";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";

/**
 * The tile's `cwd` is display-only for a sign-in terminal: the host chose the
 * working directory (the user's home) when it created the PTY, and this tile
 * never runs `terminal.create`, so there is nothing for a real path to feed.
 * `"~"` reads correctly and satisfies the ref schema's non-empty requirement.
 */
const SIGN_IN_TERMINAL_CWD = "~";

export interface ProviderTerminalLoginStarter {
  readonly start: () => void;
  readonly isPending: boolean;
}

/**
 * Runs the whole terminal sign-in gesture: ask the host for a fresh sign-in
 * terminal, retire the one it replaced, and put the new one in front of the
 * user in THIS view.
 *
 * Ordering is deliberate. Closing the replaced tile first and opening second is
 * one synchronous store sequence, so the close cannot land after the open; and
 * the terminal registry is keyed by tile `instanceId`, not by session id, so
 * closing the predecessor cannot touch the new tile's stream state. Focusing
 * (rather than opening in the background) is what makes the button feel like it
 * did something - the user has to READ this terminal, it is the only place the
 * device code exists.
 */
export function useProviderTerminalLogin(args: {
  readonly providerId: ProviderId;
  readonly epicId: string | null;
  readonly viewTabId: string | null;
}): ProviderTerminalLoginStarter {
  const { providerId, epicId, viewTabId } = args;
  const tabClient = useTabHostClient();
  const startTerminalLogin = useProvidersStartTerminalLoginForClient(tabClient);
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

  const start = useCallback((): void => {
    if (epicId === null || viewTabId === null) return;
    startTerminalLogin.mutate(
      {
        providerId,
        epicId,
        // The host resizes to these while the shell's output is still
        // buffered, so its first redraw is correctly sized. A concrete size
        // beats guessing: the tile resizes itself on mount anyway.
        cols: 80,
        rows: 24,
      },
      {
        onSuccess: (result) => {
          if (result.replacedSessionId !== null) {
            const replaced = findOpenArtifactInTab(
              viewTabId,
              result.replacedSessionId,
            );
            if (replaced !== null) {
              // Its own `navigateNested` rather than one composed with the
              // open below: `prepare` runs synchronously inside the call, so
              // the close still lands before the open, and the open's target -
              // committed second - is the one the route ends on.
              navigateNested(epicId, viewTabId, () =>
                prepareCloseCanvasTabFocusTarget(
                  viewTabId,
                  replaced.paneId,
                  replaced.instanceId,
                ),
              );
            }
          }
          focusTerminal(result.sessionId, SIGN_IN_TERMINAL_CWD, {
            name: `${PROVIDER_DISPLAY_NAMES[providerId]} sign-in`,
            origin: "provider-login",
            originProviderId: providerId,
          });
        },
      },
    );
  }, [
    epicId,
    focusTerminal,
    navigateNested,
    prepareCloseCanvasTabFocusTarget,
    providerId,
    startTerminalLogin,
    viewTabId,
  ]);

  return { start, isPending: startTerminalLogin.isPending };
}
