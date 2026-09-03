import { useMemo, type ReactNode } from "react";
import { BrowserTabTile } from "@/components/browser-tile/browser-tab-tile";
import type {
  BrowserTileNode,
  BrowserTilePlacement,
} from "@/components/browser-tile/browser-tile-placement";
import { BrowserSessionsHostProvider } from "@/components/epic-canvas/renderers/browser-sessions-provider";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { DEFAULT_BROWSER_VIEWPORT_PRESET } from "@/lib/browser-view/browser-tile-defaults";
import type { LandingBrowserTabRef } from "@/stores/home/landing-panel-store";
import { INDEPENDENT_BROWSER_SCOPE } from "./use-landing-browser-reconciliation";

/**
 * The Start Page adapter for the shared browser tab tile - the sibling of
 * {@link BrowserSessionTile}, translating panel facts into the same props.
 *
 * It mounts its own `BrowserSessionsHostProvider` rather than reading one from
 * above, because the panel's tabs can name DIFFERENT devices and a provider is
 * per host. Both this and the fleet's arm acquire the refcounted coordinator by
 * the same `{independent, host, identity}` key, so a window opens one stream per
 * device however many tiles are mounted on it.
 */
export function LandingBrowserTile(props: {
  readonly landingPageId: string;
  readonly tab: LandingBrowserTabRef;
  readonly active: boolean;
  readonly panelOpen: boolean;
  readonly onRequestClose: () => void;
  /** Opens a tab in THIS tab's session, beside it in the panel. */
  readonly onOpenLinkInNewTile: (
    url: string,
    disposition: "foreground" | "background",
  ) => void;
  /** The guest's own new-tab chord. */
  readonly onRequestNewTab: () => void;
}): ReactNode {
  return (
    <TabHostProvider hostId={props.tab.hostId}>
      <LandingBrowserTileSessions
        landingPageId={props.landingPageId}
        tab={props.tab}
        active={props.active}
        panelOpen={props.panelOpen}
        onRequestClose={props.onRequestClose}
        onOpenLinkInNewTile={props.onOpenLinkInNewTile}
        onRequestNewTab={props.onRequestNewTab}
      />
    </TabHostProvider>
  );
}

function LandingBrowserTileSessions(props: {
  readonly landingPageId: string;
  readonly tab: LandingBrowserTabRef;
  readonly active: boolean;
  readonly panelOpen: boolean;
  readonly onRequestClose: () => void;
  readonly onOpenLinkInNewTile: (
    url: string,
    disposition: "foreground" | "background",
  ) => void;
  readonly onRequestNewTab: () => void;
}): ReactNode {
  const hostClient = useHostClientForHostId(props.tab.hostId);
  // Read here rather than in the body below, because it decides whether this
  // tile puts its device on a stream AT ALL - and the provider is what would
  // acquire it.
  const paneVisible = usePaneVisible();
  return (
    <BrowserSessionsHostProvider
      // `null` holds no stream. A tile in a collapsed panel or a backgrounded
      // Start Page renders nothing, and the desktop caps a window's browser
      // streams and refuses the one asked for last - so a tile nobody can see
      // must not be the reason a visible one is refused. The panel's own arm
      // follows the same rule, and both share the refcounted coordinator, so
      // this only releases when that one has too.
      //
      // Deliberately NOT narrowed to `props.active`: the strip renders a row
      // for every tab, and those rows read their title and dormancy from this
      // inventory.
      hostId={props.panelOpen && paneVisible ? props.tab.hostId : null}
      hostClient={hostClient}
      scope={INDEPENDENT_BROWSER_SCOPE}
    >
      <LandingBrowserTileBody
        landingPageId={props.landingPageId}
        tab={props.tab}
        active={props.active}
        panelOpen={props.panelOpen}
        onRequestClose={props.onRequestClose}
        onOpenLinkInNewTile={props.onOpenLinkInNewTile}
        onRequestNewTab={props.onRequestNewTab}
      />
    </BrowserSessionsHostProvider>
  );
}

function LandingBrowserTileBody(props: {
  readonly landingPageId: string;
  readonly tab: LandingBrowserTabRef;
  readonly active: boolean;
  readonly panelOpen: boolean;
  readonly onRequestClose: () => void;
  readonly onOpenLinkInNewTile: (
    url: string,
    disposition: "foreground" | "background",
  ) => void;
  readonly onRequestNewTab: () => void;
}): ReactNode {
  // Stable identities, for the same reason the canvas adapter memoizes: the
  // native surface derives its tile key and binding id from these, and its
  // surface-attach effect is keyed on that tile key. A fresh object per render
  // would detach and re-attach the native view every render, silently.
  // The panel outlives its start page's ACTIVATION - it stays mounted behind a
  // backgrounded header tab so the terminals beside this keep their PTYs. A
  // browser tile's pixels are NATIVE and painted over the window by the
  // desktop, so "mounted" is nowhere near enough to call it visible: without
  // this term a backgrounded Start Page would keep a browser view painting on
  // top of whatever epic the reader switched to.
  const paneVisible = usePaneVisible();
  const placement = useMemo<BrowserTilePlacement>(
    () => ({ kind: "landing", landingPageId: props.landingPageId }),
    [props.landingPageId],
  );
  const node = useMemo<BrowserTileNode>(
    () => ({
      instanceId: props.tab.instanceId,
      hostId: props.tab.hostId,
      sessionId: props.tab.sessionId,
      tabId: props.tab.tabId,
      // The panel does not persist a viewport choice (`persistViewportPreset`
      // is null below), so every tile opens on the default and a change lasts
      // as long as the tile does.
      viewportPreset: DEFAULT_BROWSER_VIEWPORT_PRESET,
    }),
    [
      props.tab.instanceId,
      props.tab.hostId,
      props.tab.sessionId,
      props.tab.tabId,
    ],
  );
  return (
    <BrowserTabTile
      placement={placement}
      node={node}
      // On screen means this tab is the active one, in an open panel, on a
      // visible pane. The panel keeps every tab mounted and hides the inactive
      // ones, so mounting is not visibility on any of the three axes.
      visible={props.active && paneVisible ? props.panelOpen : false}
      // The panel has no second page-session axis: one tab is one tile for as
      // long as it exists, so its instance id IS the page session.
      pageSessionId={props.tab.instanceId}
      onRequestClose={props.onRequestClose}
      persistViewportPreset={null}
      onOpenLinkInNewTile={props.onOpenLinkInNewTile}
      onRequestNewTab={props.onRequestNewTab}
      // No PiP from the Start Page: `convertBrowserTabToPip` routes through an
      // epic's canvas, and a panel tab belongs to no epic.
      onConvertToPip={null}
    />
  );
}
