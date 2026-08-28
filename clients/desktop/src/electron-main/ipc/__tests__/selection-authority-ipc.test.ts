import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListFetchResult } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import {
  RunnerHostEvent,
  RunnerHostSync,
  SelectionAuthorityChannels,
} from "../../../ipc-contracts/ipc-channels";
import type { DesktopPublishedHostSnapshot } from "../../../ipc-contracts/host-types";
import type {
  IpcHostController,
  IpcManagedWindow,
  IpcWindowRecord,
  IpcWindowRegistry,
} from "../runner-ipc-bridge";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  ConvergeReadyOk,
  HostControllerStatus,
  LifecycleAdmissionBlock,
  InstallVersionOk,
  MutationOutcome,
  MutationProgress,
  RemoveTraycerOk,
  ServiceRegistrationOk,
  UninstallOk,
} from "../../host/host-controller-types";
import { DesktopAuthSession } from "../../auth/desktop-auth-session";
import { EpicWindowOwnership } from "../../windows/epic-window-ownership";
import { PerWindowState } from "../../windows/per-window-state";
import type { WindowSummary } from "../../../ipc-contracts/window-types";

/**
 * Main-process binding tests for the selection authority (P1.1). Harness
 * style copied from `runner-ipc.test.ts`: a plain-JS `ipcMain` double behind
 * the `electron` mock, `ipcMainState`, `sender()`, `FakeWindowRegistry`,
 * `FakeHost`, `FakeHostController`, `buildWindow()`.
 *
 * `fetchRegisteredHostsViaHttp` is hard-wired into `registerSelectionAuthorityIpc`
 * (main composes `DesktopHostFleetSource` with the real HTTP fetcher, not an
 * injected one) so fleet membership is driven here by mocking that module -
 * the only seam available without touching production wiring.
 */

const fetchRegisteredHostsMock = vi.hoisted(() => vi.fn());
vi.mock(
  "@traycer-clients/shared/host-client/remote-fetcher",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-client/remote-fetcher")
    >()),
    fetchRegisteredHostsViaHttp: fetchRegisteredHostsMock,
  }),
);

const featureSettings = vi.hoisted(() => ({ agentRoles: false }));
vi.mock("@traycer/protocol/config/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traycer/protocol/config/store")>()),
  readFeatureSettings: vi.fn(async () => ({
    agentRoles: featureSettings.agentRoles,
  })),
  setAgentRolesEnabled: vi.fn(async (enabled: boolean) => {
    featureSettings.agentRoles = enabled;
  }),
}));

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

type AppEventListener = (event: unknown, contents: { id: number }) => void;

/**
 * B1: the `render-process-gone` subscription lives on `app`, not `ipcMain`.
 * Captured here (unlike the inert double in `runner-ipc.test.ts`) so this
 * suite can fire the handler and assert `app.off` on teardown.
 */
const appState = {
  listeners: new Map<string, Set<AppEventListener>>(),
};

function fireRenderProcessGone(webContentsId: number): void {
  const listeners = appState.listeners.get("render-process-gone");
  if (listeners === undefined || listeners.size === 0) {
    throw new Error("no render-process-gone listener registered");
  }
  for (const listener of listeners) {
    listener(undefined, { id: webContentsId });
  }
}

interface SentMessage {
  readonly channel: string;
  readonly payload: unknown;
}

interface CapturingWindow extends IpcManagedWindow {
  readonly sentMessages: SentMessage[];
}

const sentMessages: SentMessage[] = [];

vi.mock("@sentry/electron/main", () => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: (): string => "1.0.0",
    getPath: (_key: string): string => "/tmp/traycer-desktop-test",
    on: (event: string, listener: AppEventListener): void => {
      let set = appState.listeners.get(event);
      if (set === undefined) {
        set = new Set();
        appState.listeners.set(event, set);
      }
      set.add(listener);
    },
    off: (event: string, listener: AppEventListener): void => {
      appState.listeners.get(event)?.delete(listener);
    },
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
    encryptString: (_value: string): Buffer => Buffer.from("", "utf8"),
    decryptString: (_buf: Buffer): string => "",
  },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  Notification: { isSupported: (): boolean => false },
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

const electronLogWarnMock = vi.hoisted(() => vi.fn());
vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: electronLogWarnMock,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

class FakeHost {
  private snapshot: DesktopPublishedHostSnapshot | null = null;
  pidMetadataFile = "/tmp/fake-traycer-host-selection/pid.json";
  identityEnrollmentFile =
    "/tmp/fake-traycer-host-selection/identity/enrollment.json";
  isDisposed = false;
  private readonly listeners = new Set<
    (snapshot: DesktopPublishedHostSnapshot | null) => void
  >();

  getSnapshot(): DesktopPublishedHostSnapshot | null {
    return this.snapshot;
  }
  on(
    _event: "change",
    listener: (snapshot: DesktopPublishedHostSnapshot | null) => void,
  ): void {
    this.listeners.add(listener);
  }
  off(
    _event: "change",
    listener: (snapshot: DesktopPublishedHostSnapshot | null) => void,
  ): void {
    this.listeners.delete(listener);
  }
  noteEndpointAnswered(): void {}
  notifyRespawning(): void {}
  async reloadSnapshotFromDisk(): Promise<DesktopPublishedHostSnapshot | null> {
    return this.snapshot;
  }
  ensureWatcherInstalled(): void {}
  async getRecentLogTail(_maxLines: number): Promise<string | null> {
    return null;
  }
}

function buildControllerStatus(): HostControllerStatus {
  return {
    download: null,
    mutation: null,
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    stagedVersion: null,
    installedRuntimeVersion: "1.0.0",
    runningRuntimeVersion: "1.0.0",
    updateReady: false,
    activation: "activated",
    reachable: true,
    removedByUser: false,
    checkedAt: "2026-01-01T00:00:00.000Z",
  };
}

