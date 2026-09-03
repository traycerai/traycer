import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  app: {
    getAppMetrics: vi.fn(
      (): ReadonlyArray<{
        readonly pid: number;
        readonly memory: { readonly workingSetSize: number };
      }> => [],
    ),
  },
  contentTracing: {
    startRecording: vi.fn(() => Promise.resolve()),
    stopRecording: vi.fn(() => Promise.resolve("")),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@sentry/electron/main", () => ({
  isInitialized: vi.fn((): boolean => false),
  captureMessage: vi.fn(),
}));

import type { IpcMainInvokeEvent } from "electron";
import { app } from "electron";
import { handleMeasureJsHeaps } from "../diagnostics";

type MessageListener = (
  event: unknown,
  method: string,
  params: unknown,
  sessionId: string | undefined,
) => void;

interface HeapUsageResult {
  readonly usedSize: number;
  readonly totalSize: number;
}

interface FakeWorkerFixture {
  readonly sessionId: string;
  readonly type: string;
  readonly url: string;
  readonly heapUsage: HeapUsageResult | "reject";
}

interface FakeDebugger {
  readonly isAttached: Mock<() => boolean>;
  readonly attach: Mock<(protocolVersion: string) => void>;
  readonly detach: Mock<() => void>;
  readonly on: Mock<(event: "message", listener: MessageListener) => void>;
  readonly removeListener: Mock<
    (event: "message", listener: MessageListener) => void
  >;
  readonly sendCommand: Mock<
    (
      method: string,
      commandParams: Record<string, unknown> | undefined,
      sessionId: string | undefined,
    ) => Promise<unknown>
  >;
}

interface FakeSender {
  readonly isDestroyed: Mock<() => boolean>;
  readonly getURL: Mock<() => string>;
  readonly getOSProcessId: Mock<() => number>;
  readonly debugger: FakeDebugger;
}

interface FakeEvent {
  readonly sender: FakeSender;
}

/**
 * A prototype-less object asserted to the event type, with the one member
 * `handleMeasureJsHeaps` reads (`sender`, and off it `isDestroyed` / `getURL`
 * / `getOSProcessId` / `debugger.*`) assigned onto it. `as unknown as` is
 * lint-forbidden here, and a one-member literal does not overlap the real
 * event type enough for a direct `as`.
 */
function asIpcMainInvokeEvent(fake: FakeEvent): IpcMainInvokeEvent {
  return Object.assign(Object.create(null) as IpcMainInvokeEvent, fake);
}

