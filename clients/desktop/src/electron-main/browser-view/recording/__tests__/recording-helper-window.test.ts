import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordingEvent } from "@traycer-clients/shared/platform/browser-view";
import type {
  BrowserViewCapturedImage,
  BrowserViewWebContents,
} from "../../browser-view-port";
import type { BrowserStorageSession } from "../../storage/browser-storage-state";
import type { RecordingCaptureSourceKind } from "../recording-capture-source-setting";

/**
 * `recording-helper-window.ts` opens a real Electron `BrowserWindow` and
 * drives its `webContents` directly, so the fakes below stand in for both:
 *
 * - `FakeElectronGuestWebContents` is what `electron.webContents.fromId(id)`
 *   returns - the object the module reads `.session`, `.isDestroyed()` and
 *   `.mainFrame` from.
 * - `FakeGuestPort` is the `BrowserViewWebContents`-shaped guest the CALLER
 *   passes in (`request.guest`) - only `.id`, `.on`/`.off("destroyed")` and
 *   `.capturePage()` are ever read by this module, but it `implements` the
 *   real (wide) port interface so it is directly assignable with no cast.
 * - `FakeHelperWebContents` / `FakeBrowserWindow` are the helper's own
 *   `BrowserWindow`/`WebContents` - what `new BrowserWindow(...)` in
 *   production actually gets back once "electron" is mocked below.
 *
 * `destroy()` on the fake window THROWS: the D15 probe found that calling it
 * on a helper mid-process breaks the NEXT helper window's navigation, so
 * production must only ever call `close()`. If a test starts failing with an
 * error out of `destroy()`, that is the regression, not a broken test.
 */

let windowIdSeq = 1;
let webContentsIdSeq = 9000;
const createdWindows: FakeBrowserWindow[] = [];
let nextExecuteJavaScriptImpl:
  | ((script: string, userGesture: boolean) => Promise<unknown>)
  | null = null;
/** Same seam for `loadURL`: armed before the window this test drives exists. */
let nextLoadURLRejection: Error | null = null;

/**
 * Lets a test control the very FIRST `executeJavaScript` behaviour of the
 * NEXT window `startRecordingHelper` creates, from before that window
 * exists. Setting the fake's default only after `startRecordingHelper`
 * resolves would race the module's own internal awaits (`loadURL`,
 * `capturePage`) for who gets there first.
 */
function withNextHelperExecuteJavaScript(
  impl: (script: string, userGesture: boolean) => Promise<unknown>,
): void {
  nextExecuteJavaScriptImpl = impl;
}

class FakeHelperWebContents extends EventEmitter {
  isDestroyedFlag = false;
  readonly session = {};
  readonly executeJavaScriptCalls: Array<{
    readonly script: string;
    readonly userGesture: boolean;
  }> = [];
  /** Order of interest: did the stop script run before the window closed. */
  readonly callOrder: string[] = [];
  executeJavaScriptImpl: (
    script: string,
    userGesture: boolean,
  ) => Promise<unknown> = () => Promise.resolve(true);

  constructor(
    readonly id: number,
    public mainFrame: { processId: number; routingId: number },
  ) {
    super();
  }

  isDestroyed(): boolean {
    return this.isDestroyedFlag;
  }

  setWindowOpenHandler(_handler: unknown): void {}

  executeJavaScript(script: string, userGesture: boolean): Promise<unknown> {
    this.executeJavaScriptCalls.push({ script, userGesture });
    if (script.includes("__traycerRecordingHelper?.stop(")) {
      this.callOrder.push("stop-script");
    }
    return this.executeJavaScriptImpl(script, userGesture);
  }
}

class FakeBrowserWindow extends EventEmitter {
  isDestroyedFlag = false;
  destroyCalls = 0;
  readonly loadURLCalls: string[] = [];
  readonly webContents: FakeHelperWebContents;

  constructor(
    readonly id: number,
    frame: { processId: number; routingId: number },
  ) {
    super();
    this.webContents = new FakeHelperWebContents(webContentsIdSeq, frame);
    webContentsIdSeq += 1;
  }

  isDestroyed(): boolean {
    return this.isDestroyedFlag;
  }