class FakeHostController implements IpcHostController {
  readonly lifecycleAdmissionBlock: LifecycleAdmissionBlock | null = null;
  async getStatus(): Promise<HostControllerStatus> {
    return buildControllerStatus();
  }
  async convergeReady(
    _force: boolean,
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    return { kind: "ok", value: { running: true, version: "1.0.0" } };
  }
  async stageLatest(): Promise<void> {}
  async applyStaged(
    _trigger: ApplyStagedTrigger,
    _force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    return {
      kind: "ok",
      value: { appliedVersion: "1.0.0", runningActivated: true },
    };
  }
  async activateInstalled(
    _force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    return { kind: "ok", value: { activated: true } };
  }
  async installVersion(
    pin: string,
    _force: boolean,
  ): Promise<MutationOutcome<InstallVersionOk>> {
    return {
      kind: "ok",
      value: { installedVersion: pin, runningActivated: true },
    };
  }
  async registerService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return { kind: "ok", value: { registered: true } };
  }
  async deregisterService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return { kind: "ok", value: { registered: false } };
  }
  async respawn(): Promise<MutationOutcome<ActivateInstalledOk>> {
    return { kind: "ok", value: { activated: true } };
  }
  async recoverIfDown(): Promise<
    MutationOutcome<ActivateInstalledOk> | { readonly kind: "suppressed" }
  > {
    return { kind: "suppressed" };
  }
  async freePortAndRestart(
    _pid: number | null,
    _port: number | null,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    return { kind: "ok", value: { activated: true } };
  }
  async uninstallHost(_all: boolean): Promise<MutationOutcome<UninstallOk>> {
    return {
      kind: "ok",
      value: {
        removedInstallDir: true,
        deregisteredService: true,
        serviceRegistrationRetained: null,
      },
    };
  }
  async removeTraycer(): Promise<MutationOutcome<RemoveTraycerOk>> {
    return {
      kind: "ok",
      value: {
        removedHost: true,
        deregisteredService: true,
        serviceRegistrationRetained: null,
        removedLoginItem: false,
      },
    };
  }
  isPendingRevisionRefreshQuarantined(): boolean {
    return false;
  }
  onMutationProgress(
    _listener: (progress: MutationProgress) => void,
  ): () => void {
    return () => undefined;
  }
}

function buildWindow(): CapturingWindow {
  let destroyed = false;
  const messages: SentMessage[] = [];
  return {
    sentMessages: messages,
    isDestroyed: () => destroyed,
    isFocused: () => false,
    isVisible: () => true,
    show: () => undefined,
    focus: () => undefined,
    webContents: {
      send: (channel: string, payload: unknown): void => {
        const message = { channel, payload };
        messages.push(message);
        sentMessages.push(message);
      },
    },
  };
}

class FakeWindowRegistry implements IpcWindowRegistry {
  private readonly recordsByWindowId = new Map<string, IpcWindowRecord>();
  private readonly windowIdByWebContentsId = new Map<number, string>();
  private readonly listeners = new Set<() => void>();
  private mruWindowId: string | null = null;

  add(windowId: string, webContentsId: number, window: IpcManagedWindow): void {
    this.recordsByWindowId.set(windowId, { windowId, webContentsId, window });
    this.windowIdByWebContentsId.set(webContentsId, windowId);
    this.mruWindowId = windowId;
    this.emitChange();
  }

  remove(windowId: string): void {
    const record = this.recordsByWindowId.get(windowId);
    if (record === undefined) return;
    this.recordsByWindowId.delete(windowId);
    this.windowIdByWebContentsId.delete(record.webContentsId);
    if (this.mruWindowId === windowId) {
      this.mruWindowId = this.records().at(-1)?.windowId ?? null;
    }
    this.emitChange();
  }

