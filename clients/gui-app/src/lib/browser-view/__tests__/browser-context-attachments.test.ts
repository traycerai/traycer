import { afterEach, describe, expect, it } from "vitest";

import {
  browserContextAttachmentToWire,
  createBrowserConsoleAttachment,
  createBrowserDebugContextAttachment,
  createBrowserNetworkAttachment,
  createBrowserScreenshotAttachment,
  mintBrowserObserveGrant,
  registerBrowserContextAttachmentHandler,
  requestBrowserContextAttachment,
} from "../browser-context-attachments";
import type {
  BrowserViewCapturePageResult,
  BrowserViewConsoleEntry,
  BrowserViewNetworkEntry,
  BrowserViewTileKey,
} from "../desktop-browser-view";
import { createSingleTileCanvas } from "@/stores/epics/canvas/actions";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

const TILE: BrowserViewTileKey = {
  viewTabId: "view-tab",
  paneId: "pane",
  tileInstanceId: "tile",
  pageSessionId: "page",
};

const CONSOLE_ENTRY: BrowserViewConsoleEntry = {
  id: "console-1",
  timestamp: 1000,
  source: "console-api",
  level: "error",
  text: "boom",
  url: "http://localhost:3000/app.js",
  lineNumber: 4,
  columnNumber: 2,
  stackTrace: [],
};

