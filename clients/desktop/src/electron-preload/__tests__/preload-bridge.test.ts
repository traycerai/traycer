import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../ipc-contracts/ipc-channels";
import type { AuthCallbackBridgeResult } from "../preload-bridge";
import type { AuthTokenValidationResult } from "@traycer-clients/shared/platform/runner-host";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";

/**
 * Preload replay-safety tests. The preload module wires `ipcRenderer.on` and
 * exposes a bridge at module load, so each test dynamically imports the
 * preload after resetting the fake `electron` module state - otherwise
 * `contextBridge.exposeInMainWorld` and the eagerly-registered `ipcRenderer`
 * listeners would leak across tests.
 */

type IpcHandler = (event: unknown, payload: unknown) => void;

type InvokeFn = (channel: string, ...args: unknown[]) => Promise<unknown>;
type SendSyncFn = (channel: string, ...args: unknown[]) => unknown;

interface SyncCall {
  readonly channel: string;
  readonly args: readonly unknown[];
}

interface FakeElectron {
  channels: Map<string, Set<IpcHandler>>;
  exposed: Map<string, unknown>;
  invokeFn: InvokeFn;
  sendSyncFn: SendSyncFn;
  syncCalls: SyncCall[];
  emit(channel: string, payload: unknown): void;
  reset(): void;
}

const fakeElectron: FakeElectron = {
  channels: new Map(),
  exposed: new Map(),
  invokeFn: () => Promise.resolve(undefined),
  sendSyncFn: (channel: string) => {
    if (channel === RunnerHostSync.windowId) {
      return "preload-window";
    }
    return null;
  },
  syncCalls: [],
  emit(channel: string, payload: unknown): void {
    const handlers = fakeElectron.channels.get(channel);
    if (handlers === undefined) {
      return;
    }
    for (const handler of handlers) {
      handler({}, payload);
    }
  },
  reset(): void {
    fakeElectron.channels.clear();
    fakeElectron.exposed.clear();
    fakeElectron.invokeFn = () => Promise.resolve(undefined);
    fakeElectron.sendSyncFn = (channel: string) => {
      if (channel === RunnerHostSync.windowId) {
        return "preload-window";
      }
      return null;
    };
    fakeElectron.syncCalls = [];
  },
};

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, handler: IpcHandler): void => {
      let set = fakeElectron.channels.get(channel);
      if (set === undefined) {
        set = new Set();
        fakeElectron.channels.set(channel, set);
      }
      set.add(handler);
    },
    removeListener: (channel: string, handler: IpcHandler): void => {
      fakeElectron.channels.get(channel)?.delete(handler);
    },
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
      fakeElectron.invokeFn(channel, ...args),
    sendSync: (channel: string, ...args: unknown[]): unknown => {
      fakeElectron.syncCalls.push({ channel, args });
      return fakeElectron.sendSyncFn(channel, ...args);
    },
  },
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown): void => {
      fakeElectron.exposed.set(key, value);
    },
  },
  webUtils: {
    getPathForFile: (_file: File): string => "/tmp/dropped-file",
  },
}));

interface PreloadBridge {
  readonly authnBaseUrl: string;
  readonly initialRoute: string | null;
  readonly windows: {
    readonly windowId: string;
    list(): Promise<unknown>;
    requestFocus(windowId: string): Promise<void>;
    requestOpenEpicInNewWindow(
      epicId: string,
      title: string,
      tabId: string,
    ): Promise<unknown>;
    ownership: {
      snapshot(): Promise<unknown>;
      claim(tabId: string, epicId: string): Promise<unknown>;
      release(tabId: string): Promise<void>;
      onChange(handler: (entries: unknown) => void): { dispose: () => void };
    };
    perWindowState: {
      get(): Promise<unknown>;
      update(patch: unknown): Promise<void>;
      clear(): Promise<void>;
    };
    authSession: {
      get(): Promise<unknown>;
      set(snapshot: unknown): Promise<void>;
      onChange(handler: (snapshot: unknown) => void): { dispose: () => void };
    };
  };
  validateAuthToken(token: string): Promise<AuthTokenValidationResult>;
  validateAuthTokenIdentity(
    token: string,
  ): Promise<AuthIdentityValidationResult>;
  onAuthCallback(handler: (result: AuthCallbackBridgeResult) => void): {
    dispose: () => void;
  };
  tokenStore: {
    get(): Promise<string | null>;
    set(token: string): Promise<void>;
    delete(): Promise<void>;
  };
  workspaceFolders: {
    pickFolders(): Promise<readonly string[]>;
  };
  fileDrops: {
    getPathForFile(file: File): string;
    writeTemporaryFile(input: unknown): Promise<string>;
    copyTemporaryFiles(paths: readonly string[]): Promise<readonly string[]>;
    saveFile(input: unknown): Promise<string | null>;
  };
  requestHostRespawn(): Promise<void>;
  menu: {
    onCommand(handler: (payload: unknown) => void): { dispose: () => void };
  };
  support: {
    getSnapshot(): Promise<unknown>;
    revealLog(target: unknown): Promise<unknown>;
    tailLog(input: unknown): Promise<unknown>;
  };
}