  create(_options: {
    readonly initialRoute: string | null;
    readonly beforeLoad: ((windowId: string) => void) | null;
  }): Promise<string> {
    return Promise.reject(new Error("not used by this suite"));
  }
  closeById(windowId: string): Promise<void> {
    this.remove(windowId);
    return Promise.resolve();
  }
  forceCloseById(windowId: string): Promise<void> {
    this.remove(windowId);
    return Promise.resolve();
  }
  focusMru(): boolean {
    return this.mruWindowId !== null;
  }
  focusById(_windowId: string): boolean {
    return true;
  }
  list(): readonly WindowSummary[] {
    return Array.from(this.recordsByWindowId.values()).map((record) => ({
      windowId: record.windowId,
      title: record.windowId,
      isFocused: record.windowId === this.mruWindowId,
      isVisible: record.window.isVisible(),
    }));
  }
  records(): readonly IpcWindowRecord[] {
    return Array.from(this.recordsByWindowId.values());
  }
  getRecordById(windowId: string): IpcWindowRecord | null {
    return this.recordsByWindowId.get(windowId) ?? null;
  }
  getRecordByWebContentsId(webContentsId: number): IpcWindowRecord | null {
    const windowId = this.windowIdByWebContentsId.get(webContentsId);
    return windowId === undefined ? null : this.getRecordById(windowId);
  }
  getMruRecord(): IpcWindowRecord | null {
    return this.mruWindowId === null
      ? null
      : this.getRecordById(this.mruWindowId);
  }
  mostRecentlyFocusedId(): string | null {
    return this.mruWindowId;
  }
  on(_event: "change", listener: () => void): void {
    this.listeners.add(listener);
  }
  off(_event: "change", listener: () => void): void {
    this.listeners.delete(listener);
  }
  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

function sender(webContentsId: number): {
  readonly sender: { readonly id: number };
  readonly senderFrame: { readonly parent: null };
} {
  return {
    sender: { id: webContentsId },
    senderFrame: { parent: null },
  };
}

function invokeSyncWithSender(channel: string, webContentsId: number): unknown {
  const listeners = ipcMainState.syncListeners.get(channel);
  if (listeners === undefined || listeners.size === 0) {
    throw new Error(`no sync listener registered for ${channel}`);
  }
  const event: {
    returnValue: unknown;
    sender: { id: number };
    senderFrame: { parent: null };
  } = {
    returnValue: undefined,
    sender: { id: webContentsId },
    senderFrame: { parent: null },
  };
  for (const listener of listeners) listener(event);
  return event.returnValue;
}

function buildHostListItem(hostId: string): HostListItem {
  return {
    hostId,
    displayName: null,
    platform: null,
    kind: "personal",
    publicKey: "pub-key",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    updatePolicy: "manual",
  };
}

function signedInSnapshot(userId: string, token: string) {
  return {
    status: "signed-in" as const,
    token,
    profile: { userId, userName: userId, email: `${userId}@example.com` },
  };
}

/** Flushes both microtasks and the real fs/HTTP-shaped I/O awaits fleet reads go through. */
function flushIo(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * The registry-fetch count once the module's OWN seed refresh has actually
 * reached the fetcher.
 *
 * `flushIo()` is a fixed 10ms sleep, and the seed's path to the fetcher runs a
 * real `readLastKnownLocalHostId` fs read first. On a loaded runner that does
 * not finish inside 10ms, so a baseline taken after `flushIo()` read ZERO and
 * the seed's late call then landed inside the window under test - the delta
 * came out one too high and the suite failed in CI while passing everywhere
 * else. Waiting on the observable rather than on a clock is what makes the
 * baseline mean "the seed is done".
 *
 * Deliberately asserts the seed HAPPENED: if registration ever stops seeding,
 * this times out loudly instead of silently handing back a zero that makes the
 * delta assertions look satisfied.
 */
async function settledSeedFetchCount(): Promise<number> {
  await vi.waitFor(() => {
    expect(fetchRegisteredHostsMock.mock.calls.length).toBeGreaterThan(0);
  });
  return fetchRegisteredHostsMock.mock.calls.length;
}

interface Snapshot {
  readonly contractVersion: number;
  readonly revision: number;
  readonly preferredHostId: string | null;
  readonly targetHostId: string | null;
  readonly effectiveHostId: string | null;
  readonly leases: readonly unknown[];
}

type AttachResult =
  | {
      readonly ok: true;
      readonly incarnationId: string;
      readonly snapshot: Snapshot;
    }
  | {
      readonly ok: false;
      readonly kind: string;
      readonly [key: string]: unknown;
    };

function isOkAttach(
  result: unknown,
): result is { ok: true; incarnationId: string; snapshot: Snapshot } {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { ok: unknown }).ok === true
  );
}

async function attachOk(
  handler: InvokeHandler,
  webContentsId: number,
  attachSeq: unknown,
  liveSessions: readonly unknown[],
): Promise<{ incarnationId: string; snapshot: Snapshot }> {
  const result = await handler(sender(webContentsId), {
    attachSeq,
    callerContractVersion: 1,
    liveSessions,
  });
  if (!isOkAttach(result)) {
    throw new Error(`expected ok attach, got ${JSON.stringify(result)}`);
  }
  return result;
}

