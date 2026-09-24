import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../../ipc-contracts/ipc-channels";
import type { DesktopPublishedHostSnapshot } from "../../../ipc-contracts/host-types";
import type { HostLifecycleView } from "../../../ipc-contracts/host-lifecycle-types";
import type {
  HostQuitDecision,
  HostQuitDecisionResponse,
  HostQuitStateEvent,
} from "../../../ipc-contracts/host-quit-types";
import type {
  IpcHostLifecycle,
  IpcManagedWindow,
  IpcWindowRecord,
  IpcWindowRegistry,
  HostQuitPrompt,
} from "../runner-ipc-bridge";
// Imported at module scope (after the hoisted `vi.mock`s), not inside a test:
// the cold load of the bridge graph must not be charged to one test's timeout.
import { RunnerIpcBridge } from "../register-runner-ipc";
import { DesktopAuthSession } from "../../auth/desktop-auth-session";
import { EpicWindowOwnership } from "../../windows/epic-window-ownership";
import { PerWindowState } from "../../windows/per-window-state";
import type { WindowSummary } from "../../../ipc-contracts/window-types";
import { QuitTransactions } from "../../startup/quit-transaction";
import { FakeHostController } from "./fake-host-controller";

// The host quit round-trip through the REAL `RunnerIpcBridge`
// (`requestHostQuitDecision`, the `hostQuit*` handlers and the window-state
// pruning), with the quit transaction on top where the fallback to the native
// dialog is the claim. Same `electron` boundary as `runner-ipc.test.ts`.

const featureSettings = vi.hoisted(() => ({ agentRoles: false }));
/**
 * `app`-level event listeners, recorded rather than discarded so a test can
 * drive them. `epic-visibility-ipc.ts` registers a `render-process-gone`
 * listener here to clear a crashed window's visible-Epic row.
 */
const appEventState = vi.hoisted(() => ({
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
}));
const readFeatureSettingsMock = vi.hoisted(() =>
  vi.fn(async () => ({ agentRoles: featureSettings.agentRoles })),
);
const setAgentRolesEnabledMock = vi.hoisted(() =>
  vi.fn(async (enabled: boolean) => {
    featureSettings.agentRoles = enabled;
  }),
);
vi.mock("@traycer/protocol/config/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traycer/protocol/config/store")>()),
  readFeatureSettings: readFeatureSettingsMock,
  setAgentRolesEnabled: setAgentRolesEnabledMock,
}));

/**
 * Runner-IPC bridge tests. We mock `electron` so the bridge can install its
 * handlers against a plain-JS `ipcMain` double, then drive the host and
 * tray dependencies directly to assert the event/invoke surface the preload
 * bridge depends on.
 */

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => unknown | Promise<unknown>;

type SyncHandler = (
  event: { returnValue: unknown },
  ...args: unknown[]
) => void;

const ipcMainState = {
  handlers: new Map<string, InvokeHandler>(),
  syncListeners: new Map<string, Set<SyncHandler>>(),
};

interface SentMessage {
  readonly channel: string;
  readonly payload: unknown;
}

vi.mock("@sentry/electron/main", () => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: (): string => "1.0.0",
    getPath: (_key: string): string => "/tmp/traycer-desktop-test",
    // The selection-authority binding listens for `render-process-gone` here
    // (a crashed renderer must be reported as a detach, or its announced
    // sessions would suppress the death counter forever).
    on: (event: string, listener: (...args: unknown[]) => void): void => {
      const existing = appEventState.listeners.get(event) ?? new Set();
      existing.add(listener);
      appEventState.listeners.set(event, existing);
    },
    off: (event: string, listener: (...args: unknown[]) => void): void => {
      appEventState.listeners.get(event)?.delete(listener);
    },
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
    encryptString: (_value: string): Buffer => Buffer.from("", "utf8"),
    decryptString: (_buf: Buffer): string => "",
  },
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve("")),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
  },
  Notification: {
    isSupported: (): boolean => false,
  },
  powerSaveBlocker: {
    start: vi.fn(() => 1),
    stop: vi.fn(),
    isStarted: vi.fn(() => true),
  },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler): void => {
      ipcMainState.handlers.set(channel, handler);
    },
    removeHandler: (channel: string): void => {
      ipcMainState.handlers.delete(channel);
    },
    on: (channel: string, listener: SyncHandler): void => {
      let set = ipcMainState.syncListeners.get(channel);
      if (set === undefined) {
        set = new Set();
        ipcMainState.syncListeners.set(channel, set);
      }
      set.add(listener);
    },
    removeListener: (channel: string, listener: SyncHandler): void => {
      ipcMainState.syncListeners.get(channel)?.delete(listener);
    },
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