interface LoadPreloadOptions {
  authnApiUrl: string | undefined;
  desktopDev: string | undefined;
  initialRouteArg: string | undefined;
  invokeFn: InvokeFn | undefined;
  sendSyncFn: SendSyncFn | undefined;
}

async function loadPreload(
  options: LoadPreloadOptions,
): Promise<PreloadBridge> {
  vi.resetModules();
  fakeElectron.reset();
  if (options.invokeFn !== undefined) {
    fakeElectron.invokeFn = options.invokeFn;
  }
  if (options.sendSyncFn !== undefined) {
    fakeElectron.sendSyncFn = options.sendSyncFn;
  }
  const previousAuthnApiUrl = process.env.AUTHN_API_URL;
  const previousDesktopDev = process.env.TRAYCER_DESKTOP_DEV;
  const previousArgv = process.argv;
  process.argv =
    options.initialRouteArg === undefined
      ? previousArgv.filter(
          (arg) => !arg.startsWith("--traycer-initial-route="),
        )
      : [...previousArgv, options.initialRouteArg];
  if (options.authnApiUrl === undefined) {
    delete process.env.AUTHN_API_URL;
  } else {
    process.env.AUTHN_API_URL = options.authnApiUrl;
  }
  if (options.desktopDev === undefined) {
    delete process.env.TRAYCER_DESKTOP_DEV;
  } else {
    process.env.TRAYCER_DESKTOP_DEV = options.desktopDev;
  }
  await import("../preload-bridge");
  if (previousAuthnApiUrl === undefined) {
    delete process.env.AUTHN_API_URL;
  } else {
    process.env.AUTHN_API_URL = previousAuthnApiUrl;
  }
  if (previousDesktopDev === undefined) {
    delete process.env.TRAYCER_DESKTOP_DEV;
  } else {
    process.env.TRAYCER_DESKTOP_DEV = previousDesktopDev;
  }
  process.argv = previousArgv;
  const bridge = fakeElectron.exposed.get("runnerHost");
  if (bridge === undefined) {
    throw new Error("preload did not expose runnerHost");
  }
  return bridge as PreloadBridge;
}

