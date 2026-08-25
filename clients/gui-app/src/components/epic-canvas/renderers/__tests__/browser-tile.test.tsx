import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserTile } from "@/components/epic-canvas/renderers/browser-tile";
import { TileFindContext } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  BrowserCookieCryptoState,
  BrowserViewCertificateErrorChange,
  BrowserViewCertificateTrust,
  BrowserViewCapturePageResult,
  BrowserViewDownloadCancel,
  BrowserViewDownloadChange,
  BrowserViewDebugSnapshotChange,
  BrowserViewFindChange,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewOpenTileRequest,
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayRelease,
  BrowserViewOverlayReleaseResult,
  BrowserViewSnapshotInvalidatedChange,
  BrowserViewStatusChange,
  BrowserViewTileKey,
  BrowserViewViewportPresetChange,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";
import type { TileFindAdapter } from "@/stores/tile-find";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { TILE_KIND_BROWSER } from "@/stores/epics/canvas/tile-kinds";
import type { BrowserTileRef } from "@/stores/epics/canvas/types";

const bridgeHarness = vi.hoisted<{
  current: BrowserViewBridge | null;
}>(() => ({ current: null }));

const updateBrowserTileDocumentMock = vi.hoisted(() => ({
  fn: vi.fn(),
}));

const updateBrowserTileViewportPresetMock = vi.hoisted(() => ({
  fn: vi.fn(),
}));

const openFreshBrowserTileMock = vi.hoisted(() => ({
  fn: vi.fn(),
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-test",
}));

vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () => ({
  useTileBodyVisible: () => false,
}));

vi.mock("@/hooks/browser/use-browser-annotation-session", () => ({
  useBrowserAnnotationSession: () => ({
    isActive: false,
    canStart: false,
    zoomLocked: false,
    toggle: () => undefined,
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ browserView: bridgeHarness.current }),
}));

vi.mock(
  "@/lib/browser-view/browser-link-routing-core",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/browser-view/browser-link-routing-core")
      >();
    return {
      ...actual,
      openFreshBrowserTileFromBrowserPage: openFreshBrowserTileMock.fn,
    };
  },
);

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (
    selector: (state: {
      readonly updateBrowserTileDocumentInTab: typeof updateBrowserTileDocumentMock.fn;
      readonly updateBrowserTileViewportPresetInTab: typeof updateBrowserTileViewportPresetMock.fn;
      readonly canvasByTabId: Record<string, unknown>;
    }) => unknown,
  ) =>
    selector({
      updateBrowserTileDocumentInTab: updateBrowserTileDocumentMock.fn,
      updateBrowserTileViewportPresetInTab:
        updateBrowserTileViewportPresetMock.fn,
      canvasByTabId: {
        "view-tab-1": {
          activePaneId: "pane-chat",
          sizesByGroupId: {},
          root: {
            kind: "group",
            id: "group-1",
            direction: "horizontal",
            children: [
              {
                kind: "pane",
                id: "pane-chat",
                tabInstanceIds: ["chat-instance-1"],
                activeTabId: "chat-instance-1",
                previewTabId: null,
                activationHistory: ["chat-instance-1"],
              },
              {
                kind: "pane",
                id: "pane-1",
                tabInstanceIds: ["browser-instance-1"],
                activeTabId: "browser-instance-1",
                previewTabId: null,
                activationHistory: ["browser-instance-1"],
              },
            ],
          },
          tilesByInstanceId: {
            "chat-instance-1": {
              id: "chat-1",
              instanceId: "chat-instance-1",
              type: "chat",
              name: "Chat",
              hostId: "host-test",
            },
            "browser-instance-1": {
              id: "browser-page-1",
              instanceId: "browser-instance-1",
              type: TILE_KIND_BROWSER,
              name: "Browser",
              hostId: "host-test",
              url: "https://example.com",
              viewportPreset: "responsive",
            },
          },
        },
      },
    }),
}));

const NODE: BrowserTileRef = {
  id: "browser-page-1",
  instanceId: "browser-instance-1",
  type: TILE_KIND_BROWSER,
  name: "Browser",
  hostId: "host-test",
  url: "https://example.com",
  viewportPreset: "responsive",
};