class FakeHost extends EventEmitter implements IpcHostLifecycle {
  private snapshot: DesktopPublishedHostSnapshot | null = null;
  noteEndpointAnsweredCalls = 0;
  notifyRespawningCalls = 0;
  reloadSnapshotCalls = 0;
  ensureWatcherCalls = 0;
  // Mutable so the identity-seed suite can point them at real files in a temp
  // dir. Everything else keeps the unwritable defaults, which is what makes a
  // handler that reads them without being asked to fail loudly.
  pidMetadataFile = "/tmp/fake-traycer-host/pid.json";
  identityEnrollmentFile = "/tmp/fake-traycer-host/identity/enrollment.json";
  isDisposed = false;

  getSnapshot(): DesktopPublishedHostSnapshot | null {
    return this.snapshot;
  }

  noteEndpointAnswered(): void {
    this.noteEndpointAnsweredCalls += 1;
  }

  setSnapshot(next: DesktopPublishedHostSnapshot | null): void {
    this.snapshot = next;
    this.emit("change", next);
  }

  notifyRespawning(): void {
    this.notifyRespawningCalls += 1;
    this.snapshot = null;
    this.emit("change", null);
  }
  async reloadSnapshotFromDisk(): Promise<DesktopPublishedHostSnapshot | null> {
    this.reloadSnapshotCalls += 1;
    return this.getSnapshot();
  }
  ensureWatcherInstalled(): void {
    this.ensureWatcherCalls += 1;
  }
  async installService(): Promise<void> {}
  async uninstallService(_purge: boolean): Promise<void> {}
  async startService(): Promise<void> {}
  async stopService(): Promise<void> {}
  async restartService(): Promise<void> {}
  async upgradeService(): Promise<void> {}
  async enableLinger(): Promise<void> {}
  async getRecentLogTail(_maxLines: number): Promise<string | null> {
    return null;
  }
}

class TestWindow implements IpcManagedWindow {
  readonly sent: SentMessage[] = [];
  visible: boolean;
  private readonly order: string[];
  private readonly name: string;
  constructor(order: string[], name: string, visible: boolean) {
    this.order = order;
    this.name = name;
    this.visible = visible;
  }
  isDestroyed(): boolean {
    return false;
  }
  isFocused(): boolean {
    return false;
  }
  isVisible(): boolean {
    return this.visible;
  }
  show(): void {
    this.visible = true;
    this.order.push(`${this.name}:show`);
  }
  focus(): void {
    this.order.push(`${this.name}:focus`);
  }
  readonly webContents = {
    send: (channel: string, payload: unknown): void => {
      this.sent.push({ channel, payload });
      this.order.push(`${this.name}:send:${channel}`);
    },
  };
  sentOn(channel: string): readonly SentMessage[] {
    return this.sent.filter((message) => message.channel === channel);
  }
}

class TestRegistry implements IpcWindowRegistry {
  private readonly recordsById = new Map<string, IpcWindowRecord>();
  private mru: string | null = null;
  private readonly listeners = new Set<() => void>();