describe("preload auth-callback replay", () => {
  beforeEach(() => {
    fakeElectron.reset();
  });

  afterEach(() => {
    fakeElectron.reset();
    vi.unstubAllGlobals();
  });

  it("replays the cached auth-callback result to subscribers that arrive after the IPC event fired", async () => {
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: undefined,
      invokeFn: undefined,
      sendSyncFn: undefined,
    });

    fakeElectron.emit(RunnerHostEvent.authCallback, {
      token: "early-token",
      refreshToken: "early-token-refresh",
    });

    const observed: AuthCallbackBridgeResult[] = [];
    const subscription = bridge.onAuthCallback((result) => {
      observed.push(result);
    });

    expect(observed).toEqual([
      { token: "early-token", refreshToken: "early-token-refresh" },
    ]);
    subscription.dispose();
  });

  it("fans out subsequent auth-callback IPC events to every live subscriber", async () => {
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: undefined,
      invokeFn: undefined,
      sendSyncFn: undefined,
    });

    const a: AuthCallbackBridgeResult[] = [];
    const b: AuthCallbackBridgeResult[] = [];
    bridge.onAuthCallback((result) => {
      a.push(result);
    });
    bridge.onAuthCallback((result) => {
      b.push(result);
    });

    fakeElectron.emit(RunnerHostEvent.authCallback, {
      token: "t1",
      refreshToken: "t1-refresh",
    });
    fakeElectron.emit(RunnerHostEvent.authCallback, { error: "denied" });

    expect(a).toEqual([
      { token: "t1", refreshToken: "t1-refresh" },
      { error: "denied" },
    ]);
    expect(b).toEqual([
      { token: "t1", refreshToken: "t1-refresh" },
      { error: "denied" },
    ]);
  });

  it("does not invoke a subscriber synchronously when no auth callback has fired yet", async () => {
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: undefined,
      invokeFn: undefined,
      sendSyncFn: undefined,
    });

    const observed: AuthCallbackBridgeResult[] = [];
    bridge.onAuthCallback((result) => {
      observed.push(result);
    });

    expect(observed).toEqual([]);

    fakeElectron.emit(RunnerHostEvent.authCallback, {
      token: "t-late",
      refreshToken: "t-late-refresh",
    });
    expect(observed).toEqual([
      { token: "t-late", refreshToken: "t-late-refresh" },
    ]);
  });
});