  /**
   * `null` loads fine; set it to reject the way Electron does - its rejection
   * message QUOTES the failing URL, which for a helper IS the bearer token.
   */
  loadURLRejection: Error | null = null;

  loadURL(url: string): Promise<void> {
    this.loadURLCalls.push(url);
    return this.loadURLRejection === null
      ? Promise.resolve()
      : Promise.reject(this.loadURLRejection);
  }

  close(): void {
    if (this.isDestroyedFlag) return;
    this.isDestroyedFlag = true;
    this.webContents.callOrder.push("close");
    this.emit("closed");
  }

  destroy(): void {
    this.destroyCalls += 1;
    throw new Error(
      "destroy() must never be called on a recording helper window - close() only (D15 probe finding 3)",
    );
  }
}

function createFakeBrowserWindow(): FakeBrowserWindow {
  const id = windowIdSeq;
  windowIdSeq += 1;
  const frame = { processId: id, routingId: id * 1000 };
  const win = new FakeBrowserWindow(id, frame);
  if (nextLoadURLRejection !== null) {
    win.loadURLRejection = nextLoadURLRejection;
    nextLoadURLRejection = null;
  }
  if (nextExecuteJavaScriptImpl !== null) {
    win.webContents.executeJavaScriptImpl = nextExecuteJavaScriptImpl;
    nextExecuteJavaScriptImpl = null;
  }
  createdWindows.push(win);
  return win;
}

interface FakeElectronGuestWebContents {
  readonly id: number;
  isDestroyedFlag: boolean;
  isDestroyed(): boolean;
  readonly session: object;
  mainFrame: { processId: number; routingId: number };
}

const electronGuestsById = new Map<number, FakeElectronGuestWebContents>();

function registerElectronGuest(id: number): FakeElectronGuestWebContents {
  const guest: FakeElectronGuestWebContents = {
    id,
    isDestroyedFlag: false,
    isDestroyed(): boolean {
      return guest.isDestroyedFlag;
    },
    session: {},
    mainFrame: { processId: id, routingId: id * 7 },
  };
  electronGuestsById.set(id, guest);
  return guest;
}

vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor(_options: unknown) {
      return createFakeBrowserWindow();
    }
  },
  webContents: {
    fromId: (id: number): FakeElectronGuestWebContents | undefined =>
      electronGuestsById.get(id),
  },
}));

const captureSourceState: { source: RecordingCaptureSourceKind } = {
  source: "display-media",
};

vi.mock("../recording-capture-source-setting", () => ({
  DEFAULT_RECORDING_CAPTURE_SOURCE: "display-media",
  readRecordingCaptureSource: (): Promise<RecordingCaptureSourceKind> =>
    Promise.resolve(captureSourceState.source),
}));

// `log` is read EAGERLY as an object-literal shorthand inside the factory
// below, and that factory runs as soon as anything imports "../../app/logger"
// - which happens the moment the static `import ... from "../recording-helper-window"`
// below resolves, i.e. before this file's own top-level `const`s would
// otherwise have run. `vi.hoisted` is what guarantees `log` already has a
// value by then (a plain `const` here throws "Cannot access before
// initialization").
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("../../../app/logger", () => ({
  log,
  describeLogError: (error: unknown): string => String(error),
}));

import {
  activeRecordingCount,
  recordingFrameStats,
  startRecordingHelper,
  stopAllRecordingHelpers,
  stopRecordingHelper,
} from "../recording-helper-window";
import { recordingHelperRegistrationCount } from "../recording-helper-registry";

function fakeCapturedImage(
  bytes: Uint8Array,
  empty: boolean,
): BrowserViewCapturedImage {
  const image: BrowserViewCapturedImage = {
    getSize: () => ({ width: 10, height: 10 }),
    toJPEG: () => bytes,
    toDataURL: () => "data:image/jpeg;base64,AAA",
    isEmpty: () => empty,
    crop: () => image,
    toPNG: () => bytes,
  };
  return image;
}

const fakeCookieStore = {
  set: () => Promise.resolve(),
  get: () => Promise.resolve([]),
  flushStore: () => Promise.resolve(),
};

const FAKE_SESSION: BrowserStorageSession = { cookies: fakeCookieStore };

