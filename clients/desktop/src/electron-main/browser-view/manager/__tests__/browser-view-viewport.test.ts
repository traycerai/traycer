import { describe, expect, it } from "vitest";
import type { BrowserViewportGeometry } from "@traycer/protocol/host/browser/viewport";
import type {
  BrowserViewElectronViewport,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import type { BrowserViewWebContents } from "../../browser-view-port";
import { FakeWebContents } from "../../debug/__tests__/browser-debug-session-test-support";
import type { BrowserViewEntry } from "../browser-view-entry";
import { BrowserViewAnnotationHost } from "../browser-view-annotation-host";
import {
  BrowserViewEntryRegistry,
  type BrowserViewEntryKey,
} from "../browser-view-entry-registry";
import { BrowserViewDebugSessions } from "../debug-session-for";
import { NativeBrowserViewLifecycle } from "../native-browser-view-lifecycle";
import { BrowserViewViewport } from "../browser-view-viewport";

class RejectingWebContents extends FakeWebContents {
  executeJavaScript(_script: string, _userGesture: boolean): Promise<unknown> {
    return Promise.reject(new Error("initial geometry script rejected"));
  }
}

function createEntry(webContents: BrowserViewWebContents): BrowserViewEntry {
  const key: BrowserViewEntryKey = {
    windowId: "window-1",
    viewTabId: "view-tab-1",
    paneId: "pane-1",
    tileInstanceId: "tile-1",
    pageSessionId: "page-1",
  };
  const capability: BrowserViewNativeTabCapability = {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId: "registration-1",
  };
  const lifecycle = new NativeBrowserViewLifecycle();
  lifecycle.completeProvisioning(capability, null);
  lifecycle.accept();
  return {
    surface: key,
    surfaceBindingId: "binding-1",
    guestKey: "guest-1",
    identity: {
      key: capability,
      ...capability,
      lifecycleWindowId: "window-1",
      lifecycle,
    },
    profile: "primary",
    webContents,
    listeners: {},
    desiredVisible: true,
    requestedUrl: "https://example.test/",
    currentUrl: "https://example.test/",
    currentTitle: "Example",
    status: "ready",
    statusReason: null,
    findState: {
      appRequestId: 0,
      query: "",
      matchCase: false,
      sessionsByElectronRequestId: new Map(),
    },
    certificateError: null,
    debugSession: null,
    annotationSession: null,
    devToolsWindow: null,
    rendererResetPending: false,
    internalNavigation: false,
    succeededByReplacement: false,
    closePromise: null,
  };
}

function viewportInput(): BrowserViewElectronViewport {
  const geometry: BrowserViewportGeometry = {
    width: 390,
    height: 844,
    dpr: 1,
  };
  return {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId: "registration-1",
    connectionId: "connection-1",
    revision: 1,
    intent: { mode: "fixed", width: 390, height: 844 },
    geometry,
  };
}

describe("BrowserViewViewport", () => {
  it("preserves the first geometry script error instead of masking it in rollback", async () => {
    const entries = new BrowserViewEntryRegistry<BrowserViewEntry>();
    const debugSessions = new BrowserViewDebugSessions({
      onDetached: () => undefined,
    });
    const annotations = new BrowserViewAnnotationHost({
      entries,
      debugSessions,
      send: () => false,
    });
    const viewport = new BrowserViewViewport(
      entries,
      annotations,
      debugSessions,
      () => false,
    );
    const entry = createEntry(new RejectingWebContents());
    entries.register(entry);

    await expect(viewport.apply(entry, viewportInput())).rejects.toThrow(
      "initial geometry script rejected",
    );
  });
});