  add(windowId: string, webContentsId: number, window: IpcManagedWindow): void {
    this.recordsById.set(windowId, { windowId, webContentsId, window });
    this.mru = windowId;
  }
  remove(windowId: string): void {
    this.recordsById.delete(windowId);
    if (this.mru === windowId)
      this.mru = this.records().at(-1)?.windowId ?? null;
  }
  create(): Promise<string> {
    return Promise.reject(new Error("not used"));
  }
  closeById(): Promise<void> {
    return Promise.resolve();
  }
  forceCloseById(): Promise<void> {
    return Promise.resolve();
  }
  focusMru(): boolean {
    return this.mru !== null && this.focusById(this.mru);
  }
  focusById(windowId: string): boolean {
    const record = this.recordsById.get(windowId);
    if (record === undefined) return false;
    if (!record.window.isVisible()) record.window.show();
    record.window.focus();
    this.mru = windowId;
    return true;
  }
  list(): readonly WindowSummary[] {
    return this.records().map((record) => ({
      windowId: record.windowId,
      title: record.windowId,
      isFocused: record.windowId === this.mru,
      isVisible: record.window.isVisible(),
    }));
  }
  records(): readonly IpcWindowRecord[] {
    return Array.from(this.recordsById.values());
  }
  getRecordById(windowId: string): IpcWindowRecord | null {
    return this.recordsById.get(windowId) ?? null;
  }
  getRecordByWebContentsId(webContentsId: number): IpcWindowRecord | null {
    return (
      this.records().find((record) => record.webContentsId === webContentsId) ??
      null
    );
  }
  getMruRecord(): IpcWindowRecord | null {
    return this.mru === null ? null : this.getRecordById(this.mru);
  }
  mostRecentlyFocusedId(): string | null {
    return this.mru;
  }
  on(_event: "change" | "geometry", listener: () => void): void {
    this.listeners.add(listener);
  }
  off(_event: "change" | "geometry", listener: () => void): void {
    this.listeners.delete(listener);
  }
}

function sender(webContentsId: number): {
  readonly sender: { readonly id: number };
  readonly senderFrame: { readonly parent: null };
} {
  return { sender: { id: webContentsId }, senderFrame: { parent: null } };
}

const VIEW: HostLifecycleView = {
  desired: { mode: "ask", rev: 1, updatedBy: "desktop", updatedAt: null },
  applied: { localHostCapability: "managed", supervisor: "not-running" },
  pending: "none",
};

const ASK_PROMPT: HostQuitPrompt = { mode: "ask", round: "initial" };

interface Fixture {
  readonly bridge: RunnerIpcBridge;
  readonly registry: TestRegistry;
  readonly order: string[];
  readonly w1: TestWindow;
  readonly w2: TestWindow;
  invoke(channel: string, webContentsId: number, payload: unknown): unknown;
  /** The window's preload reported a live quit-modal subscriber. */
  listen(webContentsId: number): void;
  ack(webContentsId: number, requestId: string): void;
  requestIdOf(window: TestWindow): string;
}

const bridges: RunnerIpcBridge[] = [];

async function newFixture(w1Visible: boolean): Promise<Fixture> {
  const order: string[] = [];
  const registry = new TestRegistry();
  const w1 = new TestWindow(order, "w1", w1Visible);
  const w2 = new TestWindow(order, "w2", true);
  registry.add("window-2", 102, w2);
  registry.add("window-1", 101, w1);
  const bridge = new RunnerIpcBridge({
    host: new FakeHost(),
    hostController: new FakeHostController(),
    authnBaseUrl: "http://localhost:5005",
    authRedirectUri: null,
    tray: null,
    zoomController: undefined,
    authTokenStore: undefined,
    windowRegistry: registry,
    ownership: new EpicWindowOwnership(null),
    perWindowState: new PerWindowState(null),
    authSession: new DesktopAuthSession(),
    quitState: undefined,
  });
  bridge.install();
  bridges.push(bridge);
  const invoke = (
    channel: string,
    webContentsId: number,
    payload: unknown,
  ): unknown => {
    const handler = ipcMainState.handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return handler(sender(webContentsId), payload);
  };
  return {
    bridge,
    registry,
    order,
    w1,
    w2,
    invoke,
    listen: (id) => {
      invoke(RunnerHostInvoke.hostQuitListening, id, true);
    },
    ack: (id, requestId) => {
      invoke(RunnerHostInvoke.hostQuitAcknowledge, id, requestId);
    },
    requestIdOf: (window) => {
      const message = window.sentOn(RunnerHostEvent.hostQuitRequest).at(-1);
      if (message === undefined) throw new Error("no hostQuit request sent");
      const payload = message.payload as { requestId: string };
      return payload.requestId;
    },
  };
}

