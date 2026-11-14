import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IpcHostLifecycle,
  IpcManagedWindow,
  IpcWindowRecord,
  IpcWindowRegistry,
} from "../../ipc/runner-ipc-bridge";
import { RunnerIpcBridge } from "../../ipc/runner-ipc-bridge";
import { registerAuthIpc } from "../../ipc/auth-ipc";
import { FakeHostController } from "../../ipc/__tests__/fake-host-controller";
import { DesktopAuthSession } from "../desktop-auth-session";
import { EpicWindowOwnership } from "../../windows/epic-window-ownership";
import { PerWindowState } from "../../windows/per-window-state";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
} from "@traycer-clients/shared/auth/host-token-source";

const USER_ID = "user-a";
const HOST_IDS = ["computer-a", "computer-b"] as const;
const AUTHN_BASE_URL = "https://authn.test";

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => unknown | Promise<unknown>;

const ipcMainState = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
}));

vi.mock("@sentry/electron/main", () => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "1.0.0",
    getPath: () => "/tmp/traycer-desktop-test",
    on: vi.fn(),
    off: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (_value: string) => Buffer.from("", "utf8"),
    decryptString: (_value: Buffer) => "",
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  Notification: { isSupported: () => false },
  powerSaveBlocker: {
    start: vi.fn(() => 1),
    stop: vi.fn(),
    isStarted: vi.fn(() => true),
  },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => {
      ipcMainState.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      ipcMainState.handlers.delete(channel);
    },
    on: vi.fn(),
    removeListener: vi.fn(),
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

beforeEach(() => {
  ipcMainState.handlers.clear();
});

function testWindow(): IpcManagedWindow {
  return {
    isDestroyed: () => false,
    isFocused: () => false,
    isVisible: () => true,
    show: () => undefined,
    focus: () => undefined,
    webContents: { send: () => undefined },
  };
}

function testWindowRegistry(): IpcWindowRegistry {
  const records: readonly IpcWindowRecord[] = [101, 202, 303].map(
    (webContentsId) => ({
      windowId: `window-${webContentsId}`,
      webContentsId,
      window: testWindow(),
    }),
  );
  return {
    create: async () => "window-101",
    closeById: async () => undefined,
    forceCloseById: async () => undefined,
    focusMru: () => false,
    focusById: () => false,
    list: () => [],
    records: () => records,
    getRecordById: (windowId) =>
      records.find((record) => record.windowId === windowId) ?? null,
    getRecordByWebContentsId: (webContentsId) =>
      records.find((record) => record.webContentsId === webContentsId) ?? null,
    getMruRecord: () => records[0] ?? null,
    mostRecentlyFocusedId: () => records[0]?.windowId ?? null,
    on: () => undefined,
    off: () => undefined,
  };
}

function testHostLifecycle(): IpcHostLifecycle {
  return {
    getSnapshot: () => null,
    on: () => undefined,
    off: () => undefined,
    notifyRespawning: () => undefined,
    pidMetadataFile: "/tmp/fake-host/pid.json",
    identityEnrollmentFile: "/tmp/fake-host/enrollment.json",
    isDisposed: false,
    reloadSnapshotFromDisk: async () => null,
    noteEndpointAnswered: () => undefined,
    ensureWatcherInstalled: () => undefined,
    getRecentLogTail: async () => null,
  };
}

function signInToken(expiration: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expiration })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
}