beforeEach(() => {
  ipcMainState.handlers.clear();
  ipcMainState.syncListeners.clear();
  appState.listeners.clear();
  sentMessages.length = 0;
  fetchRegisteredHostsMock.mockReset();
  fetchRegisteredHostsMock.mockResolvedValue({ kind: "network-error" });
  featureSettings.agentRoles = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

async function buildBridge(options: {
  readonly signedIn?: { readonly userId: string; readonly token: string };
}) {
  const mod = await import("../register-runner-ipc");
  const registry = new FakeWindowRegistry();
  const authSession = new DesktopAuthSession();
  if (options.signedIn !== undefined) {
    authSession.set(
      signedInSnapshot(options.signedIn.userId, options.signedIn.token),
    );
  }
  const bridge = new mod.RunnerIpcBridge({
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
    authSession,
    quitState: undefined,
  });
  return { bridge, registry, authSession };
}

/**
 * The LAST message on `channel` this window has received, waiting for one to
 * exist first.
 *
 * The fan-out crosses a scheduling boundary: an awaited invoke resolves when
 * the ENGINE has applied the change, which is not when the broadcast has
 * reached the other windows. Reading `sentMessages` synchronously right after
 * therefore passes on a fast machine and fails under CI load - three separate
 * tests in this file have failed that way.
 *
 * Waits only for the message to EXIST. Callers assert its payload themselves,
 * unchanged: waiting on the payload would make those assertions true by
 * construction, which is the opposite of what they are for.
 */
async function lastMessageOn(
  window: CapturingWindow,
  channel: string,
): Promise<SentMessage> {
  await vi.waitFor(() => {
    expect(window.sentMessages.some((m) => m.channel === channel)).toBe(true);
  });
  const found = window.sentMessages
    .filter((message) => message.channel === channel)
    .at(-1);
  if (found === undefined) {
    throw new Error(`no ${channel} message after wait`);
  }
  return found;
}

function attachHandler(): InvokeHandler {
  const handler = ipcMainState.handlers.get(
    SelectionAuthorityChannels.invoke.attach,
  );
  if (handler === undefined) throw new Error("attach handler missing");
  return handler;
}
function evidenceHandler(): InvokeHandler {
  const handler = ipcMainState.handlers.get(
    SelectionAuthorityChannels.invoke.reportEvidence,
  );
  if (handler === undefined) throw new Error("reportEvidence handler missing");
  return handler;
}
function activateHandler(): InvokeHandler {
  const handler = ipcMainState.handlers.get(
    SelectionAuthorityChannels.invoke.activate,
  );
  if (handler === undefined) throw new Error("activate handler missing");
  return handler;
}
function refreshFleetHandler(): InvokeHandler {
  const handler = ipcMainState.handlers.get(
    SelectionAuthorityChannels.invoke.refreshFleet,
  );
  if (handler === undefined) throw new Error("refreshFleet handler missing");
  return handler;
}

describe("selection authority IPC binding", () => {
  it("serves the attach-seq sync channel: known sender gets a number, unknown gets null, repeats increase", async () => {
    const { bridge, registry } = await buildBridge({});
    const windowA = buildWindow();
    registry.add("window-a", 101, windowA);
    bridge.install();

    const first = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
    expect(typeof first).toBe("number");

    const unknown = invokeSyncWithSender(
      RunnerHostSync.selectionAttachSeq,
      999,
    );
    expect(unknown).toBeNull();

    const second = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
    expect(typeof second).toBe("number");
    expect(second as number).toBeGreaterThan(first as number);

    bridge.dispose();
  });

  describe("attach choreography", () => {
    it("(a) an unparseable seq is state-neutral - zero engine calls, then the real seq still attaches", async () => {
      const { bridge, registry } = await buildBridge({});
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();
      const handler = attachHandler();

      // Issue the real seq FIRST: an unparseable-seq attempt that (wrongly)
      // consumed an already-issued generation would show up here as the
      // later real attach coming back `superseded` instead of `ok: true`.
      const seq = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);

      await expect(handler(sender(101), {})).resolves.toEqual({
        ok: false,
        kind: "malformed-request",
        claimed: false,
      });
      await expect(handler(sender(101), { attachSeq: 1.5 })).resolves.toEqual({
        ok: false,
        kind: "malformed-request",
        claimed: false,
      });

      const result = await handler(sender(101), {
        attachSeq: seq,
        callerContractVersion: 1,
        liveSessions: [],
      });
      expect(isOkAttach(result)).toBe(true);

      bridge.dispose();
    });

    it("(b) a malformed envelope for the latest seq claims it; a same-seq replay is claimed:false and superseded thereafter", async () => {
      const { bridge, registry } = await buildBridge({});
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();
      const handler = attachHandler();

      const seq = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);

      await expect(
        handler(sender(101), { attachSeq: seq, callerContractVersion: 1 }),
      ).resolves.toEqual({
        ok: false,
        kind: "malformed-request",
        claimed: true,
      });

      // Replay with the SAME (now-consumed) seq, still malformed.
      await expect(
        handler(sender(101), { attachSeq: seq, callerContractVersion: 1 }),
      ).resolves.toEqual({
        ok: false,
        kind: "malformed-request",
        claimed: false,
      });

      // No corrected-envelope replay either: the same seq, now with a
      // well-formed envelope, is refused as superseded (the generation is
      // terminated).
      await expect(
        handler(sender(101), {
          attachSeq: seq,
          callerContractVersion: 1,
          liveSessions: [],
        }),
      ).resolves.toEqual({ ok: false, kind: "superseded" });

      bridge.dispose();
    });

    it("(c) the happy path resolves ok:true with contractVersion, a numeric revision and a leases array", async () => {
      const { bridge, registry } = await buildBridge({});
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();
      const handler = attachHandler();

      const seq = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      const result = await attachOk(handler, 101, seq, []);

      expect(typeof result.incarnationId).toBe("string");
      expect(result.snapshot.contractVersion).toBe(1);
      expect(typeof result.snapshot.revision).toBe("number");
      expect(Array.isArray(result.snapshot.leases)).toBe(true);

      bridge.dispose();
    });

    it("(d) a wrong callerContractVersion resolves version-mismatch naming both versions", async () => {
      const { bridge, registry } = await buildBridge({});
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();
      const handler = attachHandler();

      const seq = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      await expect(
        handler(sender(101), {
          attachSeq: seq,
          callerContractVersion: 99,
          liveSessions: [],
        }),
      ).resolves.toEqual({
        ok: false,
        kind: "version-mismatch",
        authorityVersion: 1,
        callerVersion: 99,
      });

      bridge.dispose();
    });
  });

  describe("reportEvidence", () => {
    it("drops an unparseable report without throwing", async () => {
      const { bridge, registry } = await buildBridge({});
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();
      const attach = attachHandler();
      const seq = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      const { incarnationId } = await attachOk(attach, 101, seq, []);

      const evidence = evidenceHandler();
      await expect(
        evidence(sender(101), incarnationId, { kind: "bogus" }),
      ).resolves.toBeUndefined();

      bridge.dispose();
    });

    it("drops a well-formed report stamped with a stale incarnation", async () => {
      const { bridge, registry } = await buildBridge({});
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();
      const attach = attachHandler();

      const seq1 = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      const first = await attachOk(attach, 101, seq1, []);
      const staleIncarnationId = first.incarnationId;

      // A second attach for the same window retires the first incarnation.
      const seq2 = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      const second = await attachOk(attach, 101, seq2, []);
      expect(second.incarnationId).not.toBe(staleIncarnationId);

      const evidence = evidenceHandler();
      await expect(
        evidence(sender(101), staleIncarnationId, {
          kind: "dial",
          hostId: "stale-host",
          attemptId: "attempt-1",
          outcome: "confirmed-refusal",
          refusalDetail: null,
          transportKind: "local-ws",
          at: 0,
        }),
      ).resolves.toBeUndefined();

      bridge.dispose();
    });

    it("ingests a well-formed report on the live incarnation, observed through the leasesChanged fan-out", async () => {
      fetchRegisteredHostsMock.mockResolvedValue({
        kind: "ok",
        response: { hosts: [buildHostListItem("evidence-host")] },
      });
      const { bridge, registry } = await buildBridge({
        signedIn: { userId: "user-a", token: "token-1" },
      });
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();
      await flushIo();

      // Membership landed: a leasesChanged fan-out carrying evidence-host in
      // "connecting" state should already have reached the window.
      const membershipMessage = await lastMessageOn(
        windowA,
        RunnerHostEvent.selectionLeasesChanged,
      );
      expect(membershipMessage).toBeDefined();
      windowA.sentMessages.length = 0;

      const attach = attachHandler();
      const seq = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      const { incarnationId } = await attachOk(attach, 101, seq, []);
      windowA.sentMessages.length = 0;

      const evidence = evidenceHandler();
      for (let i = 0; i < 3; i += 1) {
        await evidence(sender(101), incarnationId, {
          kind: "dial",
          hostId: "evidence-host",
          attemptId: `attempt-${i}`,
          outcome: "confirmed-refusal",
          refusalDetail: null,
          transportKind: "local-ws",
          at: i,
        });
      }

      const deadMessage = await lastMessageOn(
        windowA,
        RunnerHostEvent.selectionLeasesChanged,
      );
      expect(deadMessage).toBeDefined();
      expect(deadMessage?.payload).toMatchObject({
        change: [
          {
            hostId: "evidence-host",
            status: "dead",
            dead: { reason: "offline" },
          },
        ],
      });

      bridge.dispose();
    });
  });

  describe("activate", () => {
    it("resolves not-attached for a stale incarnation and unknown-host for a live one naming a host outside the fleet (F14)", async () => {
      const { bridge, registry } = await buildBridge({});
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();
      const attach = attachHandler();

      const seq1 = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      const first = await attachOk(attach, 101, seq1, []);
      const staleIncarnationId = first.incarnationId;

      const seq2 = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      const second = await attachOk(attach, 101, seq2, []);

      const activate = activateHandler();
      await expect(
        activate(sender(101), staleIncarnationId, "some-host"),
      ).resolves.toEqual({ ok: false, reason: "not-attached" });

      // P1.2: the write is directory-validated at the engine, so a live
      // incarnation naming a host the fleet does not hold is refused with
      // `unknown-host` - the arm that stops a stale id being re-asserted.
      await expect(
        activate(sender(101), second.incarnationId, "some-host"),
      ).resolves.toEqual({ ok: false, reason: "unknown-host" });

      bridge.dispose();
    });

    it("P1.2 acceptance seam: ONE Activate from window A re-derives BOTH attached windows to the same effective host", async () => {
      fetchRegisteredHostsMock.mockResolvedValue({
        kind: "ok",
        response: { hosts: [buildHostListItem("shared-host")] },
      });
      const { bridge, registry } = await buildBridge({
        signedIn: { userId: "user-a", token: "token-1" },
      });
      const windowA = buildWindow();
      const windowB = buildWindow();
      registry.add("window-a", 101, windowA);
      registry.add("window-b", 202, windowB);
      bridge.install();
      await flushIo();

      const attach = attachHandler();
      const seqA = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      const attachA = await attachOk(attach, 101, seqA, []);
      const seqB = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 202);
      await attachOk(attach, 202, seqB, []);

      windowA.sentMessages.length = 0;
      windowB.sentMessages.length = 0;

      const activate = activateHandler();
      await expect(
        activate(sender(101), attachA.incarnationId, "shared-host"),
      ).resolves.toEqual({ ok: true });

      // Both windows - not just the one that called Activate - see the SAME
      // re-derived effective host over their own selectionChanged fan-out.
      // There is exactly one authority; a second window's view is never a
      // separately-derived answer.
      for (const window of [windowA, windowB]) {
        const selectionMessage = await lastMessageOn(
          window,
          RunnerHostEvent.selectionChanged,
        );
        expect(selectionMessage).toBeDefined();
        expect(selectionMessage?.payload).toMatchObject({
          change: {
            preferredHostId: "shared-host",
            targetHostId: "shared-host",
            effectiveHostId: "shared-host",
            cause: "activate",
          },
        });
      }

      bridge.dispose();
    });
  });

  it("fans selectionChanged, leasesChanged and reattachRequired out to every window", async () => {
    fetchRegisteredHostsMock.mockResolvedValue({
      kind: "ok",
      response: { hosts: [] },
    });
    const { bridge, registry, authSession } = await buildBridge({
      signedIn: { userId: "user-a", token: "token-1" },
    });
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    bridge.install();
    await flushIo();

    windowA.sentMessages.length = 0;
    windowB.sentMessages.length = 0;

    // An identity change is the simplest trigger for reattachRequired (it
    // rides the mandatory post-transition transaction).
    authSession.set(signedInSnapshot("user-b", "token-2"));

    for (const window of [windowA, windowB]) {
      await lastMessageOn(window, RunnerHostEvent.selectionReattachRequired);
      const channels = new Set(window.sentMessages.map((m) => m.channel));
      expect(channels.has(RunnerHostEvent.selectionReattachRequired)).toBe(
        true,
      );
    }

    bridge.dispose();
  });

  it("delivers the FULL aggregated snapshot to a late-attaching window, at the revision the fan-out last used", async () => {
    fetchRegisteredHostsMock.mockResolvedValue({
      kind: "ok",
      response: { hosts: [buildHostListItem("seam-host")] },
    });
    const { bridge, registry } = await buildBridge({
      signedIn: { userId: "user-a", token: "token-1" },
    });
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    bridge.install();
    await flushIo();

    const attach = attachHandler();
    const seqA = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
    await attachOk(attach, 101, seqA, []);

    const revisionedChannels = new Set<string>([
      RunnerHostEvent.selectionChanged,
      RunnerHostEvent.selectionLeasesChanged,
      RunnerHostEvent.selectionReattachRequired,
    ]);
    const revisionsSeenBy = (window: CapturingWindow): readonly number[] =>
      window.sentMessages
        .filter((message) => revisionedChannels.has(message.channel))
        .map((message) => (message.payload as { revision: number }).revision);

    // The registry fetch that puts seam-host in the fleet settles on its own
    // schedule, and until it does there is nothing to fan out: window A holds
    // ZERO revisioned messages and `Math.max()` over that empty list is
    // -Infinity, which is what this compared against under CI load. Wait for
    // the FACT that the fleet publish reached A before attaching late; the
    // assertion below is unchanged and still reads both sides for real.
    await vi.waitFor(() => {
      expect(revisionsSeenBy(windowA).length).toBeGreaterThan(0);
    });

    // Window B attaches LATE, carrying a live session for seam-host - this
    // itself may move the lease and produce one more event.
    const seqB = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 202);
    const late = await attachOk(attach, 202, seqB, [
      { hostId: "seam-host", sessionId: "sess-b", transportKind: "local-ws" },
    ]);

    // ...and when it does, that event reaches A across a scheduling boundary
    // too, so the snapshot would otherwise be compared against a fan-out that
    // has not finished. Wait on the MONOTONIC fact (A caught up to at least
    // the snapshot's revision) rather than on the equality itself - waiting on
    // the equality would make the assertion below true by construction, and an
    // overshooting fan-out would stop being observable.
    await vi.waitFor(() => {
      expect(Math.max(...revisionsSeenBy(windowA))).toBeGreaterThanOrEqual(
        late.snapshot.revision,
      );
    });

    const lastFannedOutRevision = Math.max(...revisionsSeenBy(windowA));

    expect(late.snapshot.revision).toBe(lastFannedOutRevision);

    bridge.dispose();
  });

  it("takes reporter identity from the SENDER: two windows get independent generations, neither affecting the other", async () => {
    const { bridge, registry } = await buildBridge({});
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    bridge.install();
    const attach = attachHandler();

    // Allocation is a PER-REPORTER counter (module header rules 1/4), so both
    // windows' first seq is independently 1 - not a shared global sequence.
    const seqA1 = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
    const seqB1 = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 202);
    expect(seqA1).toBe(1);
    expect(seqB1).toBe(1);

    const resultA = await attachOk(attach, 101, seqA1, []);
    const resultB = await attachOk(attach, 202, seqB1, []);
    expect(resultA.incarnationId).not.toBe(resultB.incarnationId);

    // A new allocation for A must not touch B's still-live attachment.
    invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);

    const evidence = evidenceHandler();
    // B's incarnation is unaffected by A's fresh allocation - a report on it
    // is still accepted (does not throw, and is not treated as stale).
    await expect(
      evidence(sender(202), resultB.incarnationId, {
        kind: "dial",
        hostId: "irrelevant-host",
        attemptId: "b-attempt-1",
        outcome: "success",
        transportKind: "local-ws",
        at: 0,
      }),
    ).resolves.toBeUndefined();

    bridge.dispose();
  });

  it("detaches a reporter on window close: its sessions stop suppressing the death counter for the other window's refusals", async () => {
    fetchRegisteredHostsMock.mockResolvedValue({
      kind: "ok",
      response: { hosts: [buildHostListItem("close-host")] },
    });
    const { bridge, registry } = await buildBridge({
      signedIn: { userId: "user-a", token: "token-1" },
    });
    const windowA = buildWindow();
    const windowB = buildWindow();
    registry.add("window-a", 101, windowA);
    registry.add("window-b", 202, windowB);
    bridge.install();
    await flushIo();

    const attach = attachHandler();
    const seqA = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
    await attachOk(attach, 101, seqA, [
      { hostId: "close-host", sessionId: "sess-a", transportKind: "local-ws" },
    ]);

    const seqB = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 202);
    const { incarnationId: incarnationB } = await attachOk(
      attach,
      202,
      seqB,
      [],
    );

    const evidence = evidenceHandler();
    // While A's live session exists, B's refusals are suppressed - never
    // accumulated toward death.
    for (let i = 0; i < 2; i += 1) {
      await evidence(sender(202), incarnationB, {
        kind: "dial",
        hostId: "close-host",
        attemptId: `suppressed-${i}`,
        outcome: "confirmed-refusal",
        refusalDetail: null,
        transportKind: "local-ws",
        at: i,
      });
    }
    windowB.sentMessages.length = 0;

    // Close window A - a hard teardown; the registry drops it.
    registry.remove("window-a");

    for (let i = 0; i < 3; i += 1) {
      await evidence(sender(202), incarnationB, {
        kind: "dial",
        hostId: "close-host",
        attemptId: `after-close-${i}`,
        outcome: "confirmed-refusal",
        refusalDetail: null,
        transportKind: "local-ws",
        at: i,
      });
    }

    // Several leasesChanged events fire across the close + refusal sequence;
    // the final one is the one that must show `dead`. The fan-out crosses a
    // scheduling boundary the awaited ingest does not cover, so wait for the
    // FACT (a lease message arrived) with a bounded poll rather than assuming
    // delivery landed by the time the awaits return - under CI load it has
    // not (this went red on the darwin job while green in every local run).
    await vi.waitFor(() => {
      expect(
        windowB.sentMessages.some(
          (message) =>
            message.channel === RunnerHostEvent.selectionLeasesChanged,
        ),
      ).toBe(true);
    });
    const leaseMessages = windowB.sentMessages.filter(
      (message) => message.channel === RunnerHostEvent.selectionLeasesChanged,
    );
    const deadMessage = leaseMessages.at(-1);
    expect(deadMessage).toBeDefined();
    expect(deadMessage?.payload).toMatchObject({
      change: [{ hostId: "close-host", status: "dead" }],
    });

    bridge.dispose();
  });

  it("bridge.dispose() tears the binding down: no more fan-out, sync/invoke handlers removed", async () => {
    const { bridge, registry, authSession } = await buildBridge({
      signedIn: { userId: "user-a", token: "token-1" },
    });
    const windowA = buildWindow();
    registry.add("window-a", 101, windowA);
    bridge.install();
    await flushIo();

    expect(
      ipcMainState.handlers.has(SelectionAuthorityChannels.invoke.attach),
    ).toBe(true);
    expect(
      ipcMainState.syncListeners.get(RunnerHostSync.selectionAttachSeq)?.size,
    ).toBeGreaterThan(0);

    bridge.dispose();

    expect(
      ipcMainState.handlers.has(SelectionAuthorityChannels.invoke.attach),
    ).toBe(false);
    expect(
      ipcMainState.handlers.has(
        SelectionAuthorityChannels.invoke.reportEvidence,
      ),
    ).toBe(false);
    expect(
      ipcMainState.handlers.has(SelectionAuthorityChannels.invoke.activate),
    ).toBe(false);
    expect(
      ipcMainState.syncListeners.get(RunnerHostSync.selectionAttachSeq)?.size ??
        0,
    ).toBe(0);

    windowA.sentMessages.length = 0;
    authSession.set(signedInSnapshot("user-b", "token-2"));
    await flushIo();
    expect(windowA.sentMessages).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // P1.1 fixup round: reviewer-named coverage gaps (B1-B3).
  // ---------------------------------------------------------------------

  describe("render-process-gone detachment (B1)", () => {
    it("detaches the reporter on render-process-gone: its announced session no longer suppresses the other window's death counter", async () => {
      fetchRegisteredHostsMock.mockResolvedValue({
        kind: "ok",
        response: { hosts: [buildHostListItem("crash-host")] },
      });
      const { bridge, registry } = await buildBridge({
        signedIn: { userId: "user-a", token: "token-1" },
      });
      const windowA = buildWindow();
      const windowB = buildWindow();
      registry.add("window-a", 101, windowA);
      registry.add("window-b", 202, windowB);
      bridge.install();
      await flushIo();

      const attach = attachHandler();
      const seqA = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      await attachOk(attach, 101, seqA, [
        {
          hostId: "crash-host",
          sessionId: "sess-a",
          transportKind: "local-ws",
        },
      ]);

      const seqB = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 202);
      const { incarnationId: incarnationB } = await attachOk(
        attach,
        202,
        seqB,
        [],
      );

      const evidence = evidenceHandler();
      // Window A's live session suppresses B's refusals while it is announced.
      for (let i = 0; i < 2; i += 1) {
        await evidence(sender(202), incarnationB, {
          kind: "dial",
          hostId: "crash-host",
          attemptId: `suppressed-${i}`,
          outcome: "confirmed-refusal",
          refusalDetail: null,
          transportKind: "local-ws",
          at: i,
        });
      }
      windowB.sentMessages.length = 0;

      // Window A's renderer crashes but the WINDOW survives (stays in the
      // registry) - only `render-process-gone` reports the detach.
      fireRenderProcessGone(101);
      expect(registry.getRecordById("window-a")).not.toBeNull();

      for (let i = 0; i < 3; i += 1) {
        await evidence(sender(202), incarnationB, {
          kind: "dial",
          hostId: "crash-host",
          attemptId: `after-crash-${i}`,
          outcome: "confirmed-refusal",
          refusalDetail: null,
          transportKind: "local-ws",
          at: i,
        });
      }

      const deadMessage = await lastMessageOn(
        windowB,
        RunnerHostEvent.selectionLeasesChanged,
      );
      expect(deadMessage).toBeDefined();
      expect(deadMessage?.payload).toMatchObject({
        change: [{ hostId: "crash-host", status: "dead" }],
      });

      bridge.dispose();
    });

    it("subscribes exactly once to app's render-process-gone and calls app.off on bridge.dispose()", async () => {
      const { bridge, registry } = await buildBridge({});
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();

      expect(appState.listeners.get("render-process-gone")?.size).toBe(1);

      bridge.dispose();

      expect(appState.listeners.get("render-process-gone")?.size ?? 0).toBe(0);
    });
  });

  describe("selectionAttachSeq sync allocator (B2)", () => {
    it("a dying sender (unknown webContents id) answers null and does not disturb a known window's generation", async () => {
      const { bridge, registry } = await buildBridge({});
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();
      const attach = attachHandler();

      // An unknown sender BEFORE any known-window allocation.
      expect(
        invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 999),
      ).toBeNull();

      const seq1 = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      expect(seq1).toBe(1);

      // Another unknown-sender call interleaved between two known
      // allocations must not consume a slot of window-a's counter.
      expect(
        invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 999),
      ).toBeNull();

      const seq2 = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      expect(seq2).toBe(2);

      // The known window's fresh seq still attaches successfully.
      const result = await attachOk(attach, 101, seq2, []);
      expect(typeof result.incarnationId).toBe("string");

      bridge.dispose();
    });
  });

  describe("detach during/after attach (B3)", () => {
    it("a reportEvidence call stamped with a since-closed window's incarnation is dropped, not adopted as live suppression", async () => {
      fetchRegisteredHostsMock.mockResolvedValue({
        kind: "ok",
        response: { hosts: [buildHostListItem("detach-host")] },
      });
      const { bridge, registry } = await buildBridge({
        signedIn: { userId: "user-a", token: "token-1" },
      });
      const windowA = buildWindow();
      const windowB = buildWindow();
      registry.add("window-a", 101, windowA);
      registry.add("window-b", 202, windowB);
      bridge.install();
      await flushIo();

      const attach = attachHandler();
      const seqA = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 101);
      const { incarnationId: incarnationA } = await attachOk(
        attach,
        101,
        seqA,
        [
          {
            hostId: "detach-host",
            sessionId: "sess-a",
            transportKind: "local-ws",
          },
        ],
      );

      const seqB = invokeSyncWithSender(RunnerHostSync.selectionAttachSeq, 202);
      const { incarnationId: incarnationB } = await attachOk(
        attach,
        202,
        seqB,
        [],
      );

      // Close window A: drop it from the registry and fire the registry
      // change - the engine retires A's incarnation via reporterDetached.
      registry.remove("window-a");

      // A report stamped with A's now-void incarnation is dropped: it never
      // reaches the engine at all, because the same registry removal that
      // triggers `reporterDetached` also makes window-a's webContents id
      // untrusted for every subsequent invoke (defense-in-depth check
      // shared by all IPC invokes, `isTrustedIpcSender`). The invoke
      // rejects rather than silently resolving - which is itself proof A's
      // incarnation cannot be replayed post-close.
      const evidence = evidenceHandler();
      expect(() =>
        evidence(sender(101), incarnationA, {
          kind: "dial",
          hostId: "detach-host",
          attemptId: "post-close-a",
          outcome: "success",
          transportKind: "local-ws",
          at: 0,
        }),
      ).toThrow(/not trusted/);

      windowB.sentMessages.length = 0;

      for (let i = 0; i < 3; i += 1) {
        await evidence(sender(202), incarnationB, {
          kind: "dial",
          hostId: "detach-host",
          attemptId: `b-refusal-${i}`,
          outcome: "confirmed-refusal",
          refusalDetail: null,
          transportKind: "local-ws",
          at: i,
        });
      }

      const deadMessage = await lastMessageOn(
        windowB,
        RunnerHostEvent.selectionLeasesChanged,
      );
      expect(deadMessage).toBeDefined();
      expect(deadMessage?.payload).toMatchObject({
        change: [{ hostId: "detach-host", status: "dead" }],
      });

      bridge.dispose();
    });
  });

  // ---------------------------------------------------------------------
  // F6 main-side fleet-refresh edge (Suite G). The renderer's own caller
  // for this channel does not exist yet, so only the main-side contract is
  // testable here: invoking `refreshFleet` calls `DesktopHostFleetSource
  // .refresh()`, and calling it never turns a transient registry blip into
  // a rejected invoke. `fetchRegisteredHostsMock` is the only observable
  // proxy for "refresh() ran" available to this suite (per the file header,
  // `fetchRegisteredHostsViaHttp` is main's hard-wired registry fetcher),
  // so call counts on it stand in for refresh() call counts.
  // ---------------------------------------------------------------------

  describe("refreshFleet invoke (F6 main-side fleet-refresh edge)", () => {
    it("G1: invoking the channel calls refresh() on the fleet source exactly once", async () => {
      fetchRegisteredHostsMock.mockResolvedValue({
        kind: "ok",
        response: { hosts: [] },
      });
      const { bridge, registry } = await buildBridge({
        signedIn: { userId: "user-a", token: "token-1" },
      });
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();

      // Baseline absorbs the seed refresh() the module already fires on
      // registration (module header: "Seed real membership") - and it WAITS
      // for it rather than sleeping past it.
      const baselineCalls = await settledSeedFetchCount();

      const refreshFleet = refreshFleetHandler();
      await refreshFleet(sender(101));

      expect(fetchRegisteredHostsMock.mock.calls.length).toBe(
        baselineCalls + 1,
      );

      bridge.dispose();
    });

    it("G2: invoking the channel twice produces exactly two refresh() calls (idempotent, unscoped - no membership assertion)", async () => {
      fetchRegisteredHostsMock.mockResolvedValue({
        kind: "ok",
        response: { hosts: [] },
      });
      const { bridge, registry } = await buildBridge({
        signedIn: { userId: "user-a", token: "token-1" },
      });
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();

      const baselineCalls = await settledSeedFetchCount();

      const refreshFleet = refreshFleetHandler();
      await refreshFleet(sender(101));
      await refreshFleet(sender(101));

      // Exactly two calls - nothing here asserts fleet membership; the
      // renderer only says "your copy is stale", main re-reads on its own
      // terms.
      expect(fetchRegisteredHostsMock.mock.calls.length).toBe(
        baselineCalls + 2,
      );

      bridge.dispose();
    });

    it("G3: a rejecting refresh() is CONTAINED at the invoke handler - the invoke resolves, and the failure is not silent (a warn is logged)", async () => {
      // `registerFleetRefresh`'s doc comment says failures are swallowed into
      // the fleet source's own logging. `DesktopHostFleetSource.refresh()`
      // only does that for a RESOLVED non-ok `HostListFetchResult`; a genuine
      // REJECTION from `listRegisteredHosts` used to propagate straight
      // through the un-wrapped handler into `bridge.handleInvoke`'s generic
      // wrapper, which re-throws - reaching the caller as a rejected invoke
      // on an operation (e.g. a deregistration) that had already succeeded.
      // The handler now wraps `fleet.refresh()` in its own try/catch, so
      // containment lives at the one seam that owns this promise, rather
      // than relying on every future caller remembering to `.catch()`.
      electronLogWarnMock.mockClear();

      fetchRegisteredHostsMock.mockResolvedValue({
        kind: "ok",
        response: { hosts: [] },
      });
      const { bridge, registry } = await buildBridge({
        signedIn: { userId: "user-a", token: "token-1" },
      });
      const windowA = buildWindow();
      registry.add("window-a", 101, windowA);
      bridge.install();
      await flushIo();

      fetchRegisteredHostsMock.mockRejectedValueOnce(
        new Error("registry blip"),
      );

      const refreshFleet = refreshFleetHandler();
      // Contained: the invoke resolves rather than rejecting on a caller
      // that already completed a real operation (e.g. a deregistration).
      await expect(refreshFleet(sender(101))).resolves.toBeUndefined();
      // Not silently swallowed into nothing: the warn path ran.
      expect(electronLogWarnMock).toHaveBeenCalledTimes(1);

      bridge.dispose();
    });
  });
});