const DEGRADED_STATE: BrowserCookieCryptoState = {
  mode: "degraded",
  persistence: "ephemeral",
  reason: "mock-keychain",
  storageBackend: null,
  encryptionAvailable: false,
  mockKeychainEnabled: true,
};

const REAL_STATE: BrowserCookieCryptoState = {
  mode: "real",
  persistence: "persistent",
  reason: "os-backed",
  storageBackend: null,
  encryptionAvailable: true,
  mockKeychainEnabled: false,
};

class FakeBrowserViewBridge implements BrowserViewBridge {
  readonly findInPageCalls: BrowserViewFindRequest[] = [];
  readonly stopFindInPageCalls: BrowserViewFindStop[] = [];
  readonly cancelDownloadCalls: BrowserViewDownloadCancel[] = [];
  readonly trustCertificateCalls: BrowserViewCertificateTrust[] = [];
  readonly zoomInCalls: BrowserViewTileKey[] = [];
  readonly zoomOutCalls: BrowserViewTileKey[] = [];
  readonly resetZoomCalls: BrowserViewTileKey[] = [];
  readonly viewportPresetCalls: BrowserViewViewportPresetChange[] = [];
  readonly openDevToolsCalls: BrowserViewTileKey[] = [];
  private readonly statusHandlers = new Set<
    (change: BrowserViewStatusChange) => void
  >();
  private readonly findHandlers = new Set<
    (change: BrowserViewFindChange) => void
  >();
  private readonly downloadHandlers = new Set<
    (change: BrowserViewDownloadChange) => void
  >();
  private readonly certificateHandlers = new Set<
    (change: BrowserViewCertificateErrorChange) => void
  >();
  private readonly openTileHandlers = new Set<
    (change: BrowserViewOpenTileRequest) => void
  >();

  constructor(private readonly cryptoState: BrowserCookieCryptoState) {}

  upsertTile(): Promise<void> {
    return Promise.resolve();
  }

  updateBounds(): Promise<void> {
    return Promise.resolve();
  }

  setViewportPreset(input: BrowserViewViewportPresetChange): Promise<void> {
    this.viewportPresetCalls.push(input);
    return Promise.resolve();
  }

  releaseTile(): Promise<void> {
    return Promise.resolve();
  }

  reloadTile(): Promise<void> {
    return Promise.resolve();
  }

  goBack(): Promise<void> {
    return Promise.resolve();
  }

  goForward(): Promise<void> {
    return Promise.resolve();
  }

  findInPage(input: BrowserViewFindRequest): Promise<void> {
    this.findInPageCalls.push(input);
    return Promise.resolve();
  }

  stopFindInPage(input: BrowserViewFindStop): Promise<void> {
    this.stopFindInPageCalls.push(input);
    return Promise.resolve();
  }

  cancelDownload(input: BrowserViewDownloadCancel): Promise<void> {
    this.cancelDownloadCalls.push(input);
    return Promise.resolve();
  }

  trustCertificate(input: BrowserViewCertificateTrust): Promise<void> {
    this.trustCertificateCalls.push(input);
    return Promise.resolve();
  }

  zoomIn(input: BrowserViewTileKey): Promise<void> {
    this.zoomInCalls.push(input);
    return Promise.resolve();
  }

  zoomOut(input: BrowserViewTileKey): Promise<void> {
    this.zoomOutCalls.push(input);
    return Promise.resolve();
  }

  resetZoom(input: BrowserViewTileKey): Promise<void> {
    this.resetZoomCalls.push(input);
    return Promise.resolve();
  }

  capturePage(
    input: BrowserViewTileKey,
  ): Promise<BrowserViewCapturePageResult> {
    return Promise.resolve({
      ...input,
      mediaType: "image/png",
      base64: "",
      byteLength: 0,
      sha256: "",
      capturedAt: 0,
    });
  }

  getDebugSnapshot(
    input: BrowserViewTileKey,
  ): Promise<BrowserViewDebugSnapshotChange> {
    return Promise.resolve({
      ...input,
      consoleEntries: [],
      networkEntries: [],
    });
  }

