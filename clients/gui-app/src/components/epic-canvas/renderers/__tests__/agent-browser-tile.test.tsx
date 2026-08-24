import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ElectronTabSurface,
  type ElectronTabSurfaceNode,
} from "@/components/epic-canvas/renderers/agent-browser-tile";
import type {
  ElectronTabBinding,
  ElectronTabSurfaceLease,
} from "@/lib/browser-view/electron-tabs";

const state = vi.hoisted(() => ({
  visible: true,
  bridge: null as TestBridge | null,
  chromeInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () => ({
  useTileBodyVisible: () => state.visible,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({}),
}));
vi.mock("@/lib/browser-view/desktop-browser-view", async (load) => {
  const actual =
    await load<typeof import("@/lib/browser-view/desktop-browser-view")>();
  return {
    ...actual,
    resolveDesktopBrowserViewBridge: () => state.bridge,
    resolveDesktopElectronTabLifecycleBridge: () => state.bridge,
  };
});
vi.mock(
  "@/components/epic-canvas/renderers/use-browser-view-bounds-bridge",
  () => ({
    useBrowserViewBoundsBridge: () => undefined,
  }),
);
vi.mock("@/components/epic-canvas/renderers/use-browser-view-snapshot", () => ({
  useBrowserViewSnapshot: () => null,
}));
vi.mock("@/hooks/browser/use-browser-annotation-session", () => ({
  useBrowserAnnotationSession: () => null,
}));
vi.mock("@/lib/browser-view/use-browser-cookie-crypto-state", () => ({
  useBrowserCookieCryptoState: () => null,
}));
vi.mock("@/lib/browser-view/visible-tile-registry", async (load) => {
  const actual =
    await load<typeof import("@/lib/browser-view/visible-tile-registry")>();
  return { ...actual, useRegisterVisibleBrowserTile: () => undefined };
});
vi.mock("@/lib/browser-view/browser-tile-control-store", () => ({
  useBrowserTileControlState: () => ({ active: null, pending: null }),
}));
vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useMaybeBrowserSessionsContext: () => null,
}));
vi.mock(
  "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus",
  () => ({
    useCloseCanvasTileWithNestedFocus: () => vi.fn(),
  }),
);
vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (selector: (value: Record<string, unknown>) => unknown) =>
    selector({
      tabsById: { "view-1": { epicId: "epic-1" } },
      updateBrowserTileViewportPresetInTab: vi.fn(),
    }),
}));
vi.mock("@/components/epic-canvas/renderers/use-electron-tile-chrome", () => ({
  useElectronTabChrome: (input: Record<string, unknown>) => {
    state.chromeInputs.push(input);
    return {
      controller: null,
      viewportPreset: "responsive",
      downloads: [],
      cancelDownload: vi.fn(),
      certificateError: null,
      certificateProceeding: false,
      proceedCertificate: vi.fn(),
    };
  },
}));

interface NativeStatusChange {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string | null;
  readonly status: "loading" | "ready" | "dead";
  readonly reason: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly zoomPercent: number;
}

class TestBridge {
  private statusHandler: ((change: NativeStatusChange) => void) | null = null;

  onNativeTabStatusChange(handler: (change: NativeStatusChange) => void): {
    dispose: () => void;
  } {
    this.statusHandler = handler;
    return { dispose: () => (this.statusHandler = null) };
  }

  onOpenTileRequest(): { dispose: () => void } {
    return { dispose: () => {} };
  }

  emitStatus(change: NativeStatusChange): void {
    this.statusHandler?.(change);
  }
}

const NODE: ElectronTabSurfaceNode = {
  id: "browser-session:session-1:tab-1",
  instanceId: "tile-1",
  name: "Example",
  hostId: "host-1",
  sessionId: "session-1",
  url: "https://example.com/",
  viewportPreset: "responsive",
};

function createBinding(
  bindSurface: ElectronTabBinding["bindSurface"],
): ElectronTabBinding {
  return {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId: "registration-1",
    url: "https://example.com/",
    title: "Example",
    control: vi.fn(async () => {}),
    bindSurface,
  };
}

function renderTile(binding: ElectronTabBinding) {
  return render(
    <ElectronTabSurface
      node={NODE}
      binding={binding}
      viewTabId="view-1"
      paneId="pane-1"
    />,
  );
}

describe("ElectronTabSurface", () => {
  beforeEach(() => {
    state.visible = true;
    state.bridge = new TestBridge();
    state.chromeInputs = [];
  });

  afterEach(() => {
    cleanup();
  });

  it("attaches the accepted native incarnation before enabling tile chrome", async () => {
    const lease: ElectronTabSurfaceLease = {
      update: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
    };
    const bindSurface = vi.fn(async () => lease);
    renderTile(createBinding(bindSurface));

    expect(state.chromeInputs.at(0)?.surfaceServices).toBeNull();
    await waitFor(() => {
      expect(bindSurface).toHaveBeenCalledExactlyOnceWith({
        bindingId: "canvas\u001fview-1\u001fpane-1\u001ftile-1",
        surface: {
          viewTabId: "view-1",
          paneId: "pane-1",
          tileInstanceId: "tile-1",
          pageSessionId: "browser-session:session-1:tab-1",
        },
        visible: false,
      });
      expect(state.chromeInputs.at(-1)?.surfaceServices).toBe(state.bridge);
    });
  });

  it("updates presentation state through the lease and detaches on unmount", async () => {
    const lease: ElectronTabSurfaceLease = {
      update: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
    };
    const view = renderTile(createBinding(async () => lease));
    await waitFor(() => {
      expect(lease.update).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true }),
      );
    });

    view.unmount();
    expect(lease.detach).toHaveBeenCalledTimes(1);
  });

  it("shows an attach failure without creating or releasing another tab", async () => {
    renderTile(
      createBinding(async () => {
        throw new Error("surface attach rejected");
      }),
    );

    expect(await screen.findByText("Agent browser unavailable")).toBeTruthy();
    expect(screen.getByText("surface attach rejected")).toBeTruthy();
  });

  it("accepts status only for the exact host, session, and tab", async () => {
    const bridge = state.bridge;
    if (bridge === null) throw new Error("bridge missing");
    renderTile(
      createBinding(async () => ({
        update: async () => {},
        detach: async () => {},
      })),
    );
    await waitFor(() => {
      expect(state.chromeInputs.at(-1)?.surfaceServices).toBe(bridge);
    });

    act(() => {
      bridge.emitStatus({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "foreign-tab",
        url: "https://foreign.example/",
        title: null,
        status: "dead",
        reason: "foreign failure",
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 100,
      });
    });
    expect(screen.queryByText("foreign failure")).toBeNull();

    act(() => {
      bridge.emitStatus({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        url: "https://example.com/",
        title: null,
        status: "dead",
        reason: "native guest crashed",
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 100,
      });
    });
    expect(screen.getByText("native guest crashed")).toBeTruthy();
  });
});
