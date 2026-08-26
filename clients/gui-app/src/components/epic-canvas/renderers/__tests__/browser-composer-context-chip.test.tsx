import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { BrowserComposerContextChip } from "@/components/epic-canvas/renderers/browser-composer-context-chip";
import { useBrowserContextAttachmentHandler } from "@/components/epic-canvas/renderers/browser-context-attachment-handler";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import type {
  BrowserCookieCryptoState,
  BrowserViewCapturePageResult,
  BrowserViewConsoleEntry,
  BrowserViewDebugSnapshot,
  BrowserViewDownloadCancel,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewNetworkEntry,
  BrowserViewTileKey,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";

const bridgeHarness = vi.hoisted<{
  current: BrowserViewBridge | null;
}>(() => ({ current: null }));

const canvasHarness = vi.hoisted<{
  current: Record<string, EpicCanvasState | undefined>;
  assertStableSelectorSnapshot: boolean;
}>(() => ({ current: {}, assertStableSelectorSnapshot: false }));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ browserView: bridgeHarness.current }),
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useMaybeBrowserSessionsContext: () => ({
    hostId: "host-1",
    lifecycle: "live",
    inventoryReady: true,
    items: [
      {
        sessionId: "session-1",
        epicId: "epic-1",
        hostId: "host-1",
        profile: "primary",
        name: "Browser",
        createdAt: 1,
        lastActivityAt: 2,
        runtime: { kind: "electron", revision: 0 },
        tabs: [
          {
            tabId: "tab-1",
            url: "https://example.com/page",
            originTier: "external",
            status: "ready",
            title: "Example",
            viewed: false,
            drivenBy: [],
          },
        ],
      },
    ],
    errorMessage: null,
    retry: vi.fn(),
    openTab: vi.fn(),
    closeTab: vi.fn(),
  }),
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (
    selector: (state: {
      readonly canvasByTabId: Record<string, EpicCanvasState | undefined>;
    }) => unknown,
  ) => {
    const state = { canvasByTabId: canvasHarness.current };
    const selected = selector(state);
    if (canvasHarness.assertStableSelectorSnapshot) {
      expect(selector(state)).toBe(selected);
    }
    return selected;
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const TILE: BrowserViewTileKey = {
  viewTabId: "view-tab",
  paneId: "browser-pane",
  tileInstanceId: "browser-instance",
  pageSessionId: "browser-session:session-1:tab-1",
};

const CAPTURE: BrowserViewCapturePageResult = {
  ...TILE,
  mediaType: "image/png",
  base64: "aGVsbG8=",
  byteLength: 5,
  sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  capturedAt: 2000,
};

const ERROR_ENTRY: BrowserViewConsoleEntry = {
  id: "console-error",
  timestamp: 1000,
  source: "console-api",
  level: "error",
  text: "console exploded",
  url: "https://example.com/app.js",
  lineNumber: 4,
  columnNumber: 2,
  stackTrace: [],
};

const INFO_ENTRY: BrowserViewConsoleEntry = {
  ...ERROR_ENTRY,
  id: "console-info",
  level: "info",
  text: "console info",
};

const FAILED_REQUEST: BrowserViewNetworkEntry = {
  id: "root:request-1",
  requestId: "request-1",
  url: "https://example.com/fail",
  method: "GET",
  resourceType: "Fetch",
  status: "failed",
  statusCode: null,
  statusText: null,
  mimeType: null,
  fromCache: false,
  startedAt: 1000,
  completedAt: 1200,
  durationMs: 200,
  encodedDataLength: null,
  failureText: "net::ERR_FAILED",
};

const SUCCESS_REQUEST: BrowserViewNetworkEntry = {
  ...FAILED_REQUEST,
  id: "root:request-2",
  requestId: "request-2",
  url: "https://example.com/ok",
  status: "finished",
  statusCode: 200,
  statusText: "OK",
  failureText: null,
};

describe("BrowserComposerContextChip", () => {
  afterEach(() => {
    cleanup();
    bridgeHarness.current = null;
    canvasHarness.current = {};
    canvasHarness.assertStableSelectorSnapshot = false;
    useComposerDraftStore.setState({ drafts: {} });
    vi.restoreAllMocks();
  });

  it("returns a stable candidate snapshot for a persisted browser sibling", () => {
    bridgeHarness.current = createFakeBridge();
    canvasHarness.current = { "view-tab": canvasWithSiblingBrowser() };
    canvasHarness.assertStableSelectorSnapshot = true;

    render(
      <TooltipProvider>
        <BrowserComposerContextChip
          chatId="chat-1"
          chatInstanceId="chat-instance"
          viewTabId="view-tab"
        />
      </TooltipProvider>,
    );

    expect(
      screen.getByRole("button", { name: /Attach: Example/ }),
    ).toBeTruthy();
  });

  it("requires an explicit level selection before attaching grant-backed browser context", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5000);
    const bridge = createFakeBridge();
    bridgeHarness.current = bridge;
    canvasHarness.current = { "view-tab": canvasWithSiblingBrowser() };

    render(
      <TooltipProvider>
        <Harness />
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", { name: /Attach:/ });
    expect(bridge.capturePageMock).not.toHaveBeenCalled();

    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    fireEvent.click(
      await screen.findByText("Screenshot + console/network errors"),
    );

    await waitFor(() => {
      expect(bridge.capturePageMock).toHaveBeenCalledWith(TILE);
    });
    expect(bridge.getDebugSnapshotMock).toHaveBeenCalledWith(TILE);

    const draft = readComposerDraftSnapshot("chat-1");
    expect(JSON.stringify(draft.content)).not.toContain("Observe grant:");
    const attachments = draft.browserContextAttachments ?? [];
    expect(attachments).toHaveLength(1);
    const attachment = attachments[0];
    expect(attachment).toBeDefined();
    expect(attachment).toMatchObject({
      kind: "browser-debug-context",
      dataLevel: "debug-errors",
      observeGrant: {
        chatId: "chat-1",
        tileInstanceId: "browser-instance",
        origin: "https://example.com",
        dataLevel: "debug-errors",
        expiresAt: 605000,
      },
      consoleEntries: [ERROR_ENTRY],
      networkEntries: [FAILED_REQUEST],
    });
    // ticket 22 fixup (b64e88d6): nothing reads title/screenshot on the
    // browser-debug-context payload - the captured base64 must not linger.
    expect(attachment).not.toHaveProperty("title");
    expect(attachment).not.toHaveProperty("screenshot");
    expect(JSON.stringify(attachment)).not.toContain(CAPTURE.base64);
  });

  it("routes a clicked chat chip to that chat even when another chat handler mounted later", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5000);
    const bridge = createFakeBridge();
    bridgeHarness.current = bridge;
    canvasHarness.current = { "view-tab": canvasWithSiblingBrowser() };

    render(
      <TooltipProvider>
        <MultiChatHarness />
      </TooltipProvider>,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Attach: Example/ }),
      { pointerType: "mouse" },
    );
    fireEvent.click(await screen.findByText("Screenshot"));

    await waitFor(() => {
      expect(
        readComposerDraftSnapshot("chat-1").browserContextAttachments ?? [],
      ).toHaveLength(1);
    });
    const chatOneAttachments =
      readComposerDraftSnapshot("chat-1").browserContextAttachments ?? [];
    expect(chatOneAttachments[0]?.observeGrant?.chatId).toBe("chat-1");
    expect(
      readComposerDraftSnapshot("chat-2").browserContextAttachments ?? [],
    ).toHaveLength(0);
  });
});