  clearDebugEvents(): Promise<void> {
    return Promise.resolve();
  }

  startAnnotation(): Promise<{ readonly ok: true }> {
    return Promise.resolve({ ok: true });
  }

  cancelAnnotation(): Promise<void> {
    return Promise.resolve();
  }

  setAnnotationTargetChatLabel(): Promise<void> {
    return Promise.resolve();
  }
  reportAnnotationAttachResult(): Promise<void> {
    return Promise.resolve();
  }

  openDevTools(input: BrowserViewTileKey): Promise<void> {
    this.openDevToolsCalls.push(input);
    return Promise.resolve();
  }

  occludeForOverlay(
    _input: BrowserViewOverlayOcclusion,
  ): Promise<BrowserViewOverlayOcclusionResult> {
    return Promise.resolve({ snapshots: [], restoredTiles: [] });
  }

  releaseOverlay(
    _input: BrowserViewOverlayRelease,
  ): Promise<BrowserViewOverlayReleaseResult> {
    return Promise.resolve({ restoredTiles: [] });
  }

  getCookieCryptoState(): Promise<BrowserCookieCryptoState> {
    return Promise.resolve(this.cryptoState);
  }

  setLabsState(): Promise<void> {
    return Promise.resolve();
  }

  applyStorageState(): Promise<{
    readonly status: "applied";
    readonly cookieCount: 0;
    readonly localStorageApplied: false;
    readonly reason: "cookies-only";
  }> {
    return Promise.resolve({
      status: "applied",
      cookieCount: 0,
      localStorageApplied: false,
      reason: "cookies-only",
    });
  }

  captureStorageState(): Promise<{
    readonly storageState: { readonly cookies: []; readonly origins: [] };
    readonly cookieCount: 0;
    readonly cookieDomains: [];
    readonly localStorageCount: 0;
    readonly localStorageAvailable: true;
    readonly localStorageReason: null;
  }> {
    return Promise.resolve({
      storageState: { cookies: [], origins: [] },
      cookieCount: 0,
      cookieDomains: [],
      localStorageCount: 0,
      localStorageAvailable: true,
      localStorageReason: null,
    });
  }

  onStatusChange(handler: (change: BrowserViewStatusChange) => void): {
    dispose: () => void;
  } {
    this.statusHandlers.add(handler);
    return {
      dispose: () => {
        this.statusHandlers.delete(handler);
      },
    };
  }

  onFindChange(handler: (change: BrowserViewFindChange) => void): {
    dispose: () => void;
  } {
    this.findHandlers.add(handler);
    return {
      dispose: () => {
        this.findHandlers.delete(handler);
      },
    };
  }

  onDownloadChange(handler: (change: BrowserViewDownloadChange) => void): {
    dispose: () => void;
  } {
    this.downloadHandlers.add(handler);
    return {
      dispose: () => {
        this.downloadHandlers.delete(handler);
      },
    };
  }

  onCertificateError(
    handler: (change: BrowserViewCertificateErrorChange) => void,
  ): {
    dispose: () => void;
  } {
    this.certificateHandlers.add(handler);
    return {
      dispose: () => {
        this.certificateHandlers.delete(handler);
      },
    };
  }

  onOpenTileRequest(handler: (change: BrowserViewOpenTileRequest) => void): {
    dispose: () => void;
  } {
    this.openTileHandlers.add(handler);
    return {
      dispose: () => {
        this.openTileHandlers.delete(handler);
      },
    };
  }

  onSnapshotInvalidated(
    _handler: (change: BrowserViewSnapshotInvalidatedChange) => void,
  ): {
    dispose: () => void;
  } {
    return { dispose: () => undefined };
  }

  onDebugSnapshotChange(
    _handler: (change: BrowserViewDebugSnapshotChange) => void,
  ): {
    dispose: () => void;
  } {
    return { dispose: () => undefined };
  }