const NETWORK_ENTRY: BrowserViewNetworkEntry = {
  id: "root:request-1",
  requestId: "request-1",
  url: "http://localhost:3000/api",
  method: "POST",
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

const CAPTURE: BrowserViewCapturePageResult = {
  ...TILE,
  mediaType: "image/png",
  base64: "aGVsbG8=",
  byteLength: 5,
  sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  capturedAt: 2000,
};

describe("browser context attachment payloads", () => {
  it("packages console rows with an explicit observe grant request", () => {
    const payload = createBrowserConsoleAttachment({
      tile: TILE,
      pageUrl: "http://localhost:3000/page",
      entry: CONSOLE_ENTRY,
    });

    expect(payload).toMatchObject({
      schemaVersion: 1,
      kind: "browser-console-entry",
      observeGrantRequest: {
        kind: "visible-browser-observe-grant-request",
        chatId: null,
        tileInstanceId: "tile",
        origin: "http://localhost:3000",
        dataLevel: "console-entry",
        sourceAction: "browser-console-row-send",
      },
      consoleEntry: CONSOLE_ENTRY,
    });
    expect(payload.composerText).toContain("Browser console entry");
    expect(payload.composerText).toContain("boom");
  });

  it("packages network rows as request summaries", () => {
    const payload = createBrowserNetworkAttachment({
      tile: TILE,
      pageUrl: "http://localhost:3000/page",
      entry: NETWORK_ENTRY,
    });

    expect(payload.kind).toBe("browser-network-request");
    expect(payload.observeGrantRequest.dataLevel).toBe("network-request");
    expect(payload.composerText).toContain("POST http://localhost:3000/api");
    expect(payload.composerText).toContain("net::ERR_FAILED");
  });

  it("uses the screenshot hash as the attachment map key", () => {
    const payload = createBrowserScreenshotAttachment({
      tile: TILE,
      pageUrl: "http://localhost:3000/page",
      capture: CAPTURE,
    });

    expect(payload.kind).toBe("browser-screenshot");
    expect(payload.screenshot).toMatchObject({
      hash: CAPTURE.sha256,
      attachmentsMapKey: CAPTURE.sha256,
      base64: CAPTURE.base64,
      byteLength: CAPTURE.byteLength,
      name: `browser-screenshot-${CAPTURE.sha256.slice(0, 12)}.png`,
    });
  });

  it("omits Page/Image lines from screenshot composerText (ticket 29 A2)", () => {
    // Same sweep ticket 22 did for debugContextComposerText: Page is volatile
    // state (belongs in observation), and Image: <name> never had an image
    // attached beside it in this attachment's wire shape.
    const payload = createBrowserScreenshotAttachment({
      tile: TILE,
      pageUrl: "http://localhost:3000/page",
      capture: CAPTURE,
    });

    expect(payload.composerText).toContain("Browser screenshot");
    expect(payload.composerText).toContain(`Content hash: ${CAPTURE.sha256}`);
    expect(payload.composerText).toContain(`Size: ${CAPTURE.byteLength} bytes`);
    expect(payload.composerText).not.toMatch(/^Page:/m);
    expect(payload.composerText).not.toMatch(/^Image:/m);
    expect(payload.composerText).not.toContain(
      "Page: http://localhost:3000/page",
    );
    expect(payload.composerText).not.toContain(
      `Image: browser-screenshot-${CAPTURE.sha256.slice(0, 12)}.png`,
    );
  });

  it("mints a chat-scoped visible-tile observe grant from trusted payload state", () => {
    const payload = createBrowserScreenshotAttachment({
      tile: TILE,
      pageUrl: "http://localhost:3000/page",
      capture: CAPTURE,
    });

    const granted = mintBrowserObserveGrant(payload, {
      chatId: "chat-1",
      expiresAt: 3000,
    });

    expect(granted.observeGrant).toEqual({
      kind: "visible-browser-observe-grant",
      chatId: "chat-1",
      tileInstanceId: "tile",
      origin: "http://localhost:3000",
      dataLevel: "screenshot",
      expiresAt: 3000,
    });
    expect(granted.observeGrantRequest).toMatchObject({
      chatId: "chat-1",
      expiresAt: 3000,
    });
  });

  it("returns unhandled until ticket 12 registers the composer handler", async () => {
    const payload = createBrowserConsoleAttachment({
      tile: TILE,
      pageUrl: "http://localhost:3000/page",
      entry: CONSOLE_ENTRY,
    });

    await expect(
      requestBrowserContextAttachment(payload, { targetChatId: "chat-1" }),
    ).resolves.toMatchObject({
      status: "unhandled",
      reason: "ticket-12-handler-not-registered",
    });

    const registration = registerBrowserContextAttachmentHandler((next) => ({
      status: "attached",
      payload: next.payload,
    }));
    await expect(
      requestBrowserContextAttachment(payload, { targetChatId: "chat-1" }),
    ).resolves.toMatchObject({
      status: "attached",
      payload,
    });
    registration.dispose();
  });
});

describe("browser debug context attachment (ticket 22)", () => {
  it("omits Page/Title/Screenshot lines from composerText while keeping Level, Content hash, and error lines", () => {
    const payload = createBrowserDebugContextAttachment({
      tile: TILE,
      pageUrl: "http://localhost:3000/page",
      dataLevel: "debug-errors",
      capture: CAPTURE,
      consoleEntries: [CONSOLE_ENTRY],
      networkEntries: [NETWORK_ENTRY],
    });

    expect(payload.kind).toBe("browser-debug-context");
    expect(payload.composerText).toContain("Browser context");
    expect(payload.composerText).toContain(
      "Level: screenshot + console/network errors",
    );
    expect(payload.composerText).toContain(`Content hash: ${CAPTURE.sha256}`);
    expect(payload.composerText).toContain("Console errors:");
    expect(payload.composerText).toContain("- boom");
    expect(payload.composerText).toContain("Network errors:");
    expect(payload.composerText).toContain(
      "- POST http://localhost:3000/api: failed (net::ERR_FAILED)",
    );

    // Ticket 22: volatile page identity and the filename-with-no-picture
    // pattern leave composerText; snapshot()/envelope is the source of truth.
    expect(payload.composerText).not.toMatch(/^Page:/m);
    expect(payload.composerText).not.toMatch(/^Title:/m);
    expect(payload.composerText).not.toMatch(/^Screenshot:/m);
    expect(payload.composerText).not.toContain(
      "Page: http://localhost:3000/page",
    );
    expect(payload.composerText).not.toContain("Title: Settings");
    expect(payload.composerText).not.toContain(
      `Screenshot: browser-context-${CAPTURE.sha256.slice(0, 12)}.png`,
    );
  });

  it("does not carry title or screenshot bytes on the payload - traced against production, nothing reads them (ticket 22 fixup: an earlier version of this test wrongly claimed 'other UI consumers' without tracing the claim)", () => {
    const payload = createBrowserDebugContextAttachment({
      tile: TILE,
      pageUrl: "http://localhost:3000/page",
      dataLevel: "debug-snapshot",
      capture: CAPTURE,
      consoleEntries: [],
      networkEntries: [],
    });

    expect(payload).not.toHaveProperty("title");
    expect(payload).not.toHaveProperty("screenshot");
    // `capture`'s base64 must not be retained anywhere reachable from the
    // returned payload - it was captured only to derive `hash` for
    // composerText and must not linger in composer draft state.
    expect(JSON.stringify(payload)).not.toContain(CAPTURE.base64);
    expect(payload.dataLevel).toBe("debug-snapshot");
    expect(payload.observeGrantRequest).toMatchObject({
      dataLevel: "debug-snapshot",
      sourceAction: "browser-composer-attach",
      origin: "http://localhost:3000",
    });
    // Empty error lists: no Console/Network error sections, but Level + hash remain.
    expect(payload.composerText).toContain("Level: full debug snapshot");
    expect(payload.composerText).toContain(`Content hash: ${CAPTURE.sha256}`);
    expect(payload.composerText).not.toContain("Console errors:");
    expect(payload.composerText).not.toContain("Network errors:");
  });
});

describe("browserContextAttachmentToWire (ticket 01)", () => {
  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("emits tabId from the tile key, not the retired tileInstanceId wire field", () => {
    const payload = createBrowserScreenshotAttachment({
      tile: TILE,
      pageUrl: "http://localhost:3000/page",
      capture: CAPTURE,
    });
    const wire = browserContextAttachmentToWire(payload);
    expect(wire).toEqual({
      kind: "browser-screenshot",
      origin: "http://localhost:3000",
      pageUrl: "http://localhost:3000/page",
      composerText: payload.composerText,
      tabId: "tile",
    });
    expect(wire).not.toHaveProperty("tileInstanceId");
    expect(wire).not.toHaveProperty("handle");
  });

  it("reads the host-minted tab id from its BrowserSessionTileRef", () => {
    useEpicCanvasStore.setState({
      canvasByTabId: {
        [TILE.viewTabId]: createSingleTileCanvas({
          id: "browser-session:session-durable:durable-tab-1",
          instanceId: TILE.tileInstanceId,
          type: "browser-session",
          name: "Durable tab",
          hostId: "host-1",
          sessionId: "session-durable",
          tabId: "durable-tab-1",
        }),
      },
    });

    const payload = createBrowserScreenshotAttachment({
      tile: TILE,
      pageUrl: "http://localhost:3000/page",
      capture: CAPTURE,
    });
    const wire = browserContextAttachmentToWire(payload);
    expect(wire.tabId).toBe("durable-tab-1");
    expect(wire.tabId).not.toBe(TILE.tileInstanceId);
  });
});
