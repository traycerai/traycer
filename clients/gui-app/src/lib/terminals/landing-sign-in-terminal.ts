import { v4 as uuidv4 } from "uuid";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";
import { useTabsStore } from "@/stores/tabs/store";
import {
  selectHostActiveSurfaceRefs,
  selectHostFocusedRef,
} from "@/stores/tabs/selectors";
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
    // Manual, so reconciliation never overwrites it from the session's own
    // title - the host names the session the same way, but a default title
    // would fall back to the cwd the moment the title were cleared.
    titleSource: "manual",
    origin: "provider-login",
    originProviderId: providerId,
  });
  // Both the page this started from and the one actually hosting the panel
  // right now. They differ when focus moved while the host was answering (to
  // another draft, or to an epic and back to a different start page): there is
  // ONE panel per window and it is portaled into the hosted page's anchor, so
  // opening only the initiating page's layout leaves a live sign-in terminal -
  // and the code that only exists in it - behind a closed panel. Tabs are
  // shared across landing pages, so the tab is already there to show; the open
  // flag is the only per-page part. The initiating page is still opened so the
  // panel is up when the user returns to it.
  for (const pageId of new Set([landingPageId, hostedLandingPageId()])) {
    if (pageId !== null) store.setPanelOpen(pageId, true);
  }
  const activeInstanceId = useLandingTerminalStore.getState().activeInstanceId;
  if (activeInstanceId !== null) focusTerminalInstance(activeInstanceId);
}

/**
 * The start page whose anchor the single landing panel is portaled into, or
 * `null` when no start page is in play (the user is on an epic tab). The same
 * resolution `LandingTerminalHost` binds to, read outside React because this
 * runs from a mutation's `onSuccess`.
 */
function hostedLandingPageId(): string | null {
  const state = useTabsStore.getState();
  const focused = selectHostFocusedRef(state);
  if (focused?.kind === "draft") return focused.id;
  return (
    selectHostActiveSurfaceRefs(state).find((ref) => ref.kind === "draft")
      ?.id ?? null
  );
}
