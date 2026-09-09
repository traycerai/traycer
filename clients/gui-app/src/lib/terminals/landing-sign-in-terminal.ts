import { v4 as uuidv4 } from "uuid";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import { landingPaneAnchorDraftIds } from "@/components/home/terminal-panel/landing-pane-anchor-store";
import { recordProviderLoginTerminal } from "@/stores/providers/provider-login-terminals";
import { focusTerminalInstance } from "@/lib/terminals/terminal-focus-registry";

/**
 * The tab's `cwd` is display-only for a sign-in terminal: the host chose the
 * working directory (the user's home) when it created the PTY, and this tab
 * never runs a create, so there is nothing for a real path to feed. `"~"`
 * reads correctly and satisfies the persisted ref's non-empty requirement -
 * the same value the epic sign-in tile carries.
 */
const SIGN_IN_TERMINAL_CWD = "~";

/**
 * Puts a host-created, independent-scope sign-in session in front of the
 * user in the landing terminal panel.
 *
 * Written straight into the landing terminal store rather than through the
 * panel's own creation path: that path MINTS a session for the host to create,
 * and gates on the host's plain-terminal authority because a tab persisted
 * without a create looks like legacy evidence. Neither applies here - the
 * session already exists, the host made it, and the `origin` marker is what
 * tells every reader (tile, reconciliation, migration) so.
 *
 * Ordering is deliberate and synchronous: retire the predecessors first, add
 * second, open third. `addTab` activates what it adds (or the existing tab for
 * the same session, so a retry that reached the host twice cannot produce two
 * tabs), and the focus request parks until the tile's xterm mounts.
 *
 * Retirement is a plain removal, never a tombstone: the host has already
 * killed the session it reports as replaced, and the tab this was launched
 * from is dead by definition (that is what showed the restart button). A
 * tombstone would send `terminal.kill` for a session the host no longer has.
 */
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
  // Recorded before any tab exists, and independently of one: a session
  // reopened from `terminal.list` by any other path builds its ref without an
  // origin, and this store is how that path learns not to create under the id.
  recordProviderLoginTerminal({ hostId, sessionId, providerId });
  const store = useLandingPanelStore.getState();
  for (const retired of [replacedSessionId, launchedFromSessionId]) {
    if (retired === null || retired === sessionId) continue;
    store.removeHostTerminal(hostId, retired);
  }
  store.addTab({
    kind: "terminal",
    instanceId: `landing-terminal-${uuidv4()}`,
    sessionId,
    hostId,
    cwd: SIGN_IN_TERMINAL_CWD,
    name: `${PROVIDER_DISPLAY_NAMES[providerId]} sign-in`,
    // Manual, so reconciliation never overwrites it from the session's own
    // title - the host names the session the same way, but a default title
    // would fall back to the cwd the moment the title were cleared.
    titleSource: "manual",
    origin: "provider-login",
    originProviderId: providerId,
  });
  // `addTab` activated the tab to show - the new one, or the existing tab for
  // the same session on a retry.
  const activeInstanceId = useLandingPanelStore.getState().activeInstanceId;
  if (activeInstanceId === null) return;
  // Opened as a REVEAL of that tab, never as an opening gesture: the panel
  // settles a gesture by re-targeting the launch cwd, and this tab's
  // display-only `"~"` matches none, so a gesture-open would spawn a bare
  // shell and put it in front of the sign-in code.
  //
  // The page this started from, plus every start page with a mounted panel
  // slot. They differ when focus moved while the host was answering: there is
  // ONE panel per window, portaled into whichever page `LandingTerminalHost`
  // resolves, so opening only the initiating page's layout leaves a live
  // sign-in terminal - and the code that only exists in it - behind a closed
  // panel. Tabs are shared across landing pages, so the tab is already there
  // to show; the open flag is the only per-page part.
  //
  // The whole anchor set rather than a re-derivation of the hosted page: that
  // resolution retains its previous answer through focus that is NOT a draft
  // (an epic tab), and that retained id lives in the host's React state, which
  // nothing outside it can read. Every id it can return is in this set, so
  // opening all of them covers the hosted one without guessing which it is.
  //
  // No pane mounted at all means none of those ids names a surface the user
  // can see this on right now - and `landingPageId` may not even name a live
  // start page: a draft bound at press time can be submitted or discarded
  // while the host is still answering, which is a window a picker press opens
  // by construction. The page-less reveal covers whichever start page mounts
  // next - one that already recorded a closed layout included - so the
  // terminal carrying the sign-in code is never left behind a panel with no
  // way to ask for it.
  const anchoredPageIds = landingPaneAnchorDraftIds();
  store.revealPanel({
    landingPageIds: [...new Set([landingPageId, ...anchoredPageIds])],
    everyPage: anchoredPageIds.length === 0,
    instanceId: activeInstanceId,
  });
  focusTerminalInstance(activeInstanceId);
}
