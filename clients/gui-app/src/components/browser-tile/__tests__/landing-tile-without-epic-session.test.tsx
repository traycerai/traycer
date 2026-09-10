import "../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectronTabSurface } from "@/components/browser-tile/agent-browser-tile";
import type { ElectronTabBinding } from "@/lib/browser-view/sessions/electron-tab-directory";

/**
 * The shared tile body must mount with NO `<EpicSessionProvider>` above it.
 *
 * A Start Page browser tab belongs to no epic, so `LandingBrowserTile` renders
 * this same body under a `landing` placement at the app shell, outside every
 * epic session. It used to throw `useOpenEpicHandle must be called inside
 * <EpicSessionProvider>` from the annotation route's chat picker and take the
 * whole window to the root error boundary - not just the tile.
 *
 * This suite deliberately does NOT mock `useBrowserAnnotationSession`. Every
 * other tile suite does, which is precisely why a full green CI said nothing
 * about this path: the crash lived in the hook the mock replaced. Mock it here
 * and this test stops testing anything.
 */
vi.mock("@/providers/use-runner-host", async (load) => {
  const actual = await load<typeof import("@/providers/use-runner-host")>();
  return { ...actual, useRunnerHost: () => ({ browserView: null }) };
});
vi.mock("@/lib/browser-view/tiles/visible-tile-registry", async (load) => {
  const actual =
    await load<
      typeof import("@/lib/browser-view/tiles/visible-tile-registry")
    >();
  return { ...actual, useRegisterVisibleBrowserTile: () => undefined };
});
vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useMaybeBrowserSessionsContext: () => null,
}));
vi.mock("@/components/browser-tile/browser-start-page", () => ({
  BrowserStartPage: () => <div>Local servers</div>,
}));

const NODE = {
  instanceId: "tile-1",
  hostId: "host-1",
  sessionId: "session-1",
  url: "https://example.com/",
  viewportPreset: "responsive",
} as const;

function binding(): ElectronTabBinding {
  return {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId: "registration-1",
    control: vi.fn(() => Promise.resolve()),
    bindSurface: () => Promise.resolve({ detach: () => Promise.resolve() }),
  };
}

function renderLandingSurface(): void {
  render(
    <ElectronTabSurface
      node={NODE}
      binding={binding()}
      placement={{ kind: "landing", landingPageId: "landing-1" }}
      visible
      pageSessionId="browser-session:session-1:tab-1"
      onRequestClose={() => undefined}
      persistViewportPreset={null}
      onOpenLinkInNewTile={null}
      onRequestNewTab={null}
      onConvertToPip={null}
      onNativeTileFocused={null}
    />,
  );
}

describe("native browser tile outside an epic session", () => {
  afterEach(() => {
    cleanup();
  });

  it("mounts under a landing placement with no EpicSessionProvider", () => {
    expect(() => {
      renderLandingSurface();
    }).not.toThrow();
  });

  it("renders the tile body rather than falling through to an error", () => {
    renderLandingSurface();
    expect(
      screen.getByTestId(`agent-browser-tile-${NODE.instanceId}`),
    ).toBeTruthy();
  });
});