/**
 * The `BrowserViewWebContents`-shaped guest. This module only ever reads
 * `.id`, `.on`/`.off("destroyed")` and `.capturePage()` from it, so the rest
 * of the (wide) port interface is harmless stubs - but the class `implements`
 * the real interface so an instance is directly assignable where a
 * `BrowserViewWebContents` is expected, with no cast at any call site.
 */
class FakeGuestPort extends EventEmitter implements BrowserViewWebContents {
  isDestroyedFlag = false;
  capturePageImpl: () => Promise<BrowserViewCapturedImage> = () =>
    Promise.resolve(fakeCapturedImage(new Uint8Array([1, 2, 3]), false));
  readonly debugger = {
    isAttached: () => false,
    attach: () => undefined,
    detach: () => undefined,
    sendCommand: () => Promise.resolve(undefined),
    on: () => undefined,
    off: () => undefined,
  };
  readonly navigationHistory = undefined;
  readonly session = FAKE_SESSION;

  constructor(readonly id: number) {
    super();
  }

  loadURL(_url: string): Promise<unknown> {
    return Promise.resolve();
  }

  executeJavaScript(_script: string, _userGesture: boolean): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  capturePage(): Promise<BrowserViewCapturedImage> {
    return this.capturePageImpl();
  }

  getURL(): string {
    return "https://guest.test/";
  }

  getTitle(): string {
    return "Guest";
  }

  isDestroyed(): boolean {
    return this.isDestroyedFlag;
  }

  close(): void {}

  reload(): void {}

  findInPage(_text: string, _options: unknown): number {
    return 0;
  }

  stopFindInPage(_action: "clearSelection"): void {}

  getZoomFactor(): number {
    return 1;
  }

  setZoomFactor(_factor: number): void {}

  setBackgroundThrottling(_allowed: boolean): void {}

  setDevToolsWebContents(_webContents: unknown): void {}

  openDevTools(_options: unknown): void {}

  setWindowOpenHandler(_handler: unknown): void {}
}

function guestPort(id: number): BrowserViewWebContents {
  return new FakeGuestPort(id);
}

const HELPER_URL_TOKEN = "super-secret-recording-token-abc123";

function makeHelperUrl(recordingId: string): string {
  return `http://127.0.0.1:34567/browser-recording-helper?mode=record&recordingId=${recordingId}&token=${HELPER_URL_TOKEN}&source=display-media`;
}

