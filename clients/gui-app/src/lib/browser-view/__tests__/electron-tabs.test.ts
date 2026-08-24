import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import {
  createElectronTabs,
  drainElectronTabHandoffs,
  findElectronTabBindingOnHost,
  resetElectronTabsForTests,
  type ElectronTabs,
} from "../electron-tabs";
import type {
  BrowserViewElectronTabHandoffChange,
  BrowserViewProvisionedTab,
  DesktopElectronTabLifecycleBridge,
} from "../desktop-browser-view";

type CreateFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "createElectronTab" }
>;

const CREATE: CreateFrame = {
  kind: "createElectronTab",
  hasBinaryPayload: false,
  requestId: "request-1",
  sessionId: "session-1",
  tabId: "tab-1",
  requestedUrl: "https://example.com/",
  reason: "agent-open",
  seedStorageState: null,
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | null = null;
  let rejectPromise: ((cause: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === null) throw new Error("Deferred is not ready.");
      resolvePromise(value);
    },
    reject: (cause) => {
      if (rejectPromise === null) throw new Error("Deferred is not ready.");
      rejectPromise(cause);
    },
  };
}

function nativeWith(
  ensureTab: DesktopElectronTabLifecycleBridge["ensureTab"],
  onStatusChange:
    DesktopElectronTabLifecycleBridge["onNativeTabStatusChange"] | null,
): DesktopElectronTabLifecycleBridge {
  return {
    ensureTab,
    acceptTab: vi.fn(async () => {}),
    attachSurface: vi.fn(async () => {}),
    detachSurface: vi.fn(async () => {}),
    releaseTab: vi.fn(async () => true),
    controlElectronTab: vi.fn(async () => {}),
    dispatchElectronTabCdp: vi.fn<
      DesktopElectronTabLifecycleBridge["dispatchElectronTabCdp"]
    >(async () => ({ kind: "cdpGetFrameTree", ok: true, frames: [] })),
    onNativeTabStatusChange: onStatusChange ?? (() => ({ dispose: () => {} })),
    onNativeTabCdpSessionEnded: () => ({ dispose: () => {} }),
    onNativeTabCdpTargetAttached: () => ({ dispose: () => {} }),
    onElectronTabHandoff: () => ({ dispose: () => {} }),
  };
}

async function receiveCreate(
  tabs: ElectronTabs,
  frame: CreateFrame = CREATE,
): Promise<void> {
  expect(tabs.handleFrame(frame)).toBe(true);
  await Promise.resolve();
}