function buildFakeDebugger(options: {
  readonly pageHeapUsage: HeapUsageResult | "reject";
  readonly workers: ReadonlyArray<FakeWorkerFixture>;
  readonly isAttachedInitially: boolean;
  readonly attachThrows: boolean;
}): FakeDebugger {
  let attached = options.isAttachedInitially;
  let messageListener: MessageListener | null = null;
  const workersBySessionId = new Map(
    options.workers.map((worker) => [worker.sessionId, worker]),
  );

  const isAttached = vi.fn((): boolean => attached);
  const attach = vi.fn((protocolVersion: string): void => {
    void protocolVersion;
    if (options.attachThrows) {
      throw new Error("attach failed");
    }
    attached = true;
  });
  const detach = vi.fn((): void => {
    attached = false;
  });
  const on = vi.fn((event: "message", listener: MessageListener): void => {
    if (event === "message") messageListener = listener;
  });
  const removeListener = vi.fn(
    (event: "message", listener: MessageListener): void => {
      void event;
      if (messageListener === listener) messageListener = null;
    },
  );
  const sendCommand = vi.fn(
    (
      method: string,
      commandParams: Record<string, unknown> | undefined,
      sessionId: string | undefined,
    ): Promise<unknown> => {
      if (method === "Runtime.getHeapUsage") {
        if (sessionId === undefined) {
          return options.pageHeapUsage === "reject"
            ? Promise.reject(new Error("page heap read failed"))
            : Promise.resolve(options.pageHeapUsage);
        }
        const worker = workersBySessionId.get(sessionId);
        if (worker === undefined) {
          return Promise.reject(new Error(`unknown session ${sessionId}`));
        }
        return worker.heapUsage === "reject"
          ? Promise.reject(new Error("worker heap read failed"))
          : Promise.resolve(worker.heapUsage);
      }
      if (method === "Target.setAutoAttach") {
        const autoAttach = commandParams?.["autoAttach"];
        if (autoAttach === true && messageListener !== null) {
          const listener = messageListener;
          for (const worker of options.workers) {
            listener(
              {},
              "Target.attachedToTarget",
              {
                sessionId: worker.sessionId,
                targetInfo: { type: worker.type, url: worker.url },
              },
              undefined,
            );
          }
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
  );

  return { isAttached, attach, detach, on, removeListener, sendCommand };
}

function buildFakeEvent(options: {
  readonly isDestroyed: boolean;
  readonly pageUrl: string;
  readonly pid: number;
  readonly debuggerApi: FakeDebugger;
}): { readonly event: IpcMainInvokeEvent; readonly sender: FakeSender } {
  const sender: FakeSender = {
    isDestroyed: vi.fn((): boolean => options.isDestroyed),
    getURL: vi.fn((): string => options.pageUrl),
    getOSProcessId: vi.fn((): number => options.pid),
    debugger: options.debuggerApi,
  };
  return { event: asIpcMainInvokeEvent({ sender }), sender };
}

function processMetric(
  pid: number,
  workingSetKb: number,
): Electron.ProcessMetric {
  return {
    pid,
    type: "Tab",
    creationTime: 0,
    cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: workingSetKb, peakWorkingSetSize: workingSetKb },
  };
}

describe("handleMeasureJsHeaps", () => {
  beforeEach(() => {
    vi.mocked(app.getAppMetrics).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the page plus every surviving worker isolate, skips non-worker targets, and converts the working set from KB", async () => {
    const workers: ReadonlyArray<FakeWorkerFixture> = [
      {
        sessionId: "session-epic",
        type: "worker",
        url: "app://renderer/assets/epic-runtime-worker-entry-abc.js",
        heapUsage: { usedSize: 5_000_000, totalSize: 8_000_000 },
      },
      {
        sessionId: "session-service",
        type: "service_worker",
        url: "app://renderer/service-worker.js",
        heapUsage: { usedSize: 1, totalSize: 1 },
      },
      {
        sessionId: "session-flaky",
        type: "worker",
        url: "app://renderer/assets/worker-flaky.js",
        heapUsage: "reject",
      },
    ];
    const debuggerApi = buildFakeDebugger({
      pageHeapUsage: { usedSize: 40_000_000, totalSize: 60_000_000 },
      workers,
      isAttachedInitially: false,
      attachThrows: false,
    });
    const { event, sender } = buildFakeEvent({
      isDestroyed: false,
      pageUrl: "app://renderer/index.html",
      pid: 4242,
      debuggerApi,
    });
    vi.mocked(app.getAppMetrics).mockReturnValue([
      processMetric(1, 999_999),
      processMetric(4242, 300_000),
    ]);

    const result = await handleMeasureJsHeaps(event);

    expect(result).not.toBeNull();
    expect(result?.workingSetBytes).toBe(300_000 * 1024);
    expect(result?.isolates).toEqual([
      {
        kind: "page",
        url: "app://renderer/index.html",
        usedBytes: 40_000_000,
        totalBytes: 60_000_000,
      },
      {
        kind: "worker",
        url: "app://renderer/assets/epic-runtime-worker-entry-abc.js",
        usedBytes: 5_000_000,
        totalBytes: 8_000_000,
      },
    ]);
    // The service-worker target and the worker whose heap read rejected are
    // both absent, and their absence did not fail the whole call.
    expect(
      result?.isolates.some((isolate) =>
        isolate.url.includes("service-worker"),
      ),
    ).toBe(false);
    expect(
      result?.isolates.some((isolate) => isolate.url.includes("worker-flaky")),
    ).toBe(false);

    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
    const autoAttachCalls = debuggerApi.sendCommand.mock.calls.filter(
      ([method]) => method === "Target.setAutoAttach",
    );
    expect(autoAttachCalls).toHaveLength(2);
    expect(autoAttachCalls[0]?.[1]).toMatchObject({ autoAttach: true });
    expect(autoAttachCalls[1]?.[1]).toMatchObject({ autoAttach: false });
    expect(debuggerApi.detach).toHaveBeenCalledTimes(1);
    expect(debuggerApi.removeListener).toHaveBeenCalledTimes(1);
    const [, removedListener] = debuggerApi.removeListener.mock.calls[0] ?? [
      undefined,
      undefined,
    ];
    const [, registeredListener] = debuggerApi.on.mock.calls[0] ?? [
      undefined,
      undefined,
    ];
    expect(removedListener).toBe(registeredListener);
    expect(sender.getOSProcessId).toHaveBeenCalled();
  });

  it("returns null without attaching when a debugger is already attached to this window", async () => {
    const debuggerApi = buildFakeDebugger({
      pageHeapUsage: { usedSize: 1, totalSize: 1 },
      workers: [],
      isAttachedInitially: true,
      attachThrows: false,
    });
    const { event } = buildFakeEvent({
      isDestroyed: false,
      pageUrl: "app://renderer/index.html",
      pid: 1,
      debuggerApi,
    });

    const result = await handleMeasureJsHeaps(event);

    expect(result).toBeNull();
    expect(debuggerApi.attach).not.toHaveBeenCalled();
    expect(debuggerApi.detach).not.toHaveBeenCalled();
  });

  it("returns null and never touches the message listener when attach() throws", async () => {
    const debuggerApi = buildFakeDebugger({
      pageHeapUsage: { usedSize: 1, totalSize: 1 },
      workers: [],
      isAttachedInitially: false,
      attachThrows: true,
    });
    const { event } = buildFakeEvent({
      isDestroyed: false,
      pageUrl: "app://renderer/index.html",
      pid: 1,
      debuggerApi,
    });

    const result = await handleMeasureJsHeaps(event);

    expect(result).toBeNull();
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
    expect(debuggerApi.on).not.toHaveBeenCalled();
    expect(debuggerApi.detach).not.toHaveBeenCalled();
  });

  it("returns null and still detaches when a command rejects mid-measurement", async () => {
    const debuggerApi = buildFakeDebugger({
      pageHeapUsage: "reject",
      workers: [],
      isAttachedInitially: false,
      attachThrows: false,
    });
    const { event } = buildFakeEvent({
      isDestroyed: false,
      pageUrl: "app://renderer/index.html",
      pid: 1,
      debuggerApi,
    });

    const result = await handleMeasureJsHeaps(event);

    expect(result).toBeNull();
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
    expect(debuggerApi.detach).toHaveBeenCalledTimes(1);
    expect(debuggerApi.removeListener).toHaveBeenCalledTimes(1);
  });

  it("returns null when the sender is destroyed, without reading the debugger at all", async () => {
    const debuggerApi = buildFakeDebugger({
      pageHeapUsage: { usedSize: 1, totalSize: 1 },
      workers: [],
      isAttachedInitially: false,
      attachThrows: false,
    });
    const { event } = buildFakeEvent({
      isDestroyed: true,
      pageUrl: "app://renderer/index.html",
      pid: 1,
      debuggerApi,
    });

    const result = await handleMeasureJsHeaps(event);

    expect(result).toBeNull();
    expect(debuggerApi.isAttached).not.toHaveBeenCalled();
    expect(debuggerApi.attach).not.toHaveBeenCalled();
  });
});
