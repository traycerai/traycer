import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { HOST_LIFECYCLE_MODES } from "@traycer/protocol/config/host-lifecycle-policy";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../../ipc-contracts/ipc-channels";
import type {
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
  HostLifecycleView,
  LocalHostCapability,
} from "../../../ipc-contracts/host-lifecycle-types";
import {
  registerHostLifecycleIpc,
  type HostLifecycleIpcService,
} from "../platform-ipc";

const writeImageMock = vi.hoisted(() => vi.fn());
const createFromBufferMock = vi.hoisted(() =>
  vi.fn((buffer: Buffer) => ({
    isEmpty: () => buffer.byteLength === 0,
    getSize: () => ({ width: 32, height: 24 }),
  })),
);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => `/tmp/traycer-test-${name}`,
  },
  BrowserWindow: {
    fromWebContents: (): null => null,
  },
  clipboard: {
    writeImage: writeImageMock,
    readBuffer: (): Buffer => Buffer.alloc(0),
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
  nativeImage: {
    createFromBuffer: createFromBufferMock,
  },
}));

vi.mock("../../app/recent-documents", () => ({
  rememberRecentDocument: vi.fn(),
}));
vi.mock("../../app/window-effects", () => ({
  handleFlashFrame: vi.fn(),
  handleSetBadge: vi.fn(),
  handleSetContentProtection: vi.fn(),
  handleSetDocumentEdited: vi.fn(),
  handleSetOverlayIcon: vi.fn(),
  handleSetProgressBar: vi.fn(),
  handleSetRepresentedFilename: vi.fn(),
  handleSetTitleBarOverlay: vi.fn(),
}));
vi.mock("../../app/diagnostics", () => ({
  handleGetMetrics: vi.fn(),
  handleTakeHeapSnapshot: vi.fn(),
  handleTraceStart: vi.fn(),
  handleTraceStop: vi.fn(),
}));
vi.mock("../../app/system-prefs", () => ({
  canPromptTouchID: vi.fn(() => false),
  getAccentColor: vi.fn(() => null),
  getEffectiveAppearance: vi.fn(() => "light"),
  handleSetBackgroundMaterial: vi.fn(),
  handleSetVibrancy: vi.fn(),
  handleSetVisibleOnAllWorkspaces: vi.fn(),
  promptTouchID: vi.fn(async () => false),
}));
vi.mock("../../app/resilience", () => ({
  readAccessibilityTheme: vi.fn(() => null),
}));
vi.mock("../../app/installed-fonts", () => ({
  listInstalledFonts: vi.fn(async () => []),
}));
vi.mock("../../app/proxy-auth", () => ({
  clearProxyCredentials: vi.fn(),
  listKnownProxyCredentials: vi.fn(() => []),
  resolveProxyForUrl: vi.fn(async () => null),
  saveProxyCredentials: vi.fn(),
  setSessionProxy: vi.fn(),
}));
vi.mock("../../app/cert-trust", () => ({
  dismissPendingCertificateError: vi.fn(),
  listPendingCertificateErrors: vi.fn(() => []),
  listTrustedCertificates: vi.fn(() => []),
  showSystemCertificateTrustDialog: vi.fn(async () => false),
  trustCertificate: vi.fn(),
  untrustCertificate: vi.fn(),
}));
vi.mock("../../app/screen-monitor", () => ({
  readDisplayTopology: vi.fn(() => ({ displays: [] })),
}));
vi.mock("../../clipboard/native-clipboard-file-paths", () => ({
  readNativeClipboardFilePaths: vi.fn(() => []),
}));
vi.mock("../../app/gpu-acceleration", () => ({
  getHardwareAccelerationPreference: vi.fn(() => true),
  setHardwareAccelerationPreference: vi.fn(),
}));
vi.mock("../../app/desktop-log-level", () => ({
  getDesktopLogLevel: vi.fn(() => "info"),
  setDesktopLogLevel: vi.fn(),
}));
vi.mock("@traycer/protocol/config/store", () => ({
  readFeatureSettings: vi.fn(() => ({ agentRolesEnabled: false })),
  readLogLevels: vi.fn(() => ({})),
  setAgentRolesEnabled: vi.fn(),
  setLogLevels: vi.fn(),
}));
vi.mock("@traycer/protocol/config/log-level", () => ({
  isLogLevel: () => true,
}));

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;
type SyncCompute = (event: IpcMainEvent, ...args: unknown[]) => unknown;

const INVOKE_EVENT = {} as IpcMainInvokeEvent;
const SYNC_EVENT = {} as IpcMainEvent;

interface FanOutCall {
  readonly channel: string;
  readonly payload: unknown;
}

class FakeBridge {
  readonly invokes = new Map<string, InvokeHandler>();
  readonly syncs = new Map<string, SyncCompute>();
  readonly fanOuts: FanOutCall[] = [];
  readonly disposeFns: Array<() => void> = [];

