import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabTileProps } from "@/components/browser-tile/browser-tab-tile";
import type { LandingBrowserTabRef } from "@/stores/home/landing-panel-store";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { LandingBrowserTile } from "../landing-browser-tile";

const captured = vi.hoisted<{
  props: BrowserTabTileProps | null;
  /** The host the tile put on a browser-sessions stream, `null` for none. */
  sessionsHostId: string | null;
}>(() => ({ props: null, sessionsHostId: null }));

vi.mock("@/components/browser-tile/browser-tab-tile", () => ({
  BrowserTabTile: (props: BrowserTabTileProps) => {
    captured.props = props;
    return <div data-testid="browser-tab-tile-stub" />;
  },
}));

// Pass-throughs: this suite is testing the adapter's translation of props,
// not the host/session machinery those providers own.
vi.mock("@/components/epic-canvas/tab-host-provider", () => ({
  TabHostProvider: (props: { readonly children: ReactNode }) => props.children,
}));

// All four real exports are stubbed, not just the one this file imports - a
// factory REPLACES the whole module, so any other importer reaching a
// missing export in this same test run would fail at module init rather
// than at an assertion.
vi.mock("@/components/epic-canvas/renderers/browser-sessions-provider", () => ({
  BrowserSessionsProvider: (props: { readonly children: ReactNode }) =>
    props.children,
  BrowserSessionsHostProvider: (props: {
    readonly hostId: string | null;
    readonly children: ReactNode;
  }) => {
    captured.sessionsHostId = props.hostId;
    return props.children;
  },
  BrowserSessionsHostBoundary: (props: { readonly children: ReactNode }) =>
    props.children,
  BrowserSessionsSnapshotProvider: (props: { readonly children: ReactNode }) =>
    props.children,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
  useHostDirectoryEntryForHostId: () => null,
}));

const TAB: LandingBrowserTabRef = {
  kind: "browser",
  instanceId: "instance-1",
  sessionId: "session-1",
  hostId: "host-1",
  tabId: "tab-1",
  name: "Example",
  titleSource: "default",
};

function tileElement(
  overrides: Partial<ComponentProps<typeof LandingBrowserTile>>,
): ReactElement {
  return (
    <LandingBrowserTile
      landingPageId="landing-1"
      tab={TAB}
      active
      panelOpen
      onRequestClose={() => undefined}
      onOpenLinkInNewTile={() => undefined}
      onRequestNewTab={() => undefined}
      {...overrides}
    />
  );
}

describe("<LandingBrowserTile />", () => {
  beforeEach(() => {
    captured.props = null;
    captured.sessionsHostId = null;
  });

  afterEach(() => {
    cleanup();
  });

  // A browser-sessions stream is a socket, a relay attach, a desktop identity
  // attestation and a contributed-set replay, and the desktop caps a window's
  // streams and refuses whichever is asked for LAST. A tile in a collapsed
  // panel or a backgrounded Start Page shows nothing, so it must not be the
  // reason a visible tile's device is the one refused.
  //
  // Two terms, not the three the `visible` prop takes: `active` is left out on
  // purpose, because the strip renders a row for EVERY tab and those rows read
  // their title and dormancy from this inventory.
  it.each([
    [true, true, "host-1"],
    [true, false, null],
    [false, true, null],
    [false, false, null],
  ])(
    "holds a stream with panelOpen=%s paneVisible=%s: %s",
    (panelOpen, paneVisible, expected) => {
      render(
        <PaneVisibilityContext.Provider value={paneVisible}>
          {tileElement({ panelOpen, active: false })}
        </PaneVisibilityContext.Provider>,
      );

      expect(captured.sessionsHostId).toBe(expected);
    },
  );

  // The inactive tab's device is still on the stream: its strip row is on
  // screen and reads from this inventory.
  it("holds a stream for a tab that is not the active one", () => {
    render(
      <PaneVisibilityContext.Provider value>
        {tileElement({ active: false, panelOpen: true })}
      </PaneVisibilityContext.Provider>,
    );

    expect(captured.sessionsHostId).toBe("host-1");
  });

  it("translates placement to the landing kind with this tile's own page id", () => {
    render(tileElement({ landingPageId: "landing-42" }));

    expect(captured.props?.placement).toEqual({
      kind: "landing",
      landingPageId: "landing-42",
    });
  });

  it("uses the tab's instanceId as the pageSessionId", () => {
    render(tileElement({ tab: { ...TAB, instanceId: "distinct-instance" } }));

    expect(captured.props?.pageSessionId).toBe("distinct-instance");
  });

  it("never offers viewport persistence or picture-in-picture from the Start Page", () => {
    render(tileElement({}));

    expect(captured.props?.persistViewportPreset).toBeNull();
    expect(captured.props?.onConvertToPip).toBeNull();
  });

  // Pane activation is a canvas concept. The panel shows one tab at a time in
  // a surface with no panes, so there is nothing for the native view taking
  // focus to claim - and the capability is declined rather than pointed at
  // something that would do nothing.
  it("claims no pane activation when the native view takes focus", () => {
    render(tileElement({}));

    expect(captured.props?.onNativeTileFocused).toBeNull();
  });

  // Three terms, not two. `paneVisible` is the one a DOM assertion cannot
  // reach: the panel stays mounted behind a backgrounded header tab to keep its
  // PTYs warm, and a browser tile's pixels are native, so without it a
  // backgrounded Start Page keeps painting a browser view over whatever epic
  // the reader switched to. The prop is the only guard there is.
  it.each([
    [true, true, true, true],
    [true, false, true, false],
    [false, true, true, false],
    [false, false, true, false],
    [true, true, false, false],
  ] as const)(
    "is visible only when active AND panelOpen AND the pane is visible (active=%s panelOpen=%s paneVisible=%s -> visible=%s)",
    (active, panelOpen, paneVisible, expectedVisible) => {
      render(
        <PaneVisibilityContext.Provider value={paneVisible}>
          {tileElement({ active, panelOpen })}
        </PaneVisibilityContext.Provider>,
      );

      expect(captured.props?.visible).toBe(expectedVisible);
    },
  );

  it("passes a non-null onRequestNewTab that calls back into the adapter's own handler", () => {
    const onRequestNewTab = vi.fn<() => void>();
    render(tileElement({ onRequestNewTab }));

    expect(captured.props?.onRequestNewTab).not.toBeNull();
    captured.props?.onRequestNewTab?.();

    expect(onRequestNewTab).toHaveBeenCalledOnce();
  });

  /**
   * The native surface keys its surface-attach effect on a tile key derived
   * from `placement` and `node`, so a fresh object per render would detach
   * and re-attach the native view every render, silently.
   */
  it("keeps placement and node referentially stable across a rerender with unchanged fields", () => {
    const view = render(tileElement({}));
    const firstPlacement = captured.props?.placement;
    const firstNode = captured.props?.node;
    expect(firstPlacement).not.toBeNull();
    expect(firstNode).not.toBeNull();

    view.rerender(tileElement({}));

    expect(captured.props?.placement).toBe(firstPlacement);
    expect(captured.props?.node).toBe(firstNode);
  });
});