  onAnnotationEvent(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  onAnnotationAttached(): { dispose: () => void } {
    return { dispose: () => undefined };
  }

  setReservedChords(): Promise<void> {
    return Promise.resolve();
  }

  overlayPaintAck(): Promise<void> {
    return Promise.resolve();
  }

  capturePrimaryProfile() {
    return Promise.resolve({
      status: "unavailable" as const,
      storageState: null,
      reason: "test",
    });
  }

  ensureTab() {
    return Promise.resolve({
      hostId: "host-test",
      sessionId: "session-test",
      tabId: "tab-test",
      registrationId: "registration-test",
    });
  }

  acceptTab(): Promise<void> {
    return Promise.resolve();
  }

  attachSurface(): Promise<void> {
    return Promise.resolve();
  }

  detachSurface(): Promise<void> {
    return Promise.resolve();
  }

  releaseTab(): Promise<boolean> {
    return Promise.resolve(true);
  }

  controlElectronTab(): Promise<void> {
    return Promise.resolve();
  }

  dispatchElectronTabCdp() {
    return Promise.resolve({
      kind: "cdpGetFrameTree" as const,
      ok: true as const,
      frames: [],
    });
  }

  startPipCapture(): Promise<void> {
    return Promise.resolve();
  }

  stopPipCapture(): Promise<void> {
    return Promise.resolve();
  }

  onPipCaptureFrame() {
    return { dispose: () => undefined };
  }

  onNativeTabStatusChange() {
    return { dispose: () => undefined };
  }

  onElectronTabHandoff() {
    return { dispose: () => undefined };
  }

  emitStatus(change: BrowserViewStatusChange): void {
    this.statusHandlers.forEach((handler) => handler(change));
  }

  emitFind(change: BrowserViewFindChange): void {
    this.findHandlers.forEach((handler) => handler(change));
  }

  emitDownload(change: BrowserViewDownloadChange): void {
    this.downloadHandlers.forEach((handler) => handler(change));
  }

  emitCertificateError(change: BrowserViewCertificateErrorChange): void {
    this.certificateHandlers.forEach((handler) => handler(change));
  }

  emitOpenTileRequest(change: BrowserViewOpenTileRequest): void {
    this.openTileHandlers.forEach((handler) => handler(change));
  }
}

function tileKey(): BrowserViewTileKey {
  return {
    viewTabId: "view-tab-1",
    paneId: "pane-1",
    tileInstanceId: NODE.instanceId,
    pageSessionId: NODE.id,
  };
}

function renderBrowserTile(
  registerAdapter: ((adapter: TileFindAdapter) => () => void) | null,
  node: BrowserTileRef,
): void {
  const tile = (
    <TooltipProvider>
      <BrowserTile
        node={node}
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
      />
    </TooltipProvider>
  );
  if (registerAdapter === null) {
    render(tile);
    return;
  }
  render(
    <TileFindContext.Provider
      value={{
        tileInstanceId: node.instanceId,
        registerAdapter,
      }}
    >
      {tile}
    </TileFindContext.Provider>,
  );
}

function readRegisteredAdapter(ref: {
  readonly current: TileFindAdapter | null;
}): TileFindAdapter {
  if (ref.current === null) throw new Error("find adapter missing");
  return ref.current;
}

describe("<BrowserTile /> cookie crypto banner", () => {
  beforeEach(() => {
    bridgeHarness.current = null;
    updateBrowserTileDocumentMock.fn.mockReset();
    updateBrowserTileViewportPresetMock.fn.mockReset();
    openFreshBrowserTileMock.fn.mockReset();
    useSettingsStore.setState({ inAppBrowserBetaEnabled: false });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the degraded-mode ephemeral login banner pointing at the beta setting", async () => {
    bridgeHarness.current = new FakeBrowserViewBridge(DEGRADED_STATE);

    renderBrowserTile(null, NODE);

    const banner = await screen.findByTestId("browser-cookie-degraded-banner");
    expect(banner.textContent).toContain(
      'Enable "In-app browser (beta)" in Settings, then restart Traycer, for persistent logins.',
    );
  });

  it("renders a restart-to-apply banner once the beta setting is already on", async () => {
    useSettingsStore.setState({ inAppBrowserBetaEnabled: true });
    bridgeHarness.current = new FakeBrowserViewBridge(DEGRADED_STATE);

    renderBrowserTile(null, NODE);

    const banner = await screen.findByTestId("browser-cookie-degraded-banner");
    expect(banner.textContent).toContain(
      "Restart Traycer to apply the in-app browser setting and enable persistent logins.",
    );
  });

  it("keeps a long URL intact and applies truncation classes", () => {
    const bridge = new FakeBrowserViewBridge(REAL_STATE);
    const longUrl = `https://example.com/${"very-long-path-segment/".repeat(20)}`;
    bridgeHarness.current = bridge;

    renderBrowserTile(null, { ...NODE, url: longUrl });

    const address = screen.getByLabelText("Browser address");
    expect((address as HTMLInputElement).value).toBe(longUrl);
    expect(address.className).toContain("min-w-0");
    expect(address.className).toContain("truncate");
  });

  it("shows web origin and waits for cookie state before rendering its cookie row", async () => {
    const bridge = new FakeBrowserViewBridge(REAL_STATE);
    let resolveCookieState: (state: BrowserCookieCryptoState) => void = () => {
      throw new Error("cookie state resolver was not initialized");
    };
    const cookieStatePromise = new Promise<BrowserCookieCryptoState>(
      (resolve) => {
        resolveCookieState = resolve;
      },
    );
    vi.spyOn(bridge, "getCookieCryptoState").mockReturnValue(
      cookieStatePromise,
    );
    bridgeHarness.current = bridge;

    renderBrowserTile(null, NODE);
    fireEvent.click(screen.getByRole("button", { name: "Site information" }));

    expect(screen.getByText("Web page")).toBeTruthy();
    expect(screen.queryByText("Logins saved securely")).toBeNull();

    act(() => {
      resolveCookieState(REAL_STATE);
    });

    expect(await screen.findByText("Logins saved securely")).toBeTruthy();
    expect(
      screen.getByText(
        "Cookies and saved logins on this page are encrypted by your operating system.",
      ),
    ).toBeTruthy();
  });

  it.each([
    {
      label: "real",
      state: REAL_STATE,
      headline: "Logins saved securely",
      detail:
        "Cookies and saved logins on this page are encrypted by your operating system.",
    },
    {
      label: "basic",
      state: {
        ...REAL_STATE,
        mode: "basic",
        reason: "linux-basic-text",
        storageBackend: "basic_text",
        encryptionAvailable: false,
      } satisfies BrowserCookieCryptoState,
      headline: "Logins saved with basic protection",
      detail:
        "Cookies and saved logins on this page use basic, less secure encryption.",
    },
    {
      label: "degraded",
      state: DEGRADED_STATE,
      headline: "Logins aren't saved",
      detail:
        'Logins in this browser are temporary. Enable "In-app browser (beta)" in Settings, then restart Traycer, for persistent logins.',
    },
  ])(
    "describes $label cookie protection",
    async ({ state, headline, detail }) => {
      bridgeHarness.current = new FakeBrowserViewBridge(state);

      renderBrowserTile(null, NODE);
      fireEvent.click(screen.getByRole("button", { name: "Site information" }));

      expect(await screen.findByText(headline)).toBeTruthy();
      expect(screen.getAllByText(detail).length).toBeGreaterThan(0);
    },
  );

  it("identifies about:blank as a local page", () => {
    bridgeHarness.current = new FakeBrowserViewBridge(REAL_STATE);

    renderBrowserTile(null, { ...NODE, url: "about:blank" });
    fireEvent.click(screen.getByRole("button", { name: "Site information" }));

    expect(screen.getByText("Local page")).toBeTruthy();
    expect(screen.queryByText("Web page")).toBeNull();
  });

  it("renders a dead state when native browser views are unavailable", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    bridgeHarness.current = null;

    renderBrowserTile(null, NODE);

    expect(screen.getByText("Browser view unavailable")).toBeTruthy();
    expect(
      screen.getByText("Native browser views are unavailable."),
    ).toBeTruthy();
    expect(
      consoleError.mock.calls.some((call) =>
        call.some(
          (entry) =>
            typeof entry === "string" &&
            (entry.includes("Maximum update depth exceeded") ||
              entry.includes("The result of getSnapshot should be cached")),
        ),
      ),
    ).toBe(false);
    consoleError.mockRestore();
  });

  it("registers a native find adapter and forwards find commands", () => {
    const bridge = new FakeBrowserViewBridge(REAL_STATE);
    const adapterRef: { current: TileFindAdapter | null } = { current: null };
    bridgeHarness.current = bridge;

    renderBrowserTile((nextAdapter) => {
      adapterRef.current = nextAdapter;
      return () => {
        adapterRef.current = null;
      };
    }, NODE);

    const adapter = readRegisteredAdapter(adapterRef);
    void adapter.search({ requestId: 3, query: "needle", matchCase: false });

    expect(bridge.findInPageCalls).toEqual([
      {
        ...tileKey(),
        requestId: 3,
        query: "needle",
        matchCase: false,
        forward: true,
        findNext: false,
      },
    ]);

    act(() => {
      bridge.emitFind({
        ...tileKey(),
        requestId: 3,
        query: "needle",
        matchCase: false,
        status: "ready",
        current: 1,
        total: 2,
        finalUpdate: true,
        errorMessage: null,
      });
    });

    expect(adapter.getSnapshot()).toMatchObject({
      status: "ready",
      current: 1,
      total: 2,
      exactHighlight: "painted",
    });
  });

  it("sends zoom controls through the browser view bridge", () => {
    const bridge = new FakeBrowserViewBridge(REAL_STATE);
    bridgeHarness.current = bridge;

    renderBrowserTile(null, NODE);

    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(bridge.zoomInCalls).toEqual([tileKey()]);

    act(() => {
      bridge.emitStatus({
        ...tileKey(),
        url: NODE.url,
        title: "Example",
        status: "ready",
        reason: null,
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 125,
      });
    });

    expect(screen.getByLabelText("Reset zoom").textContent).toContain("125%");
    fireEvent.click(screen.getByLabelText("Reset zoom"));
    fireEvent.click(screen.getByLabelText("Zoom out"));

    expect(bridge.resetZoomCalls).toEqual([tileKey()]);
    expect(bridge.zoomOutCalls).toEqual([tileKey()]);
  });

  it("does not restore a stale committed URL while navigation is loading", () => {
    const bridge = new FakeBrowserViewBridge(REAL_STATE);
    bridgeHarness.current = bridge;
    const nextNode: BrowserTileRef = {
      ...NODE,
      url: "https://next.example/",
    };
    const renderTile = (node: BrowserTileRef) => (
      <TooltipProvider>
        <BrowserTile
          node={node}
          viewTabId="view-tab-1"
          paneId="pane-1"
          epicId="epic-1"
        />
      </TooltipProvider>
    );
    const { rerender } = render(renderTile(NODE));

    fireEvent.change(screen.getByLabelText("Browser address"), {
      target: { value: nextNode.url },
    });
    const addressForm = screen
      .getByLabelText("Browser address")
      .closest("form");
    if (addressForm === null) {
      throw new Error("browser address input must be wrapped in a form");
    }
    fireEvent.submit(addressForm);

    expect(updateBrowserTileDocumentMock.fn).toHaveBeenCalledWith(
      "view-tab-1",
      NODE.instanceId,
      { url: nextNode.url, name: "next.example" },
    );

    rerender(renderTile(nextNode));
    updateBrowserTileDocumentMock.fn.mockClear();

    act(() => {
      bridge.emitStatus({
        ...tileKey(),
        url: NODE.url,
        title: "Previous page",
        status: "loading",
        reason: null,
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 100,
      });
    });

    expect(updateBrowserTileDocumentMock.fn).not.toHaveBeenCalled();

    act(() => {
      bridge.emitStatus({
        ...tileKey(),
        url: "https://redirect.example/",
        title: "Redirected page",
        status: "ready",
        reason: null,
        canGoBack: true,
        canGoForward: false,
        zoomPercent: 100,
      });
    });

    expect(updateBrowserTileDocumentMock.fn).toHaveBeenCalledWith(
      "view-tab-1",
      NODE.instanceId,
      {
        url: "https://redirect.example/",
        name: "Redirected page",
      },
    );
  });

  it("persists a title-only document update", () => {
    const bridge = new FakeBrowserViewBridge(REAL_STATE);
    bridgeHarness.current = bridge;
    renderBrowserTile(null, NODE);

    act(() => {
      bridge.emitStatus({
        ...tileKey(),
        url: NODE.url,
        title: "Example Domain",
        status: "ready",
        reason: null,
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 100,
      });
    });

    expect(updateBrowserTileDocumentMock.fn).toHaveBeenCalledWith(
      "view-tab-1",
      NODE.instanceId,
      { url: NODE.url, name: "Example Domain" },
    );
  });

  it("sets viewport presets and opens DevTools through explicit chrome actions", async () => {
    const bridge = new FakeBrowserViewBridge(REAL_STATE);
    bridgeHarness.current = bridge;

    renderBrowserTile(null, NODE);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Browser viewport preset" }),
      { pointerType: "mouse" },
    );
    fireEvent.click(await screen.findByText("Mobile"));
    fireEvent.click(
      screen.getByRole("button", { name: "Open browser DevTools" }),
    );

    expect(bridge.viewportPresetCalls).toEqual([
      { ...tileKey(), viewportPreset: "mobile" },
    ]);
    expect(updateBrowserTileViewportPresetMock.fn).toHaveBeenCalledWith(
      "view-tab-1",
      "browser-instance-1",
      "mobile",
    );
    expect(bridge.openDevToolsCalls).toEqual([tileKey()]);
  });