  handleInvoke(channel: string, handler: InvokeHandler): void {
    this.invokes.set(channel, handler);
  }
  handleSync(channel: string, compute: SyncCompute): void {
    this.syncs.set(channel, compute);
  }
  fanOut(channel: string, payload: unknown): void {
    this.fanOuts.push({ channel, payload });
  }
}

const VIEW: HostLifecycleView = {
  desired: {
    mode: "background",
    rev: 0,
    updatedBy: null,
    updatedAt: null,
  },
  applied: { localHostCapability: "managed", supervisor: "not-running" },
  pending: "none",
};

const APPLIED_RESULT: HostLifecycleSetResult = { kind: "applied", view: VIEW };

class FakeService implements HostLifecycleIpcService {
  getViewCalls = 0;
  readonly setRequests: HostLifecycleSetRequest[] = [];
  readonly listeners = new Set<(view: HostLifecycleView) => void>();

  async getView(): Promise<HostLifecycleView> {
    this.getViewCalls += 1;
    return VIEW;
  }
  async setMode(
    request: HostLifecycleSetRequest,
  ): Promise<HostLifecycleSetResult> {
    this.setRequests.push(request);
    return APPLIED_RESULT;
  }
  onChange(listener: (view: HostLifecycleView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(view: HostLifecycleView): void {
    for (const listener of [...this.listeners]) {
      listener(view);
    }
  }
}

function install(capability: LocalHostCapability): {
  readonly bridge: FakeBridge;
  readonly service: FakeService;
} {
  const bridge = new FakeBridge();
  const service = new FakeService();
  registerHostLifecycleIpc(bridge, service, capability);
  return { bridge, service };
}

function invokeSet(bridge: FakeBridge, payload: unknown): unknown {
  const handler = bridge.invokes.get(RunnerHostInvoke.hostLifecycleSet);
  if (handler === undefined) {
    throw new Error("hostLifecycle:set handler not registered");
  }
  return handler(INVOKE_EVENT, payload);
}

describe("registerHostLifecycleIpc", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes get through to the service", async () => {
    const { bridge, service } = install("managed");
    const handler = bridge.invokes.get(RunnerHostInvoke.hostLifecycleGet);
    expect(handler).toBeDefined();
    const result = await handler?.(INVOKE_EVENT);
    expect(result).toBe(VIEW);
    expect(service.getViewCalls).toBe(1);
  });

  it("passes a valid set request through with the confirmed stop", async () => {
    const { bridge, service } = install("managed");
    const result = await invokeSet(bridge, { mode: "none", stop: "force" });
    expect(result).toBe(APPLIED_RESULT);
    expect(service.setRequests).toEqual([{ mode: "none", stop: "force" }]);
  });

  it("accepts every known mode and the if-idle stop", async () => {
    const { bridge, service } = install("managed");
    for (const mode of HOST_LIFECYCLE_MODES) {
      await invokeSet(bridge, { mode, stop: "if-idle" });
    }
    expect(service.setRequests).toHaveLength(HOST_LIFECYCLE_MODES.length);
    expect(service.setRequests.map((request) => request.mode)).toEqual([
      ...HOST_LIFECYCLE_MODES,
    ]);
  });

  it("normalizes a null or missing stop to null", async () => {
    const { bridge, service } = install("managed");
    await invokeSet(bridge, { mode: "linked", stop: null });
    await invokeSet(bridge, { mode: "ask" });
    expect(service.setRequests).toEqual([
      { mode: "linked", stop: null },
      { mode: "ask", stop: null },
    ]);
  });

  it("rejects invalid payloads without reaching the service", () => {
    const { bridge, service } = install("managed");
    const bad: unknown[] = [
      null,
      "none",
      42,
      {},
      { mode: "bogus", stop: null },
      { mode: 3, stop: null },
      { mode: "none", stop: "later" },
      { mode: "none", stop: true },
    ];
    for (const payload of bad) {
      expect(() => invokeSet(bridge, payload)).toThrow();
    }
    expect(service.setRequests).toHaveLength(0);
  });

  it("fans service change events out on hostLifecycleChange", () => {
    const { bridge, service } = install("managed");
    expect(service.listeners.size).toBe(1);
    const next: HostLifecycleView = { ...VIEW, pending: "restart-app" };
    service.emit(next);
    expect(bridge.fanOuts).toEqual([
      { channel: RunnerHostEvent.hostLifecycleChange, payload: next },
    ]);
  });

  it("registers a dispose that unsubscribes the change listener", () => {
    const { bridge, service } = install("managed");
    expect(bridge.disposeFns).toHaveLength(1);
    for (const dispose of bridge.disposeFns) {
      dispose();
    }
    expect(service.listeners.size).toBe(0);
    service.emit(VIEW);
    expect(bridge.fanOuts).toHaveLength(0);
  });

  it("answers the sync capability channel with the applied capability", () => {
    for (const capability of ["managed", "none"] as const) {
      const { bridge } = install(capability);
      const compute = bridge.syncs.get(RunnerHostSync.localHostCapability);
      expect(compute).toBeDefined();
      expect(compute?.(SYNC_EVENT)).toBe(capability);
    }
  });
});