describe("ElectronTabs", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetElectronTabsForTests();
  });

  it("settles native birth before readiness and presents only after acceptance", async () => {
    const ready = deferred<BrowserViewProvisionedTab>();
    const ensureTab = vi.fn<DesktopElectronTabLifecycleBridge["ensureTab"]>(
      () => ready.promise,
    );
    const native = nativeWith(ensureTab, null);
    const sent: BrowserSessionsClientFrame[] = [];
    const present = vi.fn();
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: (frame) => sent.push(frame),
      present,
    });

    expect(tabs.handleFrame(CREATE)).toBe(true);

    expect(ensureTab).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    });
    expect(sent).toEqual([]);
    expect(present).not.toHaveBeenCalled();

    ready.resolve({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent).toEqual([
      {
        kind: "electronTabProvisioned",
        hasBinaryPayload: false,
        requestId: "request-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      },
    ]);
    expect(present).not.toHaveBeenCalled();

    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });

    expect(present).toHaveBeenCalledExactlyOnceWith({
      epicId: "epic-1",
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      url: "https://example.com/",
      reason: "agent-open",
    });
    expect(native.acceptTab).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
  });

  it("keeps an accepted native birth settled when presentation throws", async () => {
    const ready = deferred<BrowserViewProvisionedTab>();
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: nativeWith(() => ready.promise, null),
      sendFrame: (frame) => sent.push(frame),
      present: () => {
        throw new Error("presentation failed");
      },
    });

    expect(tabs.handleFrame(CREATE)).toBe(true);
    expect(
      tabs.handleFrame({
        kind: "electronTabAccepted",
        hasBinaryPayload: false,
        requestId: "request-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      }),
    ).toBe(true);
    ready.resolve({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.kind).toBe("electronTabProvisioned");
    expect(
      findElectronTabBindingOnHost("session-1", "tab-1", "host-1"),
    ).toMatchObject({ registrationId: "registration-1" });
  });

  it("replays one cached settlement without creating the native tab again", async () => {
    const ensureTab = vi.fn<DesktopElectronTabLifecycleBridge["ensureTab"]>(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      }),
    );
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: nativeWith(ensureTab, null),
      sendFrame: (frame) => sent.push(frame),
      present: () => {},
    });

    await receiveCreate(tabs);
    await receiveCreate(tabs, { ...CREATE });

    expect(ensureTab).toHaveBeenCalledTimes(1);
    expect(sent.map((frame) => frame.kind)).toEqual([
      "electronTabProvisioned",
      "electronTabProvisioned",
    ]);
  });

  it("reauthorizes a retained native tab through an explicit restore birth", async () => {
    const ensureTab = vi.fn<DesktopElectronTabLifecycleBridge["ensureTab"]>(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      }),
    );
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: nativeWith(ensureTab, null),
      sendFrame: (frame) => sent.push(frame),
      present: () => {},
    });
    await receiveCreate(tabs);
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    sent.length = 0;

    await receiveCreate(tabs, {
      ...CREATE,
      requestId: "request-restore",
      reason: "restore",
    });

    expect(ensureTab).toHaveBeenCalledTimes(2);
    expect(sent).toContainEqual(
      expect.objectContaining({
        kind: "electronTabProvisioned",
        requestId: "request-restore",
        tabId: "tab-1",
        registrationId: "registration-1",
      }),
    );
    expect(
      sent.filter((frame) => frame.kind === "electronTabCreateFailed"),
    ).toEqual([]);
  });

  it("releases only the exact native incarnation and makes replay harmless", async () => {
    const native = nativeWith(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      }),
      null,
    );
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: () => {},
      present: () => {},
    });
    await receiveCreate(tabs);

    expect(
      tabs.handleFrame({
        kind: "releaseElectronTab",
        hasBinaryPayload: false,
        requestId: "release-wrong",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-old",
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(native.releaseTab).not.toHaveBeenCalled();

    const release = {
      kind: "releaseElectronTab",
      hasBinaryPayload: false,
      requestId: "release-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    } as const;
    expect(tabs.handleFrame(release)).toBe(true);
    await vi.waitFor(() => expect(native.releaseTab).toHaveBeenCalledTimes(1));
    expect(tabs.handleFrame(release)).toBe(true);
    await Promise.resolve();

    expect(native.releaseTab).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
  });

  it("rolls back a provisioned native guest when its stream disappears before acceptance", async () => {
    const native = nativeWith(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      }),
      null,
    );
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: () => {},
      present: () => {},
    });
    await receiveCreate(tabs);

    tabs.disconnect();

    expect(native.releaseTab).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
  });

  it("preserves an accepted native tab when its coordinator is disposed", async () => {
    const native = nativeWith(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      }),
      null,
    );
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: () => {},
      present: () => {},
    });
    await receiveCreate(tabs);
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });

    tabs.dispose();

    expect(native.releaseTab).not.toHaveBeenCalled();
  });

  it("rolls back a native birth that becomes provisioned after its stream closes", async () => {
    const ready = deferred<BrowserViewProvisionedTab>();
    const native = nativeWith(() => ready.promise, null);
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: (frame) => sent.push(frame),
      present: () => {},
    });
    expect(tabs.handleFrame(CREATE)).toBe(true);

    tabs.dispose();
    ready.resolve({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });

    await vi.waitFor(() => expect(native.releaseTab).toHaveBeenCalledTimes(1));
    expect(sent).toEqual([]);
  });

  it("does not report a late native rejection on a closed stream", async () => {
    const ready = deferred<BrowserViewProvisionedTab>();
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: nativeWith(() => ready.promise, null),
      sendFrame: (frame) => sent.push(frame),
      present: () => {},
    });
    expect(tabs.handleFrame(CREATE)).toBe(true);

    tabs.dispose();
    ready.reject(new Error("late failure"));
    await Promise.resolve();

    expect(sent).toEqual([]);
  });

  it("binds a UI surface only after the host accepts the provisioned incarnation", async () => {
    const native = nativeWith(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        url: "https://example.com/",
        title: "Example Domain",
      }),
      null,
    );
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: () => {},
      present: () => {},
    });
    await receiveCreate(tabs);
    const surface = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      bindingId: "binding-1",
      surface: {
        viewTabId: "view-1",
        paneId: "pane-1",
        tileInstanceId: "tile-1",
        pageSessionId: "page-1",
      },
      visible: true,
    } as const;

    expect(
      findElectronTabBindingOnHost("session-1", "tab-1", "host-1"),
    ).toBeNull();
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });

    const binding = findElectronTabBindingOnHost(
      "session-1",
      "tab-1",
      "host-1",
    );
    if (binding === null) throw new Error("accepted binding missing");
    const lease = await binding.bindSurface({
      bindingId: surface.bindingId,
      surface: surface.surface,
      visible: surface.visible,
    });
    await lease.update({
      surface: surface.surface,
      visible: false,
    });
    await lease.detach();
    await lease.detach();

    expect(native.attachSurface).toHaveBeenNthCalledWith(1, surface);
    expect(native.attachSurface).toHaveBeenNthCalledWith(2, {
      ...surface,
      visible: false,
    });
    expect(native.detachSurface).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      bindingId: "binding-1",
    });
  });

  it("publishes only accepted bindings and removes them on exact release", async () => {
    const native = nativeWith(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        url: "https://example.com/",
        title: null,
      }),
      null,
    );
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: () => {},
      present: () => {},
    });
    await receiveCreate(tabs);

    expect(
      findElectronTabBindingOnHost("session-1", "tab-1", "host-1"),
    ).toBeNull();
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    expect(
      findElectronTabBindingOnHost("session-1", "tab-1", "host-1"),
    ).toMatchObject({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });

    expect(
      tabs.handleFrame({
        kind: "releaseElectronTab",
        hasBinaryPayload: false,
        requestId: "release-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(native.releaseTab).toHaveBeenCalledTimes(1));
    expect(
      findElectronTabBindingOnHost("session-1", "tab-1", "host-1"),
    ).toBeNull();
  });

  it("controls an accepted tab by durable identity, independent of its surface", async () => {
    const native = nativeWith(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        url: "https://example.com/",
        title: null,
      }),
      null,
    );
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: () => {},
      present: () => {},
    });
    await receiveCreate(tabs);
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    const binding = findElectronTabBindingOnHost(
      "session-1",
      "tab-1",
      "host-1",
    );
    if (binding === null) throw new Error("accepted binding missing");

    await binding.control({
      kind: "navigate",
      url: "https://example.com/next",
    });

    expect(native.controlElectronTab).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      action: {
        kind: "navigate",
        url: "https://example.com/next",
      },
    });
    expect(native.attachSurface).not.toHaveBeenCalled();
  });

  it("routes Electron CDP by tab identity without requiring a mounted surface", async () => {
    const native = nativeWith(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        url: "https://example.com/",
        title: null,
      }),
      null,
    );
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: (frame) => sent.push(frame),
      present: () => {},
    });
    await receiveCreate(tabs);
    sent.length = 0;

    expect(
      tabs.handleFrame({
        kind: "cdpGetFrameTree",
        hasBinaryPayload: false,
        requestId: "cdp-1",
        target: { kind: "electron-tab", tabId: "tab-1" },
        registrationId: "registration-1",
        cdpSessionId: null,
      }),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(native.dispatchElectronTabCdp).toHaveBeenCalledExactlyOnceWith({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        cdpSessionId: null,
        command: { kind: "cdpGetFrameTree" },
      });
      expect(sent).toEqual([
        {
          kind: "cdpGetFrameTreeResult",
          hasBinaryPayload: false,
          requestId: "cdp-1",
          target: { kind: "electron-tab", tabId: "tab-1" },
          registrationId: "registration-1",
          ok: true,
          error: null,
          frames: [],
        },
      ]);
    });
  });

  it("reports a missing Electron route as a tab error, never a tile error", () => {
    const native = nativeWith(async () => {
      throw new Error("not used");
    }, null);
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: (frame) => sent.push(frame),
      present: () => {},
    });

    expect(
      tabs.handleFrame({
        kind: "cdpGetFrameTree",
        hasBinaryPayload: false,
        requestId: "cdp-missing",
        target: { kind: "electron-tab", tabId: "tab-missing" },
        registrationId: "registration-missing",
        cdpSessionId: null,
      }),
    ).toBe(true);
    expect(native.dispatchElectronTabCdp).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        kind: "cdpGetFrameTreeResult",
        hasBinaryPayload: false,
        requestId: "cdp-missing",
        target: { kind: "electron-tab", tabId: "tab-missing" },
        registrationId: "registration-missing",
        ok: false,
        error: {
          kind: "tab_not_found",
          message: "Electron tab incarnation is not active in this renderer.",
          code: null,
        },
        frames: null,
      },
    ]);
  });

  it("drops stale native lifecycle events and forwards the exact accepted incarnation", async () => {
    const emit = {
      status: null as
        | Parameters<
            DesktopElectronTabLifecycleBridge["onNativeTabStatusChange"]
          >[0]
        | null,
      sessionEnded: null as
        | Parameters<
            DesktopElectronTabLifecycleBridge["onNativeTabCdpSessionEnded"]
          >[0]
        | null,
      targetAttached: null as
        | Parameters<
            DesktopElectronTabLifecycleBridge["onNativeTabCdpTargetAttached"]
          >[0]
        | null,
    };
    const base = nativeWith(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-current",
        url: "https://example.com/",
        title: null,
      }),
      null,
    );
    const native: DesktopElectronTabLifecycleBridge = {
      ...base,
      onNativeTabStatusChange: (handler) => {
        emit.status = handler;
        return { dispose: () => {} };
      },
      onNativeTabCdpSessionEnded: (handler) => {
        emit.sessionEnded = handler;
        return { dispose: () => {} };
      },
      onNativeTabCdpTargetAttached: (handler) => {
        emit.targetAttached = handler;
        return { dispose: () => {} };
      },
    };
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: (frame) => sent.push(frame),
      present: () => {},
    });
    await receiveCreate(tabs);
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-current",
    });
    sent.length = 0;

    const status = emit.status;
    const sessionEnded = emit.sessionEnded;
    const targetAttached = emit.targetAttached;
    if (status === null || sessionEnded === null || targetAttached === null) {
      throw new Error("native lifecycle subscriptions missing");
    }
    const statusFields = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      url: "https://example.com/next",
      title: "Next",
      status: "ready",
      reason: null,
      canGoBack: true,
      canGoForward: false,
      zoomPercent: 100,
    } as const;
    status({ ...statusFields, registrationId: "registration-stale" });
    sessionEnded({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-stale",
      reason: "stale debugger",
    });
    targetAttached({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-stale",
      cdpSessionId: "stale-child-session",
      targetId: "stale-target",
      targetType: "iframe",
      url: "https://example.com/stale-frame",
      waitingForDebugger: false,
    });
    expect(sent).toEqual([]);

    status({ ...statusFields, registrationId: "registration-current" });
    targetAttached({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-current",
      cdpSessionId: "child-session",
      targetId: "target-1",
      targetType: "iframe",
      url: "https://example.com/frame",
      waitingForDebugger: false,
    });
    sessionEnded({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-current",
      reason: "target closed",
    });

    expect(sent).toEqual([
      expect.objectContaining({
        kind: "electronTabState",
        registrationId: "registration-current",
      }),
      expect.objectContaining({
        kind: "cdpTargetAttached",
        registrationId: "registration-current",
        cdpSessionId: "child-session",
      }),
      expect.objectContaining({
        kind: "cdpSessionEnded",
        registrationId: "registration-current",
        reason: "target closed",
      }),
    ]);
  });

  it("buffers the latest native status until acceptance, then publishes later status", async () => {
    const status = {
      emit: null as
        | Parameters<
            DesktopElectronTabLifecycleBridge["onNativeTabStatusChange"]
          >[0]
        | null,
    };
    const native = nativeWith(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        url: "https://example.com/",
        title: null,
      }),
      (handler) => {
        status.emit = handler;
        return { dispose: () => {} };
      },
    );
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: (frame) => sent.push(frame),
      present: () => {},
    });
    await receiveCreate(tabs);
    const emitStatus = status.emit;
    if (emitStatus === null) throw new Error("status subscription missing");
    emitStatus({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      url: "https://example.com/intermediate",
      title: "Intermediate",
      status: "loading",
      reason: null,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
    });
    emitStatus({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      url: "https://example.com/accepted",
      title: "Accepted",
      status: "ready",
      reason: null,
      canGoBack: true,
      canGoForward: false,
      zoomPercent: 100,
    });

    expect(sent.filter((frame) => frame.kind === "electronTabState")).toEqual(
      [],
    );
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-stale",
    });
    expect(sent.filter((frame) => frame.kind === "electronTabState")).toEqual(
      [],
    );
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    expect(sent.filter((frame) => frame.kind === "electronTabState")).toEqual([
      {
        kind: "electronTabState",
        hasBinaryPayload: false,
        requestId: expect.any(String),
        registrationId: "registration-1",
        sessionId: "session-1",
        tabId: "tab-1",
        url: "https://example.com/accepted",
        title: "Accepted",
        status: "ready",
        viewed: false,
      },
    ]);
    const binding = findElectronTabBindingOnHost(
      "session-1",
      "tab-1",
      "host-1",
    );
    if (binding === null) throw new Error("accepted binding missing");
    expect(binding).toMatchObject({
      url: "https://example.com/accepted",
      title: "Accepted",
    });
    await binding.bindSurface({
      bindingId: "binding-1",
      surface: {
        viewTabId: "view-1",
        paneId: "pane-1",
        tileInstanceId: "tile-1",
        pageSessionId: "page-1",
      },
      visible: true,
    });
    sent.length = 0;

    emitStatus({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      url: "https://example.com/later",
      title: "Later",
      status: "ready",
      reason: null,
      canGoBack: true,
      canGoForward: false,
      zoomPercent: 100,
    });

    expect(sent).toEqual([
      {
        kind: "electronTabState",
        hasBinaryPayload: false,
        requestId: expect.any(String),
        registrationId: "registration-1",
        sessionId: "session-1",
        tabId: "tab-1",
        url: "https://example.com/later",
        title: "Later",
        status: "ready",
        viewed: true,
      },
    ]);
  });

  it("settles an exact native handoff drain from its action ack result", async () => {
    const handoffHandler = {
      emit: null as
        ((change: BrowserViewElectronTabHandoffChange) => void) | null,
    };
    const base = nativeWith(
      async () => ({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        url: "https://example.com/",
        title: null,
      }),
      null,
    );
    const native: DesktopElectronTabLifecycleBridge = {
      ...base,
      onElectronTabHandoff: (handler) => {
        handoffHandler.emit = handler;
        return { dispose: () => {} };
      },
    };
    const sent: BrowserSessionsClientFrame[] = [];
    let failHandoffSend = false;
    let failedSendDrain: Promise<void> | null = null;
    const tabs = createElectronTabs({
      epicId: "epic-1",
      hostId: "host-1",
      native: native,
      sendFrame: (frame) => {
        if (failHandoffSend && frame.kind === "electronTabHandoff") {
          failedSendDrain = drainElectronTabHandoffs();
          throw new Error("handoff stream send failed");
        }
        sent.push(frame);
      },
      present: () => {},
    });
    await receiveCreate(tabs);
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    sent.length = 0;
    const emitHandoff = handoffHandler.emit;
    if (emitHandoff === null) throw new Error("handoff subscription missing");

    emitHandoff({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      capturedUrl: "https://example.com/final",
      capturedStorageState: { cookies: [], origins: [] },
      siblingTabs: [
        {
          tabId: "tab-2",
          registrationId: "registration-2",
          url: "https://example.com/two",
          capturedStorageState: null,
        },
      ],
      reason: "gui-quit",
    });

    const handoff = sent.find((frame) => frame.kind === "electronTabHandoff");
    expect(handoff).toMatchObject({
      kind: "electronTabHandoff",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      capturedUrl: "https://example.com/final",
      siblingTabs: [
        {
          tabId: "tab-2",
          registrationId: "registration-2",
          url: "https://example.com/two",
          capturedStorageState: null,
        },
      ],
    });
    if (handoff === undefined) throw new Error("handoff frame missing");
    let drained = false;
    const drain = drainElectronTabHandoffs().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    expect(
      tabs.handleFrame({
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId: handoff.requestId,
        ok: true,
        reason: null,
      }),
    ).toBe(true);
    await drain;
    expect(drained).toBe(true);

    emitHandoff({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      capturedUrl: "https://example.com/final",
      capturedStorageState: null,
      siblingTabs: [],
      reason: "gui-quit",
    });
    const failedHandoff = sent.at(-1);
    if (failedHandoff?.kind !== "electronTabHandoff") {
      throw new Error("handoff frame missing");
    }
    const failedDrain = drainElectronTabHandoffs();

    expect(
      tabs.handleFrame({
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId: failedHandoff.requestId,
        ok: false,
        reason: "handoff persistence failed",
      }),
    ).toBe(true);
    await expect(failedDrain).rejects.toThrow("handoff persistence failed");

    emitHandoff({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      capturedUrl: "https://example.com/final",
      capturedStorageState: null,
      siblingTabs: [],
      reason: "gui-quit",
    });
    const unobservedHandoff = sent.at(-1);
    if (unobservedHandoff?.kind !== "electronTabHandoff") {
      throw new Error("handoff frame missing");
    }
    expect(
      tabs.handleFrame({
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId: unobservedHandoff.requestId,
        ok: false,
        reason: "handoff rejected without an active drain",
      }),
    ).toBe(true);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    failHandoffSend = true;
    expect(() =>
      emitHandoff({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        capturedUrl: "https://example.com/final",
        capturedStorageState: null,
        siblingTabs: [],
        reason: "gui-quit",
      }),
    ).toThrow("handoff stream send failed");
    failHandoffSend = false;
    if (failedSendDrain === null) throw new Error("failed send drain missing");
    await expect(failedSendDrain).rejects.toThrow("handoff stream send failed");
    await expect(drainElectronTabHandoffs()).resolves.toBeUndefined();

    emitHandoff({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      capturedUrl: "https://example.com/final",
      capturedStorageState: null,
      siblingTabs: [],
      reason: "gui-quit",
    });
    const interruptedDrain = drainElectronTabHandoffs();
    tabs.dispose();
    await expect(interruptedDrain).rejects.toThrow(
      "transport closed before acknowledgement",
    );
  });
});
