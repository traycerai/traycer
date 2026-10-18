import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserViewportGeometry } from "@traycer/protocol/host/browser/viewport";
import type {
  BrowserViewElectronViewport,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostEvent } from "../../../../ipc-contracts/ipc-channels";
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

class ReadbackWebContents extends FakeWebContents {
  constructor(private readonly geometry: BrowserViewportGeometry) {
    super();
  }

  executeJavaScript(_script: string, _userGesture: boolean): Promise<unknown> {
    return Promise.resolve(this.geometry);
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
    navigationAttempt: 0,
    findState: {
      appRequestId: 0,
      query: "",
      matchCase: false,
      sessionsByElectronRequestId: new Map(),
    },
    certificateError: null,
    debugSession: null,
    seedLease: null,
    agentCdpLease: null,
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

function createAcknowledgingViewport(
  entries: BrowserViewEntryRegistry<BrowserViewEntry>,
  annotations: BrowserViewAnnotationHost,
  order: string[],
): BrowserViewViewport {
  let viewport: BrowserViewViewport;
  viewport = new BrowserViewViewport(
    entries,
    annotations,
    (windowId, channel, payload) => {
      if (channel !== RunnerHostEvent.browserViewGuestViewportRequested)
        return true;
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("requestId" in payload) ||
        typeof payload.requestId !== "string" ||
        !("registrationId" in payload) ||
        typeof payload.registrationId !== "string" ||
        !("revision" in payload) ||
        typeof payload.revision !== "number"
      )
        return false;
      order.push("presentation");
      viewport.reportPresentation(windowId, {
        requestId: payload.requestId,
        registrationId: payload.registrationId,
        revision: payload.revision,
        applied: true,
      });
      return true;
    },
    () => false,
  );
  return viewport;
}

const SCREEN_LOCKED_MESSAGE =
  "The screen is locked, so the browser cannot show a new viewport until it is unlocked.";

/** Sends presentations like the real window but never acknowledges one. */
function createUnacknowledgedViewport(
  readback: BrowserViewportGeometry,
  isScreenLocked: () => boolean,
): {
  readonly entry: BrowserViewEntry;
  readonly viewport: BrowserViewViewport;
  readonly presentedIntents: unknown[];
} {
  const entries = new BrowserViewEntryRegistry<BrowserViewEntry>();
  const annotations = new BrowserViewAnnotationHost({
    entries,
    debugSessions: new BrowserViewDebugSessions({
      onDetached: () => undefined,
      isOnScreen: () => false,
    }),
    send: () => false,
  });
  const presentedIntents: unknown[] = [];
  const viewport = new BrowserViewViewport(
    entries,
    annotations,
    (_windowId, channel, payload) => {
      if (
        channel === RunnerHostEvent.browserViewGuestViewportRequested &&
        typeof payload === "object" &&
        payload !== null &&
        "intent" in payload
      )
        presentedIntents.push(payload.intent);
      return true;
    },
    isScreenLocked,
  );
  const entry = createEntry(new ReadbackWebContents(readback));
  entries.register(entry);
  return { entry, viewport, presentedIntents };
}

/** Acknowledges every presentation, refusing a Fit and applying a fixed size. */
function createFitRefusingViewport(readback: BrowserViewportGeometry): {
  readonly entry: BrowserViewEntry;
  readonly viewport: BrowserViewViewport;
  readonly presentedIntents: unknown[];
} {
  const entries = new BrowserViewEntryRegistry<BrowserViewEntry>();
  const annotations = new BrowserViewAnnotationHost({
    entries,
    debugSessions: new BrowserViewDebugSessions({
      onDetached: () => undefined,
      isOnScreen: () => false,
    }),
    send: () => false,
  });
  const presentedIntents: unknown[] = [];
  let viewport: BrowserViewViewport;
  viewport = new BrowserViewViewport(
    entries,
    annotations,
    (windowId, channel, payload) => {
      if (channel !== RunnerHostEvent.browserViewGuestViewportRequested)
        return true;
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("requestId" in payload) ||
        typeof payload.requestId !== "string" ||
        !("registrationId" in payload) ||
        typeof payload.registrationId !== "string" ||
        !("revision" in payload) ||
        typeof payload.revision !== "number" ||
        !("intent" in payload) ||
        typeof payload.intent !== "object" ||
        payload.intent === null ||
        !("mode" in payload.intent)
      )
        return false;
      presentedIntents.push(payload.intent);
      viewport.reportPresentation(windowId, {
        requestId: payload.requestId,
        registrationId: payload.registrationId,
        revision: payload.revision,
        applied: payload.intent.mode === "fixed",
      });
      return true;
    },
    () => false,
  );
  const entry = createEntry(new ReadbackWebContents(readback));
  entries.register(entry);
  return { entry, viewport, presentedIntents };
}