function collectEvents(): {
  readonly events: RecordingEvent[];
  readonly onEvent: (event: RecordingEvent) => void;
} {
  const events: RecordingEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

/** Starts a display-media recording and returns handles to its window/guest. */
async function startForTest(
  recordingId: string,
  guestId: number,
): Promise<{
  readonly win: FakeBrowserWindow;
  readonly guest: FakeGuestPort;
  readonly events: RecordingEvent[];
}> {
  registerElectronGuest(guestId);
  const guest = new FakeGuestPort(guestId);
  const { events, onEvent } = collectEvents();
  const winCountBefore = createdWindows.length;

  await startRecordingHelper({
    recordingId,
    helperUrl: makeHelperUrl(recordingId),
    guest,
    source: "display-media",
    onEvent,
  });

  const win = createdWindows[winCountBefore];
  if (win === undefined) throw new Error("window was not created");
  return { win, guest, events };
}

/** Every terminal path must fire `ended` exactly once and leave nothing running. */
async function assertEndedOnce(
  events: RecordingEvent[],
  win: FakeBrowserWindow,
): Promise<void> {
  expect(events.filter((event) => event.kind === "ended")).toHaveLength(1);
  expect(activeRecordingCount()).toBe(0);
  expect(recordingHelperRegistrationCount()).toBe(0);
  await vi.waitFor(() => {
    expect(win.isDestroyed()).toBe(true);
  });
  expect(win.destroyCalls).toBe(0);
}

afterEach(async () => {
  vi.useRealTimers();
  stopAllRecordingHelpers("test-cleanup");
  await vi.waitFor(() => {
    expect(createdWindows.every((win) => win.isDestroyed())).toBe(true);
  });
  createdWindows.length = 0;
  electronGuestsById.clear();
  nextLoadURLRejection = null;
  captureSourceState.source = "display-media";
  vi.clearAllMocks();
});

describe("capture source selection", () => {
  it("uses display-media by default: grants a registration, never evaluates a frame-push script", async () => {
    registerElectronGuest(1);
    const { events, onEvent } = collectEvents();

    await startRecordingHelper({
      recordingId: "src-default",
      helperUrl: makeHelperUrl("src-default"),
      guest: guestPort(1),
      source: null,
      onEvent,
    });

    expect(recordingHelperRegistrationCount()).toBe(1);
    const win = createdWindows.at(-1);
    if (win === undefined) throw new Error("window missing");
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === "helperReady")).toBe(true);
    });
    expect(
      win.webContents.executeJavaScriptCalls.some((call) =>
        call.script.includes("__traycerRecordingFrames"),
      ),
    ).toBe(false);
    expect(
      win.webContents.executeJavaScriptCalls.some((call) =>
        call.script.includes("__traycerRecordingHelper.start("),
      ),
    ).toBe(true);
  });

  it("uses capture-page under a machine override: no grant, frames ARE pushed", async () => {
    captureSourceState.source = "capture-page";
    registerElectronGuest(2);
    const port = new FakeGuestPort(2);
    const { events, onEvent } = collectEvents();

    await startRecordingHelper({
      recordingId: "src-override",
      helperUrl: makeHelperUrl("src-override"),
      guest: port,
      source: null,
      onEvent,
    });

    expect(recordingHelperRegistrationCount()).toBe(0);
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === "helperReady")).toBe(true);
    });
    const win = createdWindows.at(-1);
    if (win === undefined) throw new Error("window missing");
    expect(
      win.webContents.executeJavaScriptCalls.some((call) =>
        call.script.includes("__traycerRecordingFrames"),
      ),
    ).toBe(true);
    expect(recordingFrameStats("src-override").pushed).toBeGreaterThan(0);
  });
});

describe("the source= query parameter", () => {
  it("replaces the host's own source= under a machine override; mode/recordingId/token survive", async () => {
    registerElectronGuest(6);
    const { onEvent } = collectEvents();
    const winCountBefore = createdWindows.length;

    await startRecordingHelper({
      recordingId: "url-params",
      helperUrl: makeHelperUrl("url-params"), // already carries source=display-media
      guest: guestPort(6),
      source: "capture-page",
      onEvent,
    });

    const win = createdWindows[winCountBefore];
    if (win === undefined) throw new Error("window missing");
    const loadedUrl = win.loadURLCalls[0];
    if (loadedUrl === undefined) throw new Error("loadURL never called");
    const parsed = new URL(loadedUrl);
    expect(parsed.searchParams.get("source")).toBe("capture-page");
    expect(parsed.searchParams.get("mode")).toBe("record");
    expect(parsed.searchParams.get("recordingId")).toBe("url-params");
    expect(parsed.searchParams.get("token")).toBe(HELPER_URL_TOKEN);
  });

  it("keeps display-media when the explicit source matches the host's own", async () => {
    registerElectronGuest(7);
    const { onEvent } = collectEvents();
    const winCountBefore = createdWindows.length;

    await startRecordingHelper({
      recordingId: "url-params-default",
      helperUrl: makeHelperUrl("url-params-default"),
      guest: guestPort(7),
      source: "display-media",
      onEvent,
    });

    const win = createdWindows[winCountBefore];
    if (win === undefined) throw new Error("window missing");
    const loadedUrl = win.loadURLCalls[0];
    if (loadedUrl === undefined) throw new Error("loadURL never called");
    expect(new URL(loadedUrl).searchParams.get("source")).toBe("display-media");
  });
});

describe("recordingHelperReady", () => {
  it("is emitted exactly once", async () => {
    const { events } = await startForTest("ready-once", 5);

    await vi.waitFor(() => {
      expect(
        events.filter((event) => event.kind === "helperReady"),
      ).toHaveLength(1);
    });
    expect(events.filter((event) => event.kind === "helperReady")).toHaveLength(
      1,
    );
  });
});