describe("preload new-capability wiring", () => {
  beforeEach(() => {
    fakeElectron.reset();
  });

  afterEach(() => {
    fakeElectron.reset();
    vi.unstubAllGlobals();
  });

  it("exposes the window initial route from preload bootstrap arguments", async () => {
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: "--traycer-initial-route=%2Fepics%2Fepic-a%2Ftab-a",
      invokeFn: undefined,
      sendSyncFn: undefined,
    });

    expect(bridge.initialRoute).toBe("/epics/epic-a/tab-a");
  });

  it("forwards validateAuthToken through ipcRenderer.invoke", async () => {
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: undefined,
      invokeFn: (channel, token) => {
        if (channel !== RunnerHostInvoke.validateAuthToken) {
          throw new Error(`unexpected channel ${channel}`);
        }
        expect(token).toBe("jwt-123");
        return Promise.resolve({
          kind: "valid",
          profile: {
            userId: "test-user",
            userName: "Test User",
            email: "test@example.com",
          },
        } satisfies AuthTokenValidationResult);
      },
      sendSyncFn: undefined,
    });

    await expect(bridge.validateAuthToken("jwt-123")).resolves.toEqual({
      kind: "valid",
      profile: {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
    });
  });

  it("forwards validateAuthTokenIdentity through ipcRenderer.invoke", async () => {
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: undefined,
      invokeFn: (channel, token) => {
        if (channel !== RunnerHostInvoke.validateAuthTokenIdentity) {
          throw new Error(`unexpected channel ${channel}`);
        }
        expect(token).toBe("jwt-identity");
        return Promise.resolve({ kind: "rejected" });
      },
      sendSyncFn: undefined,
    });

    await expect(
      bridge.validateAuthTokenIdentity("jwt-identity"),
    ).resolves.toEqual({ kind: "rejected" });
  });

  it("exposes the build-time DESKTOP_AUTHN_BASE_URL constant", async () => {
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: undefined,
      invokeFn: undefined,
      sendSyncFn: undefined,
    });
    // The OSS build ships production endpoints in source, so this is the
    // production authn URL. No env-var override path exists anymore.
    expect(bridge.authnBaseUrl).toBe("https://authn.traycer.ai");
  });

  it("forwards requestHostRespawn through ipcRenderer.invoke", async () => {
    const invokeFn = vi.fn(async () => undefined);
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: undefined,
      invokeFn,
      sendSyncFn: undefined,
    });
    await bridge.requestHostRespawn();
    expect(invokeFn).toHaveBeenCalledWith(RunnerHostInvoke.requestHostRespawn);
  });

  it("forwards workspace folder picking through ipcRenderer.invoke", async () => {
    const invokeFn = vi.fn(async () => ["/tmp/project-a", "/tmp/project-b"]);
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: undefined,
      invokeFn,
      sendSyncFn: undefined,
    });
    await expect(bridge.workspaceFolders.pickFolders()).resolves.toEqual([
      "/tmp/project-a",
      "/tmp/project-b",
    ]);
    expect(invokeFn).toHaveBeenCalledWith(
      RunnerHostInvoke.workspaceFoldersPick,
    );
  });

  it("exposes file drop path lookup and temporary materialization", async () => {
    const invokeFn = vi.fn(async () => "/tmp/materialized-drop.png");
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: undefined,
      invokeFn,
      sendSyncFn: undefined,
    });
    const file = new File(["image"], "screenshot.png", { type: "image/png" });
    const bytes = new Uint8Array([105, 109, 97, 103, 101]).buffer;

    expect(bridge.fileDrops.getPathForFile(file)).toBe("/tmp/dropped-file");
    await expect(
      bridge.fileDrops.writeTemporaryFile({
        name: file.name,
        type: file.type,
        bytes,
      }),
    ).resolves.toBe("/tmp/materialized-drop.png");
    expect(invokeFn).toHaveBeenCalledWith(
      RunnerHostInvoke.fileDropWriteTemporary,
      {
        name: "screenshot.png",
        type: "image/png",
        bytes,
      },
    );

    await expect(
      bridge.fileDrops.saveFile({
        name: "diagram.png",
        type: "image/png",
        bytes,
      }),
    ).resolves.toBe("/tmp/materialized-drop.png");
    expect(invokeFn).toHaveBeenCalledWith(RunnerHostInvoke.fileSave, {
      name: "diagram.png",
      type: "image/png",
      bytes,
    });
  });

  it("exposes menu-command and support bridges", async () => {
    const invokeFn = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === RunnerHostInvoke.supportSnapshotGet) {
        return { appName: "Traycer", logs: [] };
      }
      if (channel === RunnerHostInvoke.supportRevealLog) {
        return { target: args[0], path: "/tmp/log" };
      }
      if (channel === RunnerHostInvoke.supportTailLog) {
        return {
          target: "host",
          path: "/tmp/log",
          lines: ["ready"],
          truncated: false,
        };
      }
      return undefined;
    });
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: undefined,
      invokeFn,
      sendSyncFn: undefined,
    });

    const commands: unknown[] = [];
    const subscription = bridge.menu.onCommand((payload) => {
      commands.push(payload);
    });
    fakeElectron.emit(RunnerHostEvent.menuCommand, {
      command: "app.openLogs",
      windowId: "preload-window",
    });
    subscription.dispose();
    fakeElectron.emit(RunnerHostEvent.menuCommand, {
      command: "app.aboutDetails",
      windowId: "preload-window",
    });

    await expect(bridge.support.getSnapshot()).resolves.toEqual({
      appName: "Traycer",
      logs: [],
    });
    await expect(bridge.support.revealLog("host")).resolves.toEqual({
      target: "host",
      path: "/tmp/log",
    });
    await expect(
      bridge.support.tailLog({ target: "host", tailLines: 100 }),
    ).resolves.toEqual({
      target: "host",
      path: "/tmp/log",
      lines: ["ready"],
      truncated: false,
    });
    expect(commands).toEqual([
      { command: "app.openLogs", windowId: "preload-window" },
    ]);
    expect(invokeFn).toHaveBeenCalledWith(RunnerHostInvoke.supportSnapshotGet);
    expect(invokeFn).toHaveBeenCalledWith(
      RunnerHostInvoke.supportRevealLog,
      "host",
    );
    expect(invokeFn).toHaveBeenCalledWith(RunnerHostInvoke.supportTailLog, {
      target: "host",
      tailLines: 100,
    });
  });

  it("exposes desktop windows, ownership, per-window state, and auth-session bridge calls", async () => {
    const invokeFn = vi.fn(async (channel: string) => {
      if (channel === RunnerHostInvoke.windowsList) {
        return [{ windowId: "preload-window", title: "Traycer" }];
      }
      if (channel === RunnerHostInvoke.ownershipSnapshot) {
        return [
          { tabId: "tab-a", epicId: "epic-a", windowId: "preload-window" },
        ];
      }
      if (channel === RunnerHostInvoke.ownershipClaim) {
        return { ok: true };
      }
      if (channel === RunnerHostInvoke.perWindowStateGet) {
        return {
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        };
      }
      if (channel === RunnerHostInvoke.authSessionGet) {
        return { status: "signed-out", token: null, profile: null };
      }
      if (channel === RunnerHostInvoke.windowsRequestOpenEpicInNewWindow) {
        return { result: "moved", windowId: "new-window" };
      }
      return undefined;
    });
    const bridge = await loadPreload({
      authnApiUrl: undefined,
      desktopDev: undefined,
      initialRouteArg: undefined,
      invokeFn,
      sendSyncFn: undefined,
    });

    expect(bridge.windows.windowId).toBe("preload-window");
    await expect(bridge.windows.list()).resolves.toEqual([
      { windowId: "preload-window", title: "Traycer" },
    ]);
    await bridge.windows.requestFocus("other-window");
    await expect(
      bridge.windows.requestOpenEpicInNewWindow("epic-a", "Alpha", "tab-a"),
    ).resolves.toEqual({ result: "moved", windowId: "new-window" });
    await expect(bridge.windows.ownership.snapshot()).resolves.toEqual([
      { tabId: "tab-a", epicId: "epic-a", windowId: "preload-window" },
    ]);
    await expect(
      bridge.windows.ownership.claim("tab-a", "epic-a"),
    ).resolves.toEqual({ ok: true });
    await bridge.windows.ownership.release("tab-a");
    await expect(bridge.windows.perWindowState.get()).resolves.toEqual({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
    });
    await bridge.windows.perWindowState.update({ activeTabId: "tab-a" });
    await bridge.windows.perWindowState.clear();
    expect(invokeFn).toHaveBeenCalledWith(RunnerHostInvoke.perWindowStateClear);
    await expect(bridge.windows.authSession.get()).resolves.toEqual({
      status: "signed-out",
      token: null,
      profile: null,
    });
    await bridge.windows.authSession.set({
      status: "signed-in",
      token: "jwt",
      profile: {
        userId: "test-user",
        userName: "User",
        email: "user@example.com",
      },
    });

    const observed: unknown[] = [];
    const ownershipObserved: unknown[] = [];
    bridge.windows.ownership.onChange((entries) => {
      ownershipObserved.push(entries);
    });
    bridge.windows.authSession.onChange((snapshot) => {
      observed.push(snapshot);
    });
    fakeElectron.emit(RunnerHostEvent.ownershipChange, [
      { tabId: "tab-a", epicId: "epic-a", windowId: "preload-window" },
    ]);
    fakeElectron.emit(RunnerHostEvent.authSessionChange, {
      status: "signed-in",
      token: "jwt",
      profile: {
        userId: "test-user",
        userName: "User",
        email: "user@example.com",
      },
    });

    expect(observed).toEqual([
      {
        status: "signed-in",
        token: "jwt",
        profile: {
          userId: "test-user",
          userName: "User",
          email: "user@example.com",
        },
      },
    ]);
    expect(ownershipObserved).toEqual([
      [{ tabId: "tab-a", epicId: "epic-a", windowId: "preload-window" }],
    ]);
    expect(invokeFn).toHaveBeenCalledWith(
      RunnerHostInvoke.windowsRequestFocus,
      "other-window",
    );
    expect(invokeFn).toHaveBeenCalledWith(
      RunnerHostInvoke.windowsRequestOpenEpicInNewWindow,
      "epic-a",
      "Alpha",
      "tab-a",
    );
    expect(invokeFn).toHaveBeenCalledWith(RunnerHostInvoke.ownershipSnapshot);
    expect(invokeFn).toHaveBeenCalledWith(
      RunnerHostInvoke.ownershipClaim,
      "tab-a",
      "epic-a",
    );
    expect(invokeFn).toHaveBeenCalledWith(
      RunnerHostInvoke.ownershipRelease,
      "tab-a",
    );
    expect(invokeFn).toHaveBeenCalledWith(
      RunnerHostInvoke.perWindowStateUpdate,
      { activeTabId: "tab-a" },
    );
    expect(invokeFn).toHaveBeenCalledWith(RunnerHostInvoke.authSessionSet, {
      status: "signed-in",
      token: "jwt",
      profile: {
        userId: "test-user",
        userName: "User",
        email: "user@example.com",
      },
    });
  });
});