  it("surfaces downloads with cancel affordance", () => {
    const bridge = new FakeBrowserViewBridge(REAL_STATE);
    bridgeHarness.current = bridge;

    renderBrowserTile(null, NODE);
    act(() => {
      bridge.emitDownload({
        ...tileKey(),
        downloadId: "download-1",
        url: "https://example.com/archive.zip",
        filename: "archive.zip",
        mimeType: "application/zip",
        totalBytes: 2048,
        receivedBytes: 1024,
        state: "progressing",
        savePath: "/tmp/archive.zip",
        dangerType: null,
        canCancel: true,
      });
    });

    expect(screen.getByText("archive.zip")).toBeTruthy();
    expect(screen.getByText("1.0 KB of 2.0 KB")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Cancel archive.zip"));

    expect(bridge.cancelDownloadCalls).toEqual([{ downloadId: "download-1" }]);
  });

  it("surfaces certificate errors and trusts only the active pending error", async () => {
    const bridge = new FakeBrowserViewBridge(REAL_STATE);
    bridgeHarness.current = bridge;

    renderBrowserTile(null, NODE);
    act(() => {
      bridge.emitCertificateError({
        ...tileKey(),
        certificateErrorId: "cert-error-1",
        url: "https://self-signed.example/",
        hostname: "self-signed.example",
        error: "ERR_CERT_AUTHORITY_INVALID",
        fingerprint: "sha256/AA:BB",
        subject: "self-signed.example",
        issuer: "self-signed.example",
      });
    });

    expect(
      screen.getByText("Certificate warning for self-signed.example"),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Proceed for this origin" }),
    );
    await Promise.resolve();

    expect(bridge.trustCertificateCalls).toEqual([
      {
        ...tileKey(),
        certificateErrorId: "cert-error-1",
      },
    ]);
  });

  it("opens target blank popup requests as fresh browser tiles", () => {
    const bridge = new FakeBrowserViewBridge(REAL_STATE);
    bridgeHarness.current = bridge;

    renderBrowserTile(null, NODE);
    act(() => {
      bridge.emitOpenTileRequest({
        ...tileKey(),
        url: "https://docs.example/",
        disposition: "new-window",
      });
    });

    expect(openFreshBrowserTileMock.fn).toHaveBeenCalledWith({
      viewTabId: "view-tab-1",
      paneId: "pane-1",
      hostId: NODE.hostId,
      url: "https://docs.example/",
    });
  });
});