function cancelledStates(window: TestWindow): readonly HostQuitStateEvent[] {
  return window
    .sentOn(RunnerHostEvent.hostQuitState)
    .map((message) => message.payload as HostQuitStateEvent)
    .filter((event) => event.phase === "cancelled");
}

/** A transaction over the real bridge, with the native dialog recorded. */
function transactionsOver(fixture: Fixture): {
  readonly txs: QuitTransactions;
  readonly nativeAsked: HostQuitDecision[];
  readonly native: { answer: HostQuitDecision };
  readonly authorized: () => number;
  readonly stopped: () => number;
} {
  const nativeAsked: HostQuitDecision[] = [];
  const native: { answer: HostQuitDecision } = { answer: { kind: "cancel" } };
  let authorized = 0;
  let stopped = 0;
  const txs = new QuitTransactions({
    isInstallingUpdate: () => false,
    lifecycle: {
      readQuitPolicy: async () => ({ mode: "ask", rev: 1 }),
      writeQuitVerdict: async () => "written",
      releaseQuitVerdict: async () => undefined,
      setMode: async () => ({ kind: "applied", view: VIEW }),
    },
    controller: {
      stopHost: async () => {
        stopped += 1;
        return { kind: "stopped", forced: true };
      },
      holdAutomaticIntents: () => ({ release: () => undefined }),
      quiesce: () => undefined,
    },
    requestDecision: (prompt) => fixture.bridge.requestHostQuitDecision(prompt),
    withdrawDecision: (error) => {
      fixture.bridge.withdrawHostQuitDecisions(error);
    },
    askNatively: async () => {
      nativeAsked.push(native.answer);
      return native.answer;
    },
    publishState: (event) => {
      fixture.bridge.publishHostQuitState(event);
    },
    unsyncedEditsGate: async () => "proceed",
    runUpdateInstallSequence: async () => undefined,
    authorizeQuitAfterFlush: () => {
      authorized += 1;
    },
    authorizeQuitNow: () => undefined,
    stayOpen: () => undefined,
    revealStopping: () => undefined,
    setStoppingIndicator: () => undefined,
    revealDelayMs: 1_000,
    deadlineMs: 15_000,
  });
  return {
    txs,
    nativeAsked,
    native,
    authorized: () => authorized,
    stopped: () => stopped,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

async function settlesWithin(promise: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol("pending");
  const raced = await Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    Promise.resolve(sentinel),
  ]);
  return raced === "settled";
}