function Harness() {
  useBrowserContextAttachmentHandler({
    chatId: "chat-1",
    viewTabId: "view-tab",
  });
  return (
    <BrowserComposerContextChip
      chatId="chat-1"
      chatInstanceId="chat-instance"
      viewTabId="view-tab"
    />
  );
}

function MultiChatHarness() {
  return (
    <>
      <Harness />
      <SecondChatHandler />
    </>
  );
}

function SecondChatHandler() {
  useBrowserContextAttachmentHandler({
    chatId: "chat-2",
    viewTabId: "view-tab",
  });
  return null;
}

function canvasWithSiblingBrowser(): EpicCanvasState {
  return {
    activePaneId: "chat-pane",
    sizesByGroupId: {},
    root: {
      kind: "group",
      id: "root-group",
      direction: "horizontal",
      children: [
        {
          kind: "pane",
          id: "chat-pane",
          tabInstanceIds: ["chat-instance"],
          activeTabId: "chat-instance",
          previewTabId: null,
          activationHistory: ["chat-instance"],
        },
        {
          kind: "pane",
          id: "browser-pane",
          tabInstanceIds: ["browser-instance"],
          activeTabId: "browser-instance",
          previewTabId: null,
          activationHistory: ["browser-instance"],
        },
      ],
    },
    tilesByInstanceId: {
      "chat-instance": {
        id: "chat-1",
        instanceId: "chat-instance",
        type: "chat",
        name: "Chat",
        hostId: "host-1",
      },
      "browser-instance": {
        id: "browser-session:session-1:tab-1",
        instanceId: "browser-instance",
        type: "browser-session",
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        viewportPreset: "responsive",
      },
    },
  };
}

