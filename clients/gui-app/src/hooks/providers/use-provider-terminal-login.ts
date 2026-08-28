import { useCallback } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useProvidersStartTerminalLoginForClient } from "@/hooks/providers/use-providers-start-terminal-login-mutation";
import { useFocusEpicTerminalSession } from "@/components/epic-canvas/renderers/chat-tile-focus-terminal";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { recordProviderLoginTerminal } from "@/stores/providers/provider-login-terminals";

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
 * Ordering is deliberate. Closing the retired tiles first and opening second is
 * one synchronous store sequence, so a close cannot land after the open; and
 * the terminal registry is keyed by tile `instanceId`, not by session id, so
 * closing a predecessor cannot touch the new tile's stream state. Focusing
 * (rather than opening in the background) is what makes the button feel like it
 * did something - the user has to READ this terminal, it is the only place the
 * device code exists.
 *
 * All of it hangs off the MUTATION's `onSuccess`, not a per-`mutate` one: this
 * call has a host-side effect (a PTY is created, the previous one killed), so
 * a caller that unmounts mid-flight - a canvas tab switch, a host-binding blip
 * that unmounts the banner - must not be able to leave a live sign-in terminal
 * with no tile in front of it.
 */
export function useProviderTerminalLogin(args: {
  readonly providerId: ProviderId;
  readonly epicId: string | null;
  readonly viewTabId: string | null;
  /**
   * The tile this gesture was launched FROM, when it was launched from one (the
   * "Start again" button on a dead sign-in tile). Closed on success unless the
   * host already reported it as the replaced session.
   *
   * The host reports `replacedSessionId: null` whenever its pointer map has no
   * predecessor - after a host restart, which is exactly when the user is
   * looking at a dead tile and pressing "Start again". Without this the dead
   * panel stays open beside the new terminal, still offering "Start again", and
   * every press adds another tile.
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
          // Provider-login terminals are host-spawned and import-exempt, so
          // their presentation close is always local. Its own `navigateNested`
          // rather than one composed with the open below: `prepare` runs
          // synchronously inside the call, so the close still lands before the
          // open, and the open's target - committed second - is the one the
          // route ends on.
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

  const startTerminalLogin = useProvidersStartTerminalLoginForClient(
    tabClient,
    onSuccess,
  );

  const start = useCallback((): void => {
    if (epicId === null || viewTabId === null) return;
    startTerminalLogin.mutate({
      providerId,
      epicId,
      // The host resizes to these while the shell's output is still buffered,
      // so its first redraw is correctly sized. A concrete size beats guessing:
      // the tile resizes itself on mount anyway.
      cols: 80,
      rows: 24,
    });
  }, [epicId, providerId, startTerminalLogin, viewTabId]);

  return { start, isPending: startTerminalLogin.isPending };
}