describe("desktop host-token renewal", () => {
  it("coalesces concurrent renewal requests from several windows per computer and sign-in rotation", async () => {
    let signInTokenValue = signInToken(2_000_000);
    const mintRequests: Array<{
      readonly hostId: string;
      readonly signIn: string;
    }> = [];
    let nextToken = 0;
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (hostId, signIn) => {
        mintRequests.push({ hostId, signIn });
        nextToken += 1;
        const outcome: HostTokenMintOutcome = {
          kind: "ok",
          token: {
            token: `host-token-${nextToken}`,
            expiresAtMs: Date.now() + 60_000,
          },
        };
        return Promise.resolve(outcome);
      },
      signIn: (userId) => (userId === USER_ID ? signInTokenValue : null),
      now: () => Date.now(),
    });

    await Promise.all([
      hostTokens.renew(USER_ID, HOST_IDS),
      hostTokens.renew(USER_ID, HOST_IDS),
      hostTokens.renew(USER_ID, HOST_IDS),
    ]);
    expect(mintRequests).toEqual([
      { hostId: HOST_IDS[0], signIn: signInTokenValue },
      { hostId: HOST_IDS[1], signIn: signInTokenValue },
    ]);

    signInTokenValue = signInToken(2_100_000);
    await Promise.all([
      hostTokens.renew(USER_ID, HOST_IDS),
      hostTokens.renew(USER_ID, HOST_IDS),
      hostTokens.renew(USER_ID, HOST_IDS),
    ]);

    expect(mintRequests.slice(2)).toEqual([
      { hostId: HOST_IDS[0], signIn: signInTokenValue },
      { hostId: HOST_IDS[1], signIn: signInTokenValue },
    ]);
    expect(hostTokens.current(USER_ID, HOST_IDS[0])?.token).toBe(
      "host-token-3",
    );
    expect(hostTokens.current(USER_ID, HOST_IDS[1])?.token).toBe(
      "host-token-4",
    );
  });

  it("coalesces the registered hostTokensRenew IPC across three windows per computer", async () => {
    let signInTokenValue = signInToken(2_000_000);
    const mintRequests: Array<{
      readonly hostId: string;
      readonly signIn: string;
    }> = [];
    const releaseMints = new Map<
      string,
      (outcome: HostTokenMintOutcome) => void
    >();
    let resolveMintsStarted: () => void = () => undefined;
    const mintsStarted = new Promise<void>((resolve) => {
      resolveMintsStarted = resolve;
    });
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: (hostId, signIn) => {
        mintRequests.push({ hostId, signIn });
        const outcome: HostTokenMintOutcome = {
          kind: "ok",
          token: {
            token: `host-token-${mintRequests.length}`,
            expiresAtMs: Date.now() + 60_000,
          },
        };
        if (mintRequests.length > HOST_IDS.length)
          return Promise.resolve(outcome);
        const promise = new Promise<HostTokenMintOutcome>((resolve) => {
          releaseMints.set(hostId, resolve);
          if (mintRequests.length === HOST_IDS.length) resolveMintsStarted();
        });
        return promise;
      },
      signIn: (userId) => (userId === USER_ID ? signInTokenValue : null),
      now: () => Date.now(),
    });
    const bridge = new RunnerIpcBridge({
      host: testHostLifecycle(),
      hostController: new FakeHostController(),
      authnBaseUrl: AUTHN_BASE_URL,
      authRedirectUri: null,
      authTokenStore: undefined,
      hostTokens,
      tray: null,
      zoomController: undefined,
      windowRegistry: testWindowRegistry(),
      ownership: new EpicWindowOwnership(null),
      perWindowState: new PerWindowState(null),
      authSession: new DesktopAuthSession(),
    });
    registerAuthIpc(bridge);
    const handler = ipcMainState.handlers.get(RunnerHostInvoke.hostTokensRenew);
    if (handler === undefined)
      throw new Error("hostTokensRenew IPC handler was not registered");
    const windowIds = [101, 202, 303] as const;
    const renewFromWindow = (webContentsId: number): Promise<unknown> =>
      Promise.resolve(
        handler(
          {
            sender: { id: webContentsId },
            senderFrame: { parent: null, url: "app://traycer" },
          },
          USER_ID,
          HOST_IDS,
        ),
      );

    try {
      const pending = windowIds.map(renewFromWindow);
      const mintOrInvokeFailure = await Promise.race([
        mintsStarted.then(() => null),
        ...pending.map((invoke) =>
          invoke.then(
            () => new Error("renewal IPC completed before its mints"),
            (error: unknown) => error,
          ),
        ),
      ]);
      if (mintOrInvokeFailure !== null) throw mintOrInvokeFailure;

      expect(mintRequests).toEqual([
        { hostId: HOST_IDS[0], signIn: signInTokenValue },
        { hostId: HOST_IDS[1], signIn: signInTokenValue },
      ]);
      for (const hostId of HOST_IDS) {
        const release = releaseMints.get(hostId);
        if (release === undefined)
          throw new Error(`missing mint for ${hostId}`);
        release({
          kind: "ok",
          token: {
            token: `host-token-${hostId}`,
            expiresAtMs: Date.now() + 60_000,
          },
        });
      }
      await Promise.all(pending);
      expect(mintRequests).toHaveLength(HOST_IDS.length);

      signInTokenValue = signInToken(2_100_000);
      await Promise.all(windowIds.map(renewFromWindow));
      expect(mintRequests.slice(HOST_IDS.length)).toEqual([
        { hostId: HOST_IDS[0], signIn: signInTokenValue },
        { hostId: HOST_IDS[1], signIn: signInTokenValue },
      ]);
    } finally {
      bridge.dispose();
    }
  });
});