interface FakeBridge extends BrowserViewBridge {
  readonly capturePageMock: Mock<() => Promise<BrowserViewCapturePageResult>>;
  readonly getDebugSnapshotMock: Mock<() => Promise<BrowserViewDebugSnapshot>>;
}

function createFakeBridge(): FakeBridge {
  const snapshot: BrowserViewDebugSnapshot = {
    ...TILE,
    consoleEntries: [ERROR_ENTRY, INFO_ENTRY],
    networkEntries: [FAILED_REQUEST, SUCCESS_REQUEST],
  };
  const capturePageMock = vi.fn(() => Promise.resolve(CAPTURE));
  const getDebugSnapshotMock = vi.fn(() => Promise.resolve(snapshot));
  return {
    capturePageMock,
    getDebugSnapshotMock,
    updateBounds: vi.fn(() => Promise.resolve()),
    setReservedChords: vi.fn(() => Promise.resolve()),
    overlayPaintAck: vi.fn(() => Promise.resolve()),
    findInPage: vi.fn((_input: BrowserViewFindRequest) => Promise.resolve()),
    stopFindInPage: vi.fn((_input: BrowserViewFindStop) => Promise.resolve()),
    cancelDownload: vi.fn((_input: BrowserViewDownloadCancel) =>
      Promise.resolve(),
    ),
    trustCertificate: vi.fn(() => Promise.resolve()),
    capturePage: capturePageMock,
    getDebugSnapshot: getDebugSnapshotMock,
    startAnnotation: vi.fn(() => Promise.resolve({ ok: true as const })),
    cancelAnnotation: vi.fn(() => Promise.resolve()),
    setAnnotationTargetChatLabel: vi.fn(() => Promise.resolve()),
    reportAnnotationAttachResult: vi.fn(() => Promise.resolve()),
    occludeForOverlay: vi.fn(() =>
      Promise.resolve({ snapshots: [], restoredTiles: [] }),
    ),
    releaseOverlay: vi.fn(() => Promise.resolve({ restoredTiles: [] })),
    getCookieCryptoState: vi.fn((): Promise<BrowserCookieCryptoState> =>
      Promise.resolve({
        mode: "real",
        persistence: "persistent",
        reason: "os-backed",
        storageBackend: null,
        encryptionAvailable: true,
        mockKeychainEnabled: false,
      }),
    ),
    setLabsState: vi.fn(() => Promise.resolve()),
    capturePrimaryProfile: vi.fn(() =>
      Promise.resolve({
        status: "unavailable" as const,
        storageState: null,
        reason: "test",
      }),
    ),
    onFindChange: vi.fn(() => ({ dispose: () => undefined })),
    onDownloadChange: vi.fn(() => ({ dispose: () => undefined })),
    onCertificateError: vi.fn(() => ({ dispose: () => undefined })),
    onOpenTileRequest: vi.fn(() => ({ dispose: () => undefined })),
    onSnapshotInvalidated: vi.fn(() => ({ dispose: () => undefined })),
    onAnnotationEvent: vi.fn(() => ({ dispose: () => undefined })),
    onAnnotationAttached: vi.fn(() => ({ dispose: () => undefined })),
    ensureTab: vi.fn<BrowserViewBridge["ensureTab"]>((input) =>
      Promise.resolve({
        hostId: input.hostId,
        sessionId: input.sessionId,
        tabId: input.tabId,
        registrationId: `test:${input.tabId}`,
      }),
    ),
    acceptTab: vi.fn(() => Promise.resolve()),
    attachSurface: vi.fn(() => Promise.resolve()),
    detachSurface: vi.fn(() => Promise.resolve()),
    releaseTab: vi.fn(() => Promise.resolve(true)),
    controlElectronTab: vi.fn(() => Promise.resolve()),
    dispatchElectronTabCdp: vi.fn(() =>
      Promise.resolve({
        kind: "cdpGetFrameTree" as const,
        ok: true as const,
        frames: [],
      }),
    ),
    startPipCapture: vi.fn(() => Promise.resolve()),
    stopPipCapture: vi.fn(() => Promise.resolve()),
    onPipCaptureFrame: vi.fn(() => ({ dispose: () => undefined })),
    onNativeTabStatusChange: vi.fn(() => ({ dispose: () => undefined })),
    onElectronTabHandoff: vi.fn(() => ({ dispose: () => undefined })),
  };
}
