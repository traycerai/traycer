import { v4 as uuidv4 } from "uuid";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";
import { landingPaneAnchorDraftIds } from "@/components/home/terminal-panel/landing-pane-anchor-store";
import { recordProviderLoginTerminal } from "@/stores/providers/provider-login-terminals";
import { focusTerminalInstance } from "@/lib/terminals/terminal-focus-registry";

/**
 * The tab's `cwd` is display-only for a sign-in terminal: the host chose the working directory (the user's home) when it created the PTY, and this tab never runs a create, so there is nothing for a real path to feed.
 */
const SIGN_IN_TERMINAL_CWD = "~";

/** Puts a host-created, independent-scope sign-in session in front of the user in the landing terminal panel. */
export function openLandingSignInTerminal(args: {
  readonly landingPageId: string;
  readonly hostId: string;
  readonly providerId: ProviderId;
  readonly sessionId: string;
  readonly replacedSessionId: string | null;
  /** The dead sign-in tab a "Start again" was pressed on, if any. */
  readonly launchedFromSessionId: string | null;
}): void {
  const {
    landingPageId,
    hostId,
    providerId,
    sessionId,
    replacedSessionId,
    launchedFromSessionId,
  } = args;
  // Recorded before any tab exists, and independently of one: a session reopened from `terminal.list` by any other path builds its ref without an origin, and this store is how that path learns not to create under the id.
  recordProviderLoginTerminal({ hostId, sessionId, providerId });
  const store = useLandingTerminalStore.getState();
  for (const retired of [replacedSessionId, launchedFromSessionId]) {
    if (retired === null || retired === sessionId) continue;
    store.removeHostTerminal(hostId, retired);
  }
  store.addTab({
    instanceId: `landing-terminal-${uuidv4()}`,
    sessionId,
    hostId,
    cwd: SIGN_IN_TERMINAL_CWD,
    name: `${PROVIDER_DISPLAY_NAMES[providerId]} sign-in`,
    // Manual, so reconciliation never overwrites it from the session's own title - the host names the session the same way, but a default title would fall back to the cwd the moment the title were cleared.
    titleSource: "manual",
    origin: "provider-login",
    originProviderId: providerId,
  });
  // `addTab` activated the tab to show - the new one, or the existing tab for
  // the same session on a retry.
  const activeInstanceId = useLandingTerminalStore.getState().activeInstanceId;
  if (activeInstanceId === null) return;
  // Opened as a REVEAL of that tab, never as an opening gesture: the panel settles a gesture by re-targeting the launch cwd, and this tab's display-only `"~"` matches none, so a gesture-open would spawn a bare shell and put it in front of the sign-in code.
  const anchoredPageIds = landingPaneAnchorDraftIds();
  store.revealPanel({
    landingPageIds: [...new Set([landingPageId, ...anchoredPageIds])],
    everyPage: anchoredPageIds.length === 0,
    instanceId: activeInstanceId,
  });
  focusTerminalInstance(activeInstanceId);
}