beforeEach(() => {
  ipcMainState.handlers.clear();
  ipcMainState.syncListeners.clear();
});

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("requestHostQuitDecision through the real bridge", () => {
  it("a window that never subscribed rejects at once with ZERO sends; once it listens, the same request is sent exactly once", async () => {
    const fixture = await newFixture(true);
    await expect(
      fixture.bridge.requestHostQuitDecision(ASK_PROMPT),
    ).rejects.toThrow(/not listening for host quit requests/);
    expect(fixture.w1.sentOn(RunnerHostEvent.hostQuitRequest)).toEqual([]);
    expect(fixture.w2.sentOn(RunnerHostEvent.hostQuitRequest)).toEqual([]);
    expect(fixture.bridge.hostQuitListeningWindowIds.has("window-1")).toBe(
      false,
    );

    fixture.listen(101);
    expect(fixture.bridge.hostQuitListeningWindowIds.has("window-1")).toBe(
      true,
    );
    fixture.bridge
      .requestHostQuitDecision({ mode: "stop-if-idle", round: "busy-retry" })
      .catch(() => undefined);
    const sent = fixture.w1.sentOn(RunnerHostEvent.hostQuitRequest);
    expect(sent).toEqual([
      {
        channel: RunnerHostEvent.hostQuitRequest,
        payload: {
          requestId: expect.any(String),
          mode: "stop-if-idle",
          round: "busy-retry",
        },
      },
    ]);
    // Only the MRU window was asked.
    expect(fixture.w2.sentOn(RunnerHostEvent.hostQuitRequest)).toEqual([]);
  });

  it("the request payload for a 'busy' round is exactly {requestId, mode, round} - no busyMessage key", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    fixture.bridge
      .requestHostQuitDecision({ mode: "stop-if-idle", round: "busy" })
      .catch(() => undefined);
    const [sent] = fixture.w1.sentOn(RunnerHostEvent.hostQuitRequest);
    expect(sent?.payload).toEqual({
      requestId: expect.any(String),
      mode: "stop-if-idle",
      round: "busy",
    });
    expect(Object.keys(sent?.payload as object).sort()).toEqual([
      "mode",
      "requestId",
      "round",
    ]);
  });

  it("shows and focuses the target window BEFORE the request is sent", async () => {
    const fixture = await newFixture(false);
    fixture.listen(101);
    fixture.bridge.requestHostQuitDecision(ASK_PROMPT).catch(() => undefined);
    // Filtered to this window's show / focus / quit-request send: other
    // fan-out traffic is not the claim.
    expect(
      fixture.order.filter(
        (entry) =>
          entry === "w1:show" ||
          entry === "w1:focus" ||
          entry === `w1:send:${RunnerHostEvent.hostQuitRequest}`,
      ),
    ).toEqual([
      "w1:show",
      "w1:focus",
      `w1:send:${RunnerHostEvent.hostQuitRequest}`,
    ]);
  });

  it("subscribed but never acknowledged: rejects after the service ack budget, and a cancelled state for that requestId is published", async () => {
    vi.useFakeTimers();
    const fixture = await newFixture(true);
    fixture.listen(101);
    const decision = fixture.bridge.requestHostQuitDecision(ASK_PROMPT);
    const requestId = fixture.requestIdOf(fixture.w1);
    const rejection = expect(decision).rejects.toThrow(
      /did not acknowledge servicing/,
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(cancelledStates(fixture.w1)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(cancelledStates(fixture.w1)).toEqual([
      { requestId, phase: "cancelled" },
    ]);
  });

  it("an acknowledged request waits past the ack budget (positive control for the timeout)", async () => {
    vi.useFakeTimers();
    const fixture = await newFixture(true);
    fixture.listen(101);
    const decision = fixture.bridge.requestHostQuitDecision(ASK_PROMPT);
    fixture.ack(101, fixture.requestIdOf(fixture.w1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settlesWithin(decision)).toBe(false);
  });

  it("acked, then the window closes: rejected as closed, and the survivor hears cancelled", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const decision = fixture.bridge.requestHostQuitDecision(ASK_PROMPT);
    const requestId = fixture.requestIdOf(fixture.w1);
    fixture.ack(101, requestId);
    const rejection = expect(decision).rejects.toThrow(
      /window closed before resolving/,
    );
    fixture.registry.remove("window-1");
    fixture.bridge.pruneClosedWindowState();
    await rejection;
    expect(fixture.bridge.hostQuitListeningWindowIds.has("window-1")).toBe(
      false,
    );
    expect(cancelledStates(fixture.w2)).toEqual([
      { requestId, phase: "cancelled" },
    ]);
  });

  it("acked, then the renderer resets: rejected, and the window is no longer listening", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const decision = fixture.bridge.requestHostQuitDecision(ASK_PROMPT);
    fixture.ack(101, fixture.requestIdOf(fixture.w1));
    const rejection = expect(decision).rejects.toThrow(/Renderer reset/);
    fixture.bridge.markRendererUnavailable("window-1");
    await rejection;
    expect(fixture.bridge.hostQuitListeningWindowIds.has("window-1")).toBe(
      false,
    );
    // The reset window must be re-asked natively, not sent another request.
    await expect(
      fixture.bridge.requestHostQuitDecision(ASK_PROMPT),
    ).rejects.toThrow(/not listening/);
  });

  it("listening:false after an ack rejects that window's pending request", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const decision = fixture.bridge.requestHostQuitDecision(ASK_PROMPT);
    fixture.ack(101, fixture.requestIdOf(fixture.w1));
    const rejection = expect(decision).rejects.toThrow(/stopped listening/);
    fixture.invoke(RunnerHostInvoke.hostQuitListening, 101, false);
    await rejection;
    expect(fixture.bridge.hostQuitListeningWindowIds.has("window-1")).toBe(
      false,
    );
  });

  it("a malformed listening payload changes nothing", async () => {
    const fixture = await newFixture(true);
    fixture.invoke(RunnerHostInvoke.hostQuitListening, 101, "yes");
    expect(fixture.bridge.hostQuitListeningWindowIds.has("window-1")).toBe(
      false,
    );
  });

  it("respond: a valid decision resolves {requestId, decision}", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const decision = fixture.bridge.requestHostQuitDecision(ASK_PROMPT);
    const requestId = fixture.requestIdOf(fixture.w1);
    fixture.ack(101, requestId);
    const answer: HostQuitDecision = {
      kind: "stop",
      force: true,
      remember: false,
    };
    fixture.invoke(RunnerHostInvoke.hostQuitRespond, 101, {
      requestId,
      decision: answer,
    });
    await expect(decision).resolves.toEqual({ requestId, decision: answer });
  });

  it("respond: an unknown or stale requestId is ignored and the live request stays pending", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const decision = fixture.bridge.requestHostQuitDecision(ASK_PROMPT);
    const requestId = fixture.requestIdOf(fixture.w1);
    fixture.ack(101, requestId);
    const cancel: HostQuitDecision = { kind: "cancel" };
    fixture.invoke(RunnerHostInvoke.hostQuitRespond, 101, {
      requestId: "not-a-live-request",
      decision: cancel,
    });
    await flush();
    expect(await settlesWithin(decision)).toBe(false);
    // Positive: the real id still settles it.
    fixture.invoke(RunnerHostInvoke.hostQuitRespond, 101, {
      requestId,
      decision: cancel,
    });
    await expect(decision).resolves.toEqual({ requestId, decision: cancel });
  });

  it("respond: an answer from a window other than the target is ignored", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const decision = fixture.bridge.requestHostQuitDecision(ASK_PROMPT);
    const requestId = fixture.requestIdOf(fixture.w1);
    fixture.ack(101, requestId);
    fixture.invoke(RunnerHostInvoke.hostQuitRespond, 102, {
      requestId,
      decision: { kind: "cancel" },
    });
    await flush();
    expect(await settlesWithin(decision)).toBe(false);
  });

  it("respond: a malformed decision for a live request rejects it", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const bad: unknown[] = [
      { kind: "stop", force: "yes", remember: false },
      { kind: "keep" },
      { kind: "explode" },
      "stop",
      null,
    ];
    for (const value of bad) {
      const decision = fixture.bridge.requestHostQuitDecision(ASK_PROMPT);
      const requestId = fixture.requestIdOf(fixture.w1);
      fixture.ack(101, requestId);
      const rejection = expect(decision).rejects.toThrow(/malformed/);
      fixture.invoke(RunnerHostInvoke.hostQuitRespond, 101, {
        requestId,
        decision: value,
      });
      await rejection;
    }
  });

  it("a newer request supersedes the window's older one, and dispose rejects what is pending", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const first = fixture.bridge.requestHostQuitDecision(ASK_PROMPT);
    const firstRejection = expect(first).rejects.toThrow(/superseded/);
    const second = fixture.bridge.requestHostQuitDecision(ASK_PROMPT);
    await firstRejection;
    const secondRejection = expect(second).rejects.toThrow(/disposed/);
    fixture.bridge.dispose();
    await secondRejection;
  });
});