describe("BrowserViewViewport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves the first geometry script error instead of masking it in rollback", async () => {
    const entries = new BrowserViewEntryRegistry<BrowserViewEntry>();
    const debugSessions = new BrowserViewDebugSessions({
      onDetached: () => undefined,
      isOnScreen: () => false,
    });
    const annotations = new BrowserViewAnnotationHost({
      entries,
      debugSessions,
      send: () => false,
    });
    const viewport = new BrowserViewViewport(
      entries,
      annotations,
      () => false,
      () => false,
    );
    const entry = createEntry(new RejectingWebContents());
    entries.register(entry);

    await expect(viewport.apply(entry, viewportInput())).rejects.toThrow(
      "initial geometry script rejected",
    );
  });

  it("clears device metrics before presenting an acknowledged native readback", async () => {
    const entries = new BrowserViewEntryRegistry<BrowserViewEntry>();
    const debugSessions = new BrowserViewDebugSessions({
      onDetached: () => undefined,
      isOnScreen: () => false,
    });
    const annotations = new BrowserViewAnnotationHost({
      entries,
      debugSessions,
      send: () => false,
    });
    const readback: BrowserViewportGeometry = {
      width: 412,
      height: 732,
      dpr: 1.25,
    };
    const webContents = new ReadbackWebContents(readback);
    const order: string[] = [];
    const viewport = createAcknowledgingViewport(entries, annotations, order);
    const entry = createEntry(webContents);
    // Only a tab something holds a debugger lease on has an override to clear.
    await debugSessions.ensure(entry).acquire().ready();
    const input = {
      ...viewportInput(),
      intent: { mode: "fixed", width: 412, height: 732 },
      geometry: { width: 412, height: 732, dpr: 1 },
    } satisfies BrowserViewElectronViewport;
    webContents.debugger.onSendCommand = (command) => {
      order.push(`debug:${command.method}`);
    };
    entries.register(entry);

    await expect(viewport.apply(entry, input)).resolves.toEqual(readback);
    const clearIndex = order.indexOf(
      "debug:Emulation.clearDeviceMetricsOverride",
    );
    const presentationIndex = order.indexOf("presentation");
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(presentationIndex).toBeGreaterThan(clearIndex);
    expect(
      webContents.debugger.commands.some(
        (command) => command.method === "Emulation.setDeviceMetricsOverride",
      ),
    ).toBe(false);
  });

  it("fits a tab with no debugger lease without attaching one", async () => {
    const entries = new BrowserViewEntryRegistry<BrowserViewEntry>();
    const annotations = new BrowserViewAnnotationHost({
      entries,
      debugSessions: new BrowserViewDebugSessions({
        onDetached: () => undefined,
        isOnScreen: () => false,
      }),
      send: () => false,
    });
    const readback: BrowserViewportGeometry = {
      width: 800,
      height: 600,
      dpr: 1,
    };
    const webContents = new ReadbackWebContents(readback);
    const viewport = createAcknowledgingViewport(entries, annotations, []);
    const entry = createEntry(webContents);
    entries.register(entry);

    await expect(
      viewport.apply(entry, {
        ...viewportInput(),
        intent: { mode: "fit" },
        geometry: readback,
      }),
    ).resolves.toEqual(readback);
    expect(webContents.debugger.attached).toBe(false);
    expect(webContents.debugger.commands).toEqual([]);
  });

  it("does not wait for a frame while the screen is locked", async () => {
    vi.useFakeTimers();
    const readback: BrowserViewportGeometry = {
      width: 800,
      height: 600,
      dpr: 1,
    };
    const { entry, viewport, presentedIntents } = createUnacknowledgedViewport(
      readback,
      () => true,
    );
    let failure: unknown = null;
    void viewport
      .apply(entry, {
        ...viewportInput(),
        intent: { mode: "fit" },
        geometry: readback,
      })
      .catch((error: unknown) => {
        failure = error;
      });

    await vi.advanceTimersByTimeAsync(0);

    expect(failure).toHaveProperty("message", SCREEN_LOCKED_MESSAGE);
    expect(presentedIntents).toEqual([{ mode: "fit" }]);
  });

  it("does not roll back a Fit the window never acknowledges", async () => {
    vi.useFakeTimers();
    const readback: BrowserViewportGeometry = {
      width: 800,
      height: 600,
      dpr: 1,
    };
    const { entry, viewport, presentedIntents } = createUnacknowledgedViewport(
      readback,
      () => false,
    );
    const rejection = expect(
      viewport.apply(entry, {
        ...viewportInput(),
        intent: { mode: "fit" },
        geometry: readback,
      }),
    ).rejects.toThrow(/did not (apply|confirm) its viewport in time\./);

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;

    expect(presentedIntents).toEqual([{ mode: "fit" }]);
  });

  it("rolls a Fit back when the guest refuses it rather than failing to draw it", async () => {
    const fixedReadback: BrowserViewportGeometry = {
      width: 390,
      height: 844,
      dpr: 1,
    };
    const { entry, viewport, presentedIntents } =
      createFitRefusingViewport(fixedReadback);

    await expect(viewport.apply(entry, viewportInput())).resolves.toEqual(
      fixedReadback,
    );
    await expect(
      viewport.apply(entry, {
        ...viewportInput(),
        revision: 2,
        intent: { mode: "fit" },
        geometry: fixedReadback,
      }),
    ).rejects.toThrow("The browser guest could not apply its viewport.");

    expect(presentedIntents).toEqual([
      { mode: "fixed", width: 390, height: 844 },
      { mode: "fit" },
      { mode: "fixed", width: 390, height: 844 },
    ]);
  });

  it("reports why a fixed resize failed when its rollback cannot be drawn either", async () => {
    const readback: BrowserViewportGeometry = {
      width: 800,
      height: 600,
      dpr: 1,
    };
    const { entry, viewport, presentedIntents } = createUnacknowledgedViewport(
      readback,
      () => true,
    );

    await expect(viewport.apply(entry, viewportInput())).rejects.toThrow(
      SCREEN_LOCKED_MESSAGE,
    );

    expect(presentedIntents).toEqual([
      { mode: "fixed", width: 390, height: 844 },
      { mode: "fit" },
    ]);
  });
});