describe("capture-page frame stats", () => {
  it("counts pushed frames and how many differ from the one before", async () => {
    vi.useFakeTimers();
    registerElectronGuest(3);
    const port = new FakeGuestPort(3);
    const sameBytes = new Uint8Array([9, 9, 9]);
    port.capturePageImpl = () =>
      Promise.resolve(fakeCapturedImage(sameBytes, false));
    const { onEvent } = collectEvents();

    await startRecordingHelper({
      recordingId: "frames-distinct",
      helperUrl: makeHelperUrl("frames-distinct"),
      guest: port,
      source: "capture-page",
      onEvent,
    });
    await flushMicrotasks();

    expect(recordingFrameStats("frames-distinct")).toEqual({
      pushed: 1,
      distinct: 1,
    });

    await vi.advanceTimersByTimeAsync(150);

    expect(recordingFrameStats("frames-distinct")).toEqual({
      pushed: 2,
      distinct: 1,
    });
  });

  it("ends the recording when the document exposes no capture-page frame sink", async () => {
    registerElectronGuest(4);
    const { events, onEvent } = collectEvents();
    withNextHelperExecuteJavaScript((script) =>
      script.includes("__traycerRecordingFrames")
        ? Promise.resolve(false)
        : Promise.resolve(true),
    );

    await startRecordingHelper({
      recordingId: "no-sink",
      helperUrl: makeHelperUrl("no-sink"),
      guest: guestPort(4),
      source: "capture-page",
      onEvent,
    });

    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === "ended")).toBe(true);
    });
    const ended = events.find((event) => event.kind === "ended");
    if (ended === undefined || ended.kind !== "ended") {
      throw new Error("no ended event was recorded");
    }
    expect(ended.reason).toBe("helper-start-failed");
  });
});

describe("recordingEnded fires exactly once on every terminal path", () => {
  it("stopRecordingHelper", async () => {
    const { win, events } = await startForTest("end-stop", 101);
    stopRecordingHelper("end-stop", "host-stop");
    await assertEndedOnce(events, win);
  });

  it("the helper window emitting closed", async () => {
    const { win, events } = await startForTest("end-window-closed", 102);
    win.close();
    await assertEndedOnce(events, win);
  });

  it("the helper webContents emitting render-process-gone", async () => {
    const { win, events } = await startForTest("end-rpg", 103);
    win.webContents.emit("render-process-gone");
    await assertEndedOnce(events, win);
  });

  it("the helper webContents emitting did-fail-load for its main frame", async () => {
    const { win, events } = await startForTest("end-did-fail-load", 104);
    win.webContents.emit(
      "did-fail-load",
      {},
      -6,
      "ERR_FAILED",
      "http://helper.test/",
      true,
    );
    await assertEndedOnce(events, win);
  });

  it("ignores a did-fail-load for a subframe", async () => {
    const { win, events } = await startForTest("end-subframe-fail", 110);
    win.webContents.emit(
      "did-fail-load",
      {},
      -6,
      "ERR_FAILED",
      "http://helper.test/sub",
      false,
    );
    await flushMicrotasks();
    expect(events.some((event) => event.kind === "ended")).toBe(false);
    expect(activeRecordingCount()).toBe(1);
    stopRecordingHelper("end-subframe-fail", "test-cleanup");
    await assertEndedOnce(events, win);
  });

  it("the guest webContents emitting destroyed", async () => {
    const { win, guest, events } = await startForTest(
      "end-guest-destroyed",
      105,
    );
    guest.emit("destroyed");
    await assertEndedOnce(events, win);
  });

  it("stopAllRecordingHelpers", async () => {
    const { win, events } = await startForTest("end-stop-all", 106);
    stopAllRecordingHelpers("app-quit");
    await assertEndedOnce(events, win);
  });

  it("finalizes the helper (runs the stop script) before closing its window", async () => {
    const { win, events } = await startForTest("end-order", 107);

    stopRecordingHelper("end-order", "host-stop");
    await assertEndedOnce(events, win);

    const stopIndex = win.webContents.callOrder.indexOf("stop-script");
    const closeIndex = win.webContents.callOrder.indexOf("close");
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(stopIndex);
  });
});