describe("quit transaction over the real bridge: the native fallback", () => {
  it("MRU never subscribed: the transaction asks natively with zero renderer sends", async () => {
    const fixture = await newFixture(true);
    const rig = transactionsOver(fixture);
    rig.native.answer = { kind: "keep", remember: false };
    rig.txs.onBeforeQuit();
    await vi.waitFor(() => {
      expect(rig.authorized()).toBe(1);
    });
    expect(rig.nativeAsked).toHaveLength(1);
    expect(fixture.w1.sentOn(RunnerHostEvent.hostQuitRequest)).toEqual([]);
  });

  it("subscribed but no ack: native follows, and the abandoned request is told cancelled", async () => {
    vi.useFakeTimers();
    const fixture = await newFixture(true);
    fixture.listen(101);
    const rig = transactionsOver(fixture);
    rig.native.answer = { kind: "cancel" };
    rig.txs.onBeforeQuit();
    await vi.advanceTimersByTimeAsync(0);
    const requestId = fixture.requestIdOf(fixture.w1);
    expect(rig.nativeAsked).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(rig.nativeAsked).toHaveLength(1);
    expect(cancelledStates(fixture.w1)).toContainEqual({
      requestId,
      phase: "cancelled",
    });
    expect(rig.authorized()).toBe(0);
  });

  it("acked, then the window's renderer resets: native follows", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const rig = transactionsOver(fixture);
    rig.native.answer = { kind: "keep", remember: false };
    rig.txs.onBeforeQuit();
    await vi.waitFor(() => {
      expect(fixture.w1.sentOn(RunnerHostEvent.hostQuitRequest)).toHaveLength(
        1,
      );
    });
    fixture.ack(101, fixture.requestIdOf(fixture.w1));
    expect(rig.nativeAsked).toHaveLength(0);
    fixture.bridge.markRendererUnavailable("window-1");
    await vi.waitFor(() => {
      expect(rig.authorized()).toBe(1);
    });
    expect(rig.nativeAsked).toHaveLength(1);
  });

  it("acked, then the window closes: native follows and the transaction completes on the native answer", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const rig = transactionsOver(fixture);
    rig.native.answer = { kind: "keep", remember: false };
    rig.txs.onBeforeQuit();
    await vi.waitFor(() => {
      expect(fixture.w1.sentOn(RunnerHostEvent.hostQuitRequest)).toHaveLength(
        1,
      );
    });
    const requestId = fixture.requestIdOf(fixture.w1);
    fixture.ack(101, requestId);
    expect(rig.nativeAsked).toHaveLength(0);
    expect(rig.authorized()).toBe(0);

    fixture.registry.remove("window-1");
    fixture.bridge.pruneClosedWindowState();

    await vi.waitFor(() => {
      expect(rig.authorized()).toBe(1);
    });
    expect(rig.nativeAsked).toEqual([{ kind: "keep", remember: false }]);
    expect(rig.stopped()).toBe(0);
    expect(cancelledStates(fixture.w2)).toContainEqual({
      requestId,
      phase: "cancelled",
    });
  });

  it("a malformed decision for the live request: native follows", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const rig = transactionsOver(fixture);
    rig.native.answer = { kind: "keep", remember: false };
    rig.txs.onBeforeQuit();
    await vi.waitFor(() => {
      expect(fixture.w1.sentOn(RunnerHostEvent.hostQuitRequest)).toHaveLength(
        1,
      );
    });
    const requestId = fixture.requestIdOf(fixture.w1);
    fixture.ack(101, requestId);
    fixture.invoke(RunnerHostInvoke.hostQuitRespond, 101, {
      requestId,
      decision: { kind: "stop" },
    });
    await vi.waitFor(() => {
      expect(rig.authorized()).toBe(1);
    });
    expect(rig.nativeAsked).toHaveLength(1);
    expect(rig.stopped()).toBe(0);
  });

  it("positive control: a valid renderer answer means NO native dialog, and the stop runs", async () => {
    const fixture = await newFixture(true);
    fixture.listen(101);
    const rig = transactionsOver(fixture);
    rig.txs.onBeforeQuit();
    await vi.waitFor(() => {
      expect(fixture.w1.sentOn(RunnerHostEvent.hostQuitRequest)).toHaveLength(
        1,
      );
    });
    const requestId = fixture.requestIdOf(fixture.w1);
    fixture.ack(101, requestId);
    const response: HostQuitDecisionResponse = {
      requestId,
      decision: { kind: "stop", force: true, remember: false },
    };
    fixture.invoke(RunnerHostInvoke.hostQuitRespond, 101, response);
    await vi.waitFor(() => {
      expect(rig.authorized()).toBe(1);
    });
    expect(rig.nativeAsked).toHaveLength(0);
    expect(rig.stopped()).toBe(1);
    const states = fixture.w1
      .sentOn(RunnerHostEvent.hostQuitState)
      .map((message) => message.payload);
    expect(states).toEqual([
      { requestId, phase: "stopping", idleOnly: false },
      { requestId, phase: "quitting" },
    ]);
  });
});
