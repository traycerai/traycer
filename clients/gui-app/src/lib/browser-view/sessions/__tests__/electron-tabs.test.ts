import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { renderHook } from "@testing-library/react";
import type {
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import {
  createElectronTabs,
  drainElectronTabHandoffs,
  type ElectronTabBinding,
  type ElectronTabs,
  useElectronTabBindingOnHost,
} from "../electron-tabs";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import type {
  BrowserViewElectronTabHandoffChange,
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabStatusChange,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";

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

function provisionedTab(
  registrationId: string,
): Promise<BrowserViewNativeTabCapability> {
  return Promise.resolve({
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId,
  });
}

type NativeBridge = Omit<
  BrowserViewBridge,
  | "acceptTab"
  | "attachSurface"
  | "detachSurface"
  | "releaseTab"
  | "controlElectronTab"
  | "dispatchElectronTabCdp"
> & {
  readonly acceptTab: Mock<BrowserViewBridge["acceptTab"]>;
  readonly attachSurface: Mock<BrowserViewBridge["attachSurface"]>;
  readonly detachSurface: Mock<BrowserViewBridge["detachSurface"]>;
  readonly releaseTab: Mock<BrowserViewBridge["releaseTab"]>;
  readonly controlElectronTab: Mock<BrowserViewBridge["controlElectronTab"]>;
  readonly dispatchElectronTabCdp: Mock<
    BrowserViewBridge["dispatchElectronTabCdp"]
  >;
};

const activeElectronTabs = new Set<ElectronTabs>();

function trackElectronTabs(tabs: ElectronTabs): ElectronTabs {
  activeElectronTabs.add(tabs);
  return tabs;
}

function readElectronTabBinding(
  sessionId: string,
  tabId: string,
  hostId: string,
): ElectronTabBinding | null {
  const hook = renderHook(() =>
    useElectronTabBindingOnHost(sessionId, tabId, hostId),
  );
  const binding = hook.result.current;
  hook.unmount();
  return binding;
}

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
  ensureTab: BrowserViewBridge["ensureTab"],
  onStatusChange: BrowserViewBridge["onNativeTabStatusChange"] | null,
): NativeBridge {
  const candidate = {
    ensureTab,
    acceptTab: vi.fn<BrowserViewBridge["acceptTab"]>(() => Promise.resolve()),
    attachSurface: vi.fn<BrowserViewBridge["attachSurface"]>(() =>
      Promise.resolve(),
    ),
    detachSurface: vi.fn<BrowserViewBridge["detachSurface"]>(() =>
      Promise.resolve(),
    ),
    releaseTab: vi.fn<BrowserViewBridge["releaseTab"]>(() =>
      Promise.resolve(true),
    ),
    controlElectronTab: vi.fn<BrowserViewBridge["controlElectronTab"]>(() =>
      Promise.resolve(),
    ),
    dispatchElectronTabCdp: vi.fn<BrowserViewBridge["dispatchElectronTabCdp"]>(
      () => Promise.resolve({ kind: "cdpGetFrameTree", ok: true, frames: [] }),
    ),
    onNativeTabStatusChange: onStatusChange ?? (() => ({ dispose: () => {} })),
    onElectronTabHandoff: () => ({ dispose: () => {} }),
  };
  return Object.assign(createFakeRunnerHost({}), {
    browserView: candidate,
  }).browserView;
}

async function receiveCreate(
  tabs: ElectronTabs,
  frame: CreateFrame,
): Promise<void> {
  expect(tabs.handleFrame(frame)).toBe(true);
  await Promise.resolve();
}

describe("ElectronTabs", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const tabs of activeElectronTabs) tabs.dispose();
    activeElectronTabs.clear();
  });

  it("settles native birth before readiness and publishes its binding after acceptance", async () => {
    const ready = deferred<BrowserViewNativeTabCapability>();
    const ensureTab = vi.fn<BrowserViewBridge["ensureTab"]>(
      () => ready.promise,
    );
    const native = nativeWith(ensureTab, null);
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: (frame) => sent.push(frame),
      }),
    );

    expect(tabs.handleFrame(CREATE)).toBe(true);

    expect(ensureTab).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      requestedUrl: "https://example.com/",
      seedStorageState: null,
    });
    expect(sent).toEqual([]);

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
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });

    expect(native.acceptTab).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
  });

  it("ignores a duplicate create without creating or settling twice", async () => {
    const ensureTab = vi.fn<BrowserViewBridge["ensureTab"]>(() =>
      provisionedTab("registration-1"),
    );
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: nativeWith(ensureTab, null),
        sendFrame: (frame) => sent.push(frame),
      }),
    );

    await receiveCreate(tabs, CREATE);
    await receiveCreate(tabs, { ...CREATE });

    expect(ensureTab).toHaveBeenCalledTimes(1);
    expect(sent.map((frame) => frame.kind)).toEqual(["electronTabProvisioned"]);
  });

  it("reauthorizes a retained native tab through an explicit restore birth", async () => {
    const ensureTab = vi.fn<BrowserViewBridge["ensureTab"]>(() =>
      provisionedTab("registration-1"),
    );
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: nativeWith(ensureTab, null),
        sendFrame: (frame) => sent.push(frame),
      }),
    );
    await receiveCreate(tabs, CREATE);
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
    const native = nativeWith(() => provisionedTab("registration-1"), null);
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: () => {},
      }),
    );
    await receiveCreate(tabs, CREATE);

    expect(
      tabs.handleFrame({
        kind: "releaseElectronTab",
        hasBinaryPayload: false,
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
    const native = nativeWith(() => provisionedTab("registration-1"), null);
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: () => {},
      }),
    );
    await receiveCreate(tabs, CREATE);

    tabs.disconnect();

    expect(native.releaseTab).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
  });

  it("removes a disconnected binding without releasing the reusable native guest", async () => {
    const native = nativeWith(() => provisionedTab("registration-1"), null);
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native,
        sendFrame: () => {},
      }),
    );
    await receiveCreate(tabs, CREATE);
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });

    expect(
      readElectronTabBinding("session-1", "tab-1", "host-1"),
    ).not.toBeNull();
    tabs.disconnect();

    expect(readElectronTabBinding("session-1", "tab-1", "host-1")).toBeNull();
    expect(native.releaseTab).not.toHaveBeenCalled();
  });

  it("preserves an accepted native tab when its coordinator is disposed", async () => {
    const native = nativeWith(() => provisionedTab("registration-1"), null);
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: () => {},
      }),
    );
    await receiveCreate(tabs, CREATE);
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
    const ready = deferred<BrowserViewNativeTabCapability>();
    const native = nativeWith(() => ready.promise, null);
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: (frame) => sent.push(frame),
      }),
    );
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

  it("retires a pending birth before disconnect can block its replacement", async () => {
    const first = deferred<BrowserViewNativeTabCapability>();
    const ensureTab = vi
      .fn<BrowserViewBridge["ensureTab"]>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-2",
      });
    const native = nativeWith(ensureTab, null);
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native,
        sendFrame: (frame) => sent.push(frame),
      }),
    );

    expect(tabs.handleFrame(CREATE)).toBe(true);
    tabs.disconnect();
    tabs.connect();
    expect(
      tabs.handleFrame({
        ...CREATE,
        requestId: "request-restore",
        reason: "restore",
      }),
    ).toBe(true);

    first.resolve({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    await vi.waitFor(() => {
      expect(ensureTab).toHaveBeenCalledTimes(2);
      expect(sent).toContainEqual(
        expect.objectContaining({
          kind: "electronTabProvisioned",
          requestId: "request-restore",
          registrationId: "registration-2",
        }),
      );
      expect(native.releaseTab).toHaveBeenCalledExactlyOnceWith({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      });
    });
  });

  it("does not report a late native rejection on a closed stream", async () => {
    const ready = deferred<BrowserViewNativeTabCapability>();
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: nativeWith(() => ready.promise, null),
        sendFrame: (frame) => sent.push(frame),
      }),
    );
    expect(tabs.handleFrame(CREATE)).toBe(true);

    tabs.dispose();
    ready.reject(new Error("late failure"));
    await Promise.resolve();

    expect(sent).toEqual([]);
  });

  it("binds a UI surface only after the host accepts the provisioned incarnation", async () => {
    const native = nativeWith(() => provisionedTab("registration-1"), null);
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: () => {},
      }),
    );
    await receiveCreate(tabs, CREATE);
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
    } as const;

    expect(readElectronTabBinding("session-1", "tab-1", "host-1")).toBeNull();
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });

    const binding = readElectronTabBinding("session-1", "tab-1", "host-1");
    if (binding === null) throw new Error("accepted binding missing");
    const lease = await binding.bindSurface({
      bindingId: surface.bindingId,
      surface: surface.surface,
    });
    await lease.detach();
    await lease.detach();

    expect(native.attachSurface).toHaveBeenNthCalledWith(1, surface);
    expect(native.attachSurface).toHaveBeenCalledOnce();
    expect(native.detachSurface).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      bindingId: "binding-1",
    });
  });

  it("keeps the replacement surface active when the stale lease detaches", async () => {
    const statusHandler = {
      emit: null as ((change: BrowserViewNativeTabStatusChange) => void) | null,
    };
    const native = nativeWith(
      () => provisionedTab("registration-1"),
      (handler) => {
        statusHandler.emit = handler;
        return { dispose: () => undefined };
      },
    );
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native,
        sendFrame: (frame) => sent.push(frame),
      }),
    );
    await receiveCreate(tabs, CREATE);
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    if (statusHandler.emit === null) throw new Error("status listener missing");
    statusHandler.emit({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      url: "https://example.com/",
      title: "Example",
      status: "ready",
      reason: null,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
    });

    const binding = readElectronTabBinding("session-1", "tab-1", "host-1");
    if (binding === null) throw new Error("accepted binding missing");
    const surface = (bindingId: string, paneId: string) => ({
      bindingId,
      surface: {
        viewTabId: "view-1",
        paneId,
        tileInstanceId: `tile-${paneId}`,
        pageSessionId: `page-${paneId}`,
      },
    });
    const first = surface("binding-a", "pane-a");
    const second = surface("binding-b", "pane-b");
    const leaseA = await binding.bindSurface(first);
    const leaseB = await binding.bindSurface(second);

    expect(native.attachSurface).toHaveBeenNthCalledWith(1, {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      ...first,
    });
    expect(native.attachSurface).toHaveBeenNthCalledWith(2, {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      ...second,
    });
    expect(native.detachSurface).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      bindingId: "binding-a",
    });

    await leaseA.detach();
    expect(native.detachSurface).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).toMatchObject({
      kind: "electronTabState",
      tabId: "tab-1",
      viewed: true,
    });

    await leaseB.detach();
    expect(native.detachSurface).toHaveBeenNthCalledWith(2, {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      bindingId: "binding-b",
    });
    expect(sent.at(-1)).toMatchObject({
      kind: "electronTabState",
      tabId: "tab-1",
      viewed: false,
    });
  });

  it("keeps the old surface recorded when its detach fails and re-detaches on retry", async () => {
    const statusHandler = {
      emit: null as ((change: BrowserViewNativeTabStatusChange) => void) | null,
    };
    const native = nativeWith(
      () => provisionedTab("registration-1"),
      (handler) => {
        statusHandler.emit = handler;
        return { dispose: () => undefined };
      },
    );
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native,
        sendFrame: (frame) => sent.push(frame),
      }),
    );
    await receiveCreate(tabs, CREATE);
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    if (statusHandler.emit === null) throw new Error("status listener missing");
    statusHandler.emit({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      url: "https://example.com/",
      title: "Example",
      status: "ready",
      reason: null,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
    });

    const binding = readElectronTabBinding("session-1", "tab-1", "host-1");
    if (binding === null) throw new Error("accepted binding missing");
    const surfaceOf = (bindingId: string, paneId: string) => ({
      bindingId,
      surface: {
        viewTabId: "view-1",
        paneId,
        tileInstanceId: `tile-${paneId}`,
        pageSessionId: `page-${paneId}`,
      },
    });
    const first = surfaceOf("binding-a", "pane-a");
    const second = surfaceOf("binding-b", "pane-b");
    const detachOfA = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      bindingId: "binding-a",
    };
    await binding.bindSurface(first);
    native.detachSurface.mockImplementationOnce(() =>
      Promise.reject(new Error("detach failed")),
    );

    await expect(binding.bindSurface(second)).rejects.toThrow("detach failed");

    // The failed detach left the native surface attached, so the renderer must
    // still report the old surface as viewed and must not have attached a second.
    expect(native.attachSurface).toHaveBeenCalledOnce();
    expect(native.detachSurface).toHaveBeenCalledExactlyOnceWith(detachOfA);
    expect(sent.at(-1)).toMatchObject({
      kind: "electronTabState",
      tabId: "tab-1",
      viewed: true,
    });

    const leaseB = await binding.bindSurface(second);

    expect(native.detachSurface).toHaveBeenNthCalledWith(2, detachOfA);
    expect(native.attachSurface).toHaveBeenNthCalledWith(2, {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      ...second,
    });

    await leaseB.detach();
    expect(native.detachSurface).toHaveBeenNthCalledWith(3, {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      bindingId: "binding-b",
    });
    expect(sent.at(-1)).toMatchObject({
      kind: "electronTabState",
      tabId: "tab-1",
      viewed: false,
    });
  });

  it("keeps a lease's surface recorded when its own detach fails", async () => {
    const native = nativeWith(() => provisionedTab("registration-1"), null);
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native,
        sendFrame: () => {},
      }),
    );
    await receiveCreate(tabs, CREATE);
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });

    const binding = readElectronTabBinding("session-1", "tab-1", "host-1");
    if (binding === null) throw new Error("accepted binding missing");
    const lease = await binding.bindSurface({
      bindingId: "binding-a",
      surface: {
        viewTabId: "view-1",
        paneId: "pane-a",
        tileInstanceId: "tile-a",
        pageSessionId: "page-a",
      },
    });
    native.detachSurface.mockImplementationOnce(() =>
      Promise.reject(new Error("detach failed")),
    );

    await expect(lease.detach()).rejects.toThrow("detach failed");

    await binding.bindSurface({
      bindingId: "binding-b",
      surface: {
        viewTabId: "view-1",
        paneId: "pane-b",
        tileInstanceId: "tile-b",
        pageSessionId: "page-b",
      },
    });

    expect(native.detachSurface).toHaveBeenNthCalledWith(2, {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      bindingId: "binding-a",
    });
  });

  it("publishes only accepted bindings and removes them on exact release", async () => {
    const native = nativeWith(() => provisionedTab("registration-1"), null);
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: () => {},
      }),
    );
    await receiveCreate(tabs, CREATE);

    expect(readElectronTabBinding("session-1", "tab-1", "host-1")).toBeNull();
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    expect(
      readElectronTabBinding("session-1", "tab-1", "host-1"),
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
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(native.releaseTab).toHaveBeenCalledTimes(1));
    expect(readElectronTabBinding("session-1", "tab-1", "host-1")).toBeNull();
  });

  it("controls an accepted tab by durable identity, independent of its surface", async () => {
    const native = nativeWith(() => provisionedTab("registration-1"), null);
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: () => {},
      }),
    );
    await receiveCreate(tabs, CREATE);
    tabs.handleFrame({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    const binding = readElectronTabBinding("session-1", "tab-1", "host-1");
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
    const native = nativeWith(() => provisionedTab("registration-1"), null);
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: (frame) => sent.push(frame),
      }),
    );
    await receiveCreate(tabs, CREATE);
    sent.length = 0;

    expect(
      tabs.handleFrame({
        kind: "cdpRequest",
        hasBinaryPayload: false,
        requestId: "cdp-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        target: { kind: "root" },
        command: { kind: "cdpGetFrameTree" },
      }),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(native.dispatchElectronTabCdp).toHaveBeenCalledExactlyOnceWith({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        target: { kind: "root" },
        command: { kind: "cdpGetFrameTree" },
      });
      expect(sent).toEqual([
        {
          kind: "cdpResult",
          hasBinaryPayload: false,
          requestId: "cdp-1",
          result: { kind: "cdpGetFrameTree", ok: true, frames: [] },
        },
      ]);
    });
  });

  it("reports a missing Electron route as a tab error, never a tile error", () => {
    const native = nativeWith(
      () => Promise.reject(new Error("not used")),
      null,
    );
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: (frame) => sent.push(frame),
      }),
    );

    expect(
      tabs.handleFrame({
        kind: "cdpRequest",
        hasBinaryPayload: false,
        requestId: "cdp-missing",
        tabId: "tab-missing",
        registrationId: "registration-missing",
        target: { kind: "root" },
        command: { kind: "cdpGetFrameTree" },
      }),
    ).toBe(true);
    expect(native.dispatchElectronTabCdp).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        kind: "cdpResult",
        hasBinaryPayload: false,
        requestId: "cdp-missing",
        result: {
          kind: "cdpGetFrameTree",
          ok: false,
          error: {
            kind: "tab_not_found",
            message: "Electron tab incarnation is not active in this renderer.",
            code: null,
          },
        },
      },
    ]);
  });

  it("drops stale native status and forwards the exact accepted incarnation", async () => {
    const emit = {
      status: null as
        | Parameters<BrowserViewBridge["onNativeTabStatusChange"]>[0]
        | null,
    };
    const base = nativeWith(() => provisionedTab("registration-current"), null);
    const native = {
      ...base,
      onNativeTabStatusChange: (
        handler: (change: BrowserViewNativeTabStatusChange) => void,
      ) => {
        emit.status = handler;
        return { dispose: () => {} };
      },
    };
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: (frame) => sent.push(frame),
      }),
    );
    await receiveCreate(tabs, CREATE);
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
    if (status === null) throw new Error("native status subscription missing");
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
    expect(sent).toEqual([]);

    status({ ...statusFields, registrationId: "registration-current" });
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "electronTabState",
        registrationId: "registration-current",
      }),
    ]);
  });

  it("buffers the latest native status until acceptance, then publishes later status", async () => {
    const status = {
      emit: null as
        | Parameters<BrowserViewBridge["onNativeTabStatusChange"]>[0]
        | null,
    };
    const native = nativeWith(
      () => provisionedTab("registration-1"),
      (handler) => {
        status.emit = handler;
        return { dispose: () => {} };
      },
    );
    const sent: BrowserSessionsClientFrame[] = [];
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: (frame) => sent.push(frame),
      }),
    );
    await receiveCreate(tabs, CREATE);
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
        registrationId: "registration-1",
        sessionId: "session-1",
        tabId: "tab-1",
        url: "https://example.com/accepted",
        title: "Accepted",
        status: "ready",
        viewed: false,
      },
    ]);
    const binding = readElectronTabBinding("session-1", "tab-1", "host-1");
    if (binding === null) throw new Error("accepted binding missing");
    await binding.bindSurface({
      bindingId: "binding-1",
      surface: {
        viewTabId: "view-1",
        paneId: "pane-1",
        tileInstanceId: "tile-1",
        pageSessionId: "page-1",
      },
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
        | ((change: BrowserViewElectronTabHandoffChange) => void)
        | null,
    };
    const base = nativeWith(() => provisionedTab("registration-1"), null);
    const native = {
      ...base,
      onElectronTabHandoff: (
        handler: (change: BrowserViewElectronTabHandoffChange) => void,
      ) => {
        handoffHandler.emit = handler;
        return { dispose: () => {} };
      },
    };
    const sent: BrowserSessionsClientFrame[] = [];
    let failHandoffSend = false;
    const failedSendDrain = { current: null as Promise<void> | null };
    const tabs = trackElectronTabs(
      createElectronTabs({
        hostId: "host-1",
        native: native,
        sendFrame: (frame) => {
          if (failHandoffSend && frame.kind === "electronTabHandoff") {
            failedSendDrain.current = drainElectronTabHandoffs();
            throw new Error("handoff stream send failed");
          }
          sent.push(frame);
        },
      }),
    );
    await receiveCreate(tabs, CREATE);
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
    if (failedSendDrain.current === null) {
      throw new Error("failed send drain missing");
    }
    await expect(failedSendDrain.current).rejects.toThrow(
      "handoff stream send failed",
    );
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
    tabs.disconnect();
    await expect(interruptedDrain).rejects.toThrow(
      "stream disconnected before acknowledgement",
    );

    tabs.connect();
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
    const closingDrain = drainElectronTabHandoffs();
    tabs.dispose();
    await expect(closingDrain).rejects.toThrow(
      "transport closed before acknowledgement",
    );
  });
});