describe("no orphan across many recordings", () => {
  it("leaves no orphan after 20 start/stop cycles on the same guest", async () => {
    registerElectronGuest(200);
    const guest = new FakeGuestPort(200);
    const guestPortHandle: BrowserViewWebContents = guest;
    const windowsBefore = createdWindows.length;

    for (let i = 0; i < 20; i += 1) {
      const recordingId = `cycle-${i}`;
      const winCountBefore = createdWindows.length;

      await startRecordingHelper({
        recordingId,
        helperUrl: makeHelperUrl(recordingId),
        guest: guestPortHandle,
        source: "display-media",
        onEvent: () => undefined,
      });

      const win = createdWindows[winCountBefore];
      if (win === undefined) throw new Error("window missing");
      stopRecordingHelper(recordingId, "cycle-teardown");
      await vi.waitFor(() => {
        expect(win.isDestroyed()).toBe(true);
      });
    }

    expect(activeRecordingCount()).toBe(0);
    expect(recordingHelperRegistrationCount()).toBe(0);
    expect(
      createdWindows.slice(windowsBefore).every((win) => win.isDestroyed()),
    ).toBe(true);
    expect(guest.listenerCount("destroyed")).toBe(0);
  });
});

describe("rejections before a window exists", () => {
  it("rejects a second start with the same recordingId without disturbing the first", async () => {
    const { win } = await startForTest("dup-id", 108);

    await expect(
      startRecordingHelper({
        recordingId: "dup-id",
        helperUrl: makeHelperUrl("dup-id"),
        guest: guestPort(9108),
        source: "display-media",
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(/already running/);

    expect(activeRecordingCount()).toBe(1);
    expect(win.isDestroyed()).toBe(false);
  });

  it("rejects before creating a window when the guest cannot be resolved via webContents.fromId", async () => {
    // Deliberately not registered in `electronGuestsById`.
    const winCountBefore = createdWindows.length;

    await expect(
      startRecordingHelper({
        recordingId: "no-electron-guest",
        helperUrl: makeHelperUrl("no-electron-guest"),
        guest: guestPort(999999),
        source: "display-media",
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(/not available for recording/);

    expect(createdWindows.length).toBe(winCountBefore);
  });
});

describe("log safety", () => {
  it("never logs the helper URL or its bearer token", async () => {
    const { events } = await startForTest("log-safety", 300);
    // Exercise a load-failure path too - it is the one listener that logs a
    // field (`errorCode`) plaintext alongside the recording id.
    const winCountBefore = createdWindows.length;
    registerElectronGuest(301);
    await startRecordingHelper({
      recordingId: "log-safety-2",
      helperUrl: makeHelperUrl("log-safety-2"),
      guest: guestPort(301),
      source: "display-media",
      onEvent: () => undefined,
    });
    const win2 = createdWindows[winCountBefore];
    if (win2 === undefined) throw new Error("window missing");
    win2.webContents.emit(
      "did-fail-load",
      {},
      -6,
      "ERR_FAILED",
      "http://helper.test/",
      true,
    );

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
      expect(log.warn.mock.calls.length).toBeGreaterThan(0);
    });

    const allCalls = [...log.info.mock.calls, ...log.warn.mock.calls];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const call of allCalls) {
      expect(JSON.stringify(call)).not.toContain(HELPER_URL_TOKEN);
    }
  });

  it("never logs the URL Electron quotes back in a loadURL rejection", async () => {
    // Electron rejects `loadURL` with `ERR_FAILED (-2) loading '<url>'`, and
    // that URL carries the recording's one-shot bearer. The rejection is the
    // one error on this path that a WARN line renders verbatim.
    registerElectronGuest(320);
    const helperUrl = makeHelperUrl("load-reject");
    nextLoadURLRejection = new Error(
      `ERR_CONNECTION_REFUSED (-102) loading '${helperUrl}'`,
    );
    const events: RecordingEvent[] = [];
    await startRecordingHelper({
      recordingId: "load-reject",
      helperUrl,
      guest: guestPort(320),
      source: "display-media",
      onEvent: (event) => {
        events.push(event);
      },
    });

    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === "ended")).toBe(true);
    });
    const allCalls = [...log.info.mock.calls, ...log.warn.mock.calls];
    for (const call of allCalls) {
      expect(JSON.stringify(call)).not.toContain(HELPER_URL_TOKEN);
    }
  });
});
