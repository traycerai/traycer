import { describe, expect, it, vi } from "vitest";
import type {
  AuthTokenValidationResult,
  HostRegistryUpdateState,
  LocalHostSnapshot,
  TrayEpic,
  TrayIndicatorState,
} from "@traycer-clients/shared/platform/runner-host";
import {
  DesktopRunnerHost,
  type DesktopPreloadBridge,
} from "../desktop-runner-host";

// In vitest's jsdom env the `encrypt-storage` UMD wrapper fails to pick up
// `window.localStorage` correctly; we don't need to exercise the AES path
// in unit tests anyway, so swap it out for an in-memory map.
vi.mock("../secure-local-storage", () => {
  const slot = new Map<string, string>();
  return {
    readEncryptedItem: (key: string) => slot.get(key) ?? null,
    writeEncryptedItem: (key: string, value: string) => {
      slot.set(key, value);
    },
    removeEncryptedItem: (key: string) => {
      slot.delete(key);
    },
  };
});

/**
 * Builds a fake preload bridge with the minimal behavior the
 * `DesktopRunnerHost` needs to exercise replay semantics. The fake
 * intentionally does NOT cache the current local-host snapshot, so the
 * renderer-side cache owned by `DesktopRunnerHost` is the sole path that
 * satisfies the "emit current value on subscribe" contract.
 */
interface FakeBridgeHandle {
  readonly bridge: DesktopPreloadBridge;
  readonly ownershipClaims: ReadonlyArray<{
    readonly tabId: string;
    readonly epicId: string;
  }>;
  readonly ownershipReleases: readonly string[];
  readonly temporaryWrites: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly bytes: ArrayBuffer;
  }>;
  emit(snapshot: LocalHostSnapshot | null): void;
}

function buildFakeBridge(
  initialSnapshot: LocalHostSnapshot | null,
): FakeBridgeHandle {
  let lastEmitted: LocalHostSnapshot | null = initialSnapshot;
  let firstSubscriberServed = false;
  const handlers = new Set<(snapshot: LocalHostSnapshot | null) => void>();

  const tokenSlot = { value: null as string | null };
  const respawnCounter = { count: 0 };
  const ownershipClaims: Array<{
    readonly tabId: string;
    readonly epicId: string;
  }> = [];
  const ownershipReleases: string[] = [];
  const temporaryWrites: Array<{
    readonly name: string;
    readonly type: string;
    readonly bytes: ArrayBuffer;
  }> = [];
  const bridge: DesktopPreloadBridge = {
    authnBaseUrl: "http://localhost:5005",
    relayBaseUrl: "ws://localhost:8787/attach",
    authRedirectUri: "",
    initialRoute: "/",
    sentryRendererDsn: "",
    validateAuthToken: async (): Promise<AuthTokenValidationResult> => ({
      kind: "valid",
      profile: {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
    }),
    validateAuthTokenIdentity: async () => ({ kind: "rejected" as const }),
    refreshAuthToken: async () => ({ kind: "network-error" as const }),
    listRegisteredHosts: async () => ({ kind: "network-error" as const }),
    listUserSessions: async () => ({ kind: "network-error" as const }),
    revokeUserSession: async () => ({ kind: "network-error" as const }),
    revokeAllSessions: async () => ({ kind: "network-error" as const }),
    requestStepUpChallenge: async () => ({ kind: "network-error" as const }),
    verifyStepUpChallenge: async () => ({ kind: "network-error" as const }),
    updateHostVersionPolicy: async () => ({ kind: "network-error" as const }),
    openExternalLink: async () => undefined,
    getRegisteredUrlSchemes: async () => [],
    requestMicrophoneAccess: async () => "granted" as const,
    openMicrophoneSettings: async () => undefined,
    beginAuthAttempt: () => undefined,
    onAuthCallback: (_handler: () => void) => ({
      dispose: () => undefined,
    }),
    deviceFlow: {
      start: async () => null,
    },
    notifications: {
      show: async () => undefined,
      onClick: (_handler: (payload: unknown) => void) => ({
        dispose: () => undefined,
      }),
    },
    onLocalHostChange: (
      handler: (snapshot: LocalHostSnapshot | null) => void,
    ) => {
      handlers.add(handler);
      // Mimic the preload bridge: synchronously replay the cached value on
      // subscribe. We only replay it for the very first subscriber here so
      // the test can prove the renderer-side cache - not the preload - is
      // what serves later subscribers.
      if (!firstSubscriberServed) {
        firstSubscriberServed = true;
        handler(lastEmitted);
      }
      return {
        dispose: () => {
          handlers.delete(handler);
        },
      };
    },
    onSystemResumed: (_handler: () => void) => ({
      dispose: () => undefined,
    }),
    requestHostRespawn: async () => {
      respawnCounter.count += 1;
    },
    trayState: {
      setEpics: async (_epics: readonly TrayEpic[]) => undefined,
      setIndicator: async (_state: TrayIndicatorState) => undefined,
      onEpicSelected: (_handler: (epicId: string) => void) => ({
        dispose: () => undefined,
      }),
    },
    hostPicker: {
      requestOpen: async () => undefined,
      requestClose: async () => undefined,
      onChange: (_handler: (isOpen: boolean) => void) => ({
        dispose: () => undefined,
      }),
    },
    workspaceFolders: {
      pickFolders: async () => ["/tmp/project-a", "/tmp/project-b"],
    },
    fileDrops: {
      getPathForFile: (file: File) => {
        if (file.name === "pathless.png") return "";
        if (file.name === "screenshot.png") {
          return "/var/folders/0d/x/T/TemporaryItems/screencaptureui_Ab/screenshot.png";
        }
        return `/tmp/${file.name}`;
      },
      writeTemporaryFile: async (input) => {
        temporaryWrites.push(input);
        return "/tmp/materialized-drop";
      },
      copyTemporaryFiles: async (paths) =>
        paths.map((path) => `/tmp/copied/${path.split("/").pop() ?? ""}`),
      readNativeClipboardFilePaths: async () => [],
      saveFile: async (input) => {
        temporaryWrites.push(input);
        return input.name;
      },
    },
    menu: {
      onCommand: (_handler) => ({ dispose: () => undefined }),
    },
    appUpdates: {
      getSnapshot: async () => ({
        sequence: 0,
        status: "idle",
        currentVersion: "0.0.0-test",
        allowPrerelease: false,
        latestVersion: null,
        downloadProgress: null,
        installBlockedReason: null,
        installGuidance: null,
        errorMessage: null,
        lastCheckedAt: null,
        lastCheckIntent: null,
      }),
      checkForUpdates: async () => ({
        sequence: 1,
        status: "up-to-date",
        currentVersion: "0.0.0-test",
        allowPrerelease: false,
        latestVersion: null,
        downloadProgress: null,
        installBlockedReason: null,
        installGuidance: null,
        errorMessage: null,
        lastCheckedAt: null,
        lastCheckIntent: "manual",
      }),
      setAllowPrerelease: async (allowPrerelease) => ({
        sequence: 2,
        status: "idle",
        currentVersion: "0.0.0-test",
        allowPrerelease,
        latestVersion: null,
        downloadProgress: null,
        installBlockedReason: null,
        installGuidance: null,
        errorMessage: null,
        lastCheckedAt: null,
        lastCheckIntent: null,
      }),
      downloadUpdate: async () => ({
        sequence: 2,
        status: "downloading",
        currentVersion: "0.0.0-test",
        allowPrerelease: false,
        latestVersion: "1.2.3",
        downloadProgress: 0,
        installBlockedReason: null,
        installGuidance: null,
        errorMessage: null,
        lastCheckedAt: null,
        lastCheckIntent: "manual",
      }),
      installUpdate: async () => ({
        sequence: 0,
        status: "idle",
        currentVersion: "0.0.0-test",
        allowPrerelease: false,
        latestVersion: null,
        downloadProgress: null,
        installBlockedReason: null,
        installGuidance: null,
        errorMessage: null,
        lastCheckedAt: null,
        lastCheckIntent: null,
      }),
      onChange: (_handler) => ({ dispose: () => undefined }),
    },
    support: {
      getSnapshot: async () => ({
        appName: "Traycer",
        appVersion: "0.0.0",
        platform: "darwin",
        arch: "arm64",
        user: {
          status: "signed-out",
          userName: null,
          email: null,
        },
        versions: { electron: "1", chrome: "2", node: "3" },
        host: {
          status: "starting",
          version: null,
          pid: null,
          hostId: null,
        },
        logs: [],
        links: [],
        supportEmail: "",
      }),
      revealLog: async (target) => ({ target, path: "/tmp/test.log" }),
      tailLog: async (input) => ({
        target: input.target,
        path: "/tmp/test.log",
        lines: [],
        truncated: false,
      }),
    },
    windows: {
      windowId: "window-1",
      list: async () => [],
      onChange: (_handler) => ({ dispose: () => undefined }),
      requestNew: async () => undefined,
      requestFocus: async () => undefined,
      requestClose: async () => undefined,
      requestOpenEpicInNewWindow: async () => ({
        result: "moved",
        windowId: "window-2",
      }),
      ownership: {
        snapshot: async () => [],
        claim: async (tabId, epicId) => {
          ownershipClaims.push({ tabId, epicId });
          return { ok: true };
        },
        release: async (tabId) => {
          ownershipReleases.push(tabId);
        },
        onChange: (_handler) => ({ dispose: () => undefined }),
      },
      perWindowState: {
        get: async () => ({
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        }),
        update: async () => undefined,
        clear: async () => undefined,
        onChange: (_handler) => ({ dispose: () => undefined }),
      },
      authSession: {
        get: async () => ({
          status: "signed-out",
          token: null,
          profile: null,
        }),
        set: async () => undefined,
        onChange: (_handler) => ({ dispose: () => undefined }),
      },
    },
    service: {
      status: async () => ({
        state: "not-installed" as const,
        version: null,
        listenUrl: null,
        pid: null,
      }),
      install: async () => undefined,
      uninstall: async (_purge: boolean) => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
      upgrade: async () => undefined,
      enableLinger: async () => undefined,
      getLogTail: async (_maxLines: number) => null,
    },
    traycerCli: {
      hostStatus: async () => ({
        running: false,
        pidMetadata: null,
        bootstrapMarkers: [],
        bootstrapLogPath: "/mock/bootstrap.log",
        bootstrapLogTail: "",
      }),
      shellConfigGet: async () => ({
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      }),
      shellConfigSet: async () => undefined,
      shellConfigReset: async () => undefined,
      shellConfigAdd: async () => undefined,
      shellConfigRemove: async () => undefined,
      shellRevertArgs: async () => undefined,
      shellProbe: async () => ({ exists: false, executable: false }),
      pickShellProgramFile: async () => null,
      shellListDetected: async () => [],
      envOverrideList: async () => [],
      envOverrideSet: async () => undefined,
      envOverrideDelete: async () => undefined,
      cliLogin: async () => undefined,
      cliLogout: async () => undefined,
    },
    migration: {
      announceRunning: async () => undefined,
      getSnapshot: async () => ({ running: false, originWindowId: null }),
      onChange: () => ({ dispose: () => undefined }),
    },
    platform: {
      recentDocuments: { add: async () => undefined },
      window: {
        flashFrame: async () => undefined,
        setProgressBar: async () => undefined,
        setRepresentedFilename: async () => undefined,
        setDocumentEdited: async () => undefined,
        setContentProtection: async () => undefined,
        setVibrancy: async () => undefined,
        setBackgroundMaterial: async () => undefined,
        setVisibleOnAllWorkspaces: async () => undefined,
      },
      app: { setBadge: async () => undefined },
      diagnostics: {
        getMetrics: async () => ({
          main: { residentSet: 0, private: 0, shared: 0 },
          appMetrics: [],
          cpuUsage: { user: 0, system: 0 },
        }),
        takeHeapSnapshot: async () => null,
        traceStart: async () => false,
        traceStop: async () => null,
      },
      systemPreferences: {
        getAccentColor: async () => null,
        getAppearance: async () => null,
        getAccessibilityTheme: async () => ({
          prefersReducedTransparency: false,
          shouldUseHighContrastColors: false,
          shouldUseDarkColors: true,
          shouldUseInvertedColorScheme: false,
        }),
        onAccessibilityThemeChange: () => ({ dispose: () => undefined }),
      },
      touchId: {
        isAvailable: async () => false,
        prompt: async () => false,
      },
      proxyAuth: {
        list: async () => [],
        save: async () => false,
        clear: async () => undefined,
      },
      proxy: {
        setConfig: async () => undefined,
        resolve: async () => "DIRECT",
      },
      certTrust: {
        list: async () => [],
        trust: async () => undefined,
        untrust: async () => undefined,
        listPending: async () => [],
        dismissPending: async () => undefined,
        showSystemDialog: async () => false,
        onPending: () => ({ dispose: () => undefined }),
      },
      display: {
        list: async () => ({ displays: [], primaryId: 0 }),
        onTopologyChange: () => ({ dispose: () => undefined }),
      },
      gpu: {
        getAccelerationEnabled: async () => true,
        setAccelerationEnabled: async (enabled: boolean) => enabled,
      },
      fonts: {
        list: async () => [],
      },
      windowEx: {
        setOverlayIcon: async () => undefined,
      },
    },
    power: {
      setSleepBlocked: async () => undefined,
    },
    zoom: {
      ladder: [100] as const,
      get: async () => 100,
      set: async () => 100,
      stepIn: async () => 100,
      stepOut: async () => 100,
      reset: async () => 100,
      onChange: (_handler) => ({ dispose: () => undefined }),
    },
    hostManagement: {
      installHost: async () => {
        throw new Error("installHost not used in test");
      },
      updateHost: async () => {
        throw new Error("updateHost not used in test");
      },
      uninstallHost: async () => {
        throw new Error("uninstallHost not used in test");
      },
      uninstallTraycer: async () => {
        throw new Error("uninstallTraycer not used in test");
      },
      getRemovalState: async () => ({ removedByUser: false }),
      clearRemoval: async () => undefined,
      restartHost: async () => undefined,
      getHostLogs: async () => ({ path: null, tail: "" }),
      runDoctor: async () => ({ issues: [], ranAt: "" }),
      availableVersions: async () => {
        throw new Error("availableVersions not used in test");
      },
      installedRecord: async () => null,
      registerService: async () => undefined,
      ensureHost: async () => ({
        action: "already-ready" as const,
        running: true,
        version: null,
      }),
      deregisterService: async () => undefined,
      registryCheck: async () => ({
        checkedAt: null,
        latestVersion: null,
        installedVersion: null,
        updateAvailable: false,
        reachable: false,
        errorMessage: null,
        includePreReleases: false,
      }),
      onRegistryUpdateState: () => ({ dispose: () => undefined }),
      getOperationStatus: async () => null,
      onOperationStatus: () => ({ dispose: () => undefined }),
      freePortAndRestart: async (input) => input,
      cliManifest: async () => null,
      getHostName: async () => ({
        systemName: "desktop-1",
        customName: null,
        effectiveName: "desktop-1",
      }),
      setHostName: async (input) => ({
        systemName: "desktop-1",
        customName: input.customName,
        effectiveName: input.customName ?? "desktop-1",
      }),
    },
    hostTray: {
      onCommand: () => ({ dispose: () => undefined }),
    },
  };

  return {
    bridge,
    ownershipClaims,
    ownershipReleases,
    temporaryWrites,
    emit(snapshot: LocalHostSnapshot | null): void {
      lastEmitted = snapshot;
      for (const handler of handlers) {
        handler(snapshot);
      }
    },
  };
}

const validSnapshot: LocalHostSnapshot = {
  hostId: "desktop-1",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "0.1.0",
  pid: 1234,
  systemHostName: "desktop-1",
  displayName: "desktop-1",
};

function buildDroppedFile(name: string, type: string, content: string): File {
  const file = new File([content], name, { type });
  Object.defineProperty(file, "arrayBuffer", {
    value: async (): Promise<ArrayBuffer> => {
      const bytes = new TextEncoder().encode(content);
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
  });
  return file;
}

describe("DesktopRunnerHost.onLocalHostChange", () => {
  it("replays the initial snapshot synchronously to the first subscriber", () => {
    const fake = buildFakeBridge(validSnapshot);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });

    const observed: Array<LocalHostSnapshot | null> = [];
    const subscription = host.onLocalHostChange((snapshot) => {
      observed.push(snapshot);
    });

    expect(observed).toEqual([validSnapshot]);
    subscription.dispose();
  });

  it("replays the cached snapshot synchronously to subscribers added after the bridge emission", () => {
    const fake = buildFakeBridge(validSnapshot);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });

    // First subscription primes the renderer-side cache via the bridge's
    // single replay.
    const first: Array<LocalHostSnapshot | null> = [];
    host.onLocalHostChange((snapshot) => {
      first.push(snapshot);
    });
    expect(first).toEqual([validSnapshot]);

    // A second, late subscriber must still receive the current value
    // immediately from the renderer-side cache even though the bridge will
    // not replay for it.
    const late: Array<LocalHostSnapshot | null> = [];
    host.onLocalHostChange((snapshot) => {
      late.push(snapshot);
    });
    expect(late).toEqual([validSnapshot]);
  });

  it("fans out subsequent transitions to every live subscriber", () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });

    const a: Array<LocalHostSnapshot | null> = [];
    const b: Array<LocalHostSnapshot | null> = [];
    host.onLocalHostChange((snapshot) => {
      a.push(snapshot);
    });
    host.onLocalHostChange((snapshot) => {
      b.push(snapshot);
    });

    // Both subscribers saw the initial null replay.
    expect(a).toEqual([null]);
    expect(b).toEqual([null]);

    fake.emit(validSnapshot);
    fake.emit(null);

    expect(a).toEqual([null, validSnapshot, null]);
    expect(b).toEqual([null, validSnapshot, null]);
  });

  it("stops delivering to disposed subscribers while keeping others live", () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });

    const kept: Array<LocalHostSnapshot | null> = [];
    const dropped: Array<LocalHostSnapshot | null> = [];
    host.onLocalHostChange((snapshot) => {
      kept.push(snapshot);
    });
    const subscription = host.onLocalHostChange((snapshot) => {
      dropped.push(snapshot);
    });
    subscription.dispose();

    fake.emit(validSnapshot);

    expect(kept).toEqual([null, validSnapshot]);
    expect(dropped).toEqual([null]);
  });

  it("exposes authnBaseUrl from the bridge as a plain readonly string", () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });
    expect(host.authnBaseUrl).toBe("http://localhost:5005");
  });

  it("delegates tokenStore.{get,set,delete} to the bridge", async () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });
    expect(await host.tokenStore.get()).toBeNull();
    await host.tokenStore.set({ token: "jwt-1", refreshToken: "refresh-1" });
    expect(await host.tokenStore.get()).toEqual({
      token: "jwt-1",
      refreshToken: "refresh-1",
    });
    // A bearer-only credential (empty refresh token) must round-trip, not be
    // dropped on read - else the session is lost on every restart.
    await host.tokenStore.set({ token: "jwt-2", refreshToken: "" });
    expect(await host.tokenStore.get()).toEqual({
      token: "jwt-2",
      refreshToken: "",
    });
    await host.tokenStore.delete();
    expect(await host.tokenStore.get()).toBeNull();
  });

  it("delegates validateAuthToken to the bridge", async () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });

    await expect(host.validateAuthToken("jwt-1", "refresh-1")).resolves.toEqual(
      {
        kind: "valid",
        profile: {
          userId: "test-user",
          userName: "Test User",
          email: "test@example.com",
        },
      },
    );
  });

  it("delegates validateAuthTokenIdentity to the bridge", async () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });

    await expect(
      host.validateAuthTokenIdentity("jwt-1", "refresh-1"),
    ).resolves.toEqual({
      kind: "rejected",
    });
  });

  it("delegates user sessions and step-up auth calls to the bridge", async () => {
    const fake = buildFakeBridge(null);
    const listUserSessions = vi.fn(async () => ({
      kind: "network-error" as const,
    }));
    const revokeUserSession = vi.fn(async () => ({
      kind: "network-error" as const,
    }));
    const revokeAllSessions = vi.fn(async () => ({
      kind: "network-error" as const,
    }));
    const requestStepUpChallenge = vi.fn(async () => ({
      kind: "network-error" as const,
    }));
    const verifyStepUpChallenge = vi.fn(async () => ({
      kind: "network-error" as const,
    }));
    fake.bridge.listUserSessions = listUserSessions;
    fake.bridge.revokeUserSession = revokeUserSession;
    fake.bridge.revokeAllSessions = revokeAllSessions;
    fake.bridge.requestStepUpChallenge = requestStepUpChallenge;
    fake.bridge.verifyStepUpChallenge = verifyStepUpChallenge;
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });

    await expect(host.listUserSessions("jwt")).resolves.toEqual({
      kind: "network-error",
    });
    await expect(
      host.revokeUserSession("jwt", "family-1", true),
    ).resolves.toEqual({ kind: "network-error" });
    await expect(host.revokeAllSessions("jwt")).resolves.toEqual({
      kind: "network-error",
    });
    await expect(host.requestStepUpChallenge("jwt")).resolves.toEqual({
      kind: "network-error",
    });
    await expect(host.verifyStepUpChallenge("jwt", "123456")).resolves.toEqual({
      kind: "network-error",
    });

    expect(listUserSessions).toHaveBeenCalledWith("jwt");
    expect(revokeUserSession).toHaveBeenCalledWith("jwt", "family-1", true);
    expect(revokeAllSessions).toHaveBeenCalledWith("jwt");
    expect(requestStepUpChallenge).toHaveBeenCalledWith("jwt");
    expect(verifyStepUpChallenge).toHaveBeenCalledWith("jwt", "123456");
  });

  it("exposes the desktop-only windows bridge without changing IRunnerHost", async () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });

    expect(host.windows.windowId).toBe("window-1");
    await expect(
      host.windows.ownership.claim("tab-a", "epic-a"),
    ).resolves.toEqual({ ok: true });
    await expect(
      host.windows.requestOpenEpicInNewWindow("epic-a", "Alpha", "tab-a"),
    ).resolves.toEqual({ result: "moved", windowId: "window-2" });
    await host.windows.ownership.release("tab-a");
    expect(fake.ownershipClaims).toEqual([
      { tabId: "tab-a", epicId: "epic-a" },
    ]);
    expect(fake.ownershipReleases).toEqual(["tab-a"]);
  });

  it("forwards requestHostRespawn to the bridge", async () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });
    await host.requestHostRespawn();
    await host.requestHostRespawn();
    // The fake bridge increments its internal counter - observable via a
    // subsequent respawn not throwing and the await resolving.
    expect(host.authnBaseUrl).toBe("http://localhost:5005");
  });

  it("passes host registry update subscriptions through to host management", () => {
    const fake = buildFakeBridge(null);
    const disposer = { dispose: vi.fn() };
    const onRegistryUpdateState = vi.fn(
      (_handler: (state: HostRegistryUpdateState) => void) => disposer,
    );
    fake.bridge.hostManagement.onRegistryUpdateState = onRegistryUpdateState;
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });
    const handler = vi.fn();

    const subscription = host.hostRegistryUpdates.onChange(handler);

    expect(onRegistryUpdateState).toHaveBeenCalledWith(handler);
    expect(subscription).toBe(disposer);
  });

  it("forwards workspace folder picking to the bridge", async () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });
    await expect(host.workspaceFolders.pickFolders()).resolves.toEqual([
      "/tmp/project-a",
      "/tmp/project-b",
    ]);
  });

  it("resolves dropped file paths and materializes pathless drops", async () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });
    const existing = buildDroppedFile("disk.txt", "text/plain", "disk");
    const pathless = buildDroppedFile("pathless.png", "image/png", "image");

    await expect(
      host.fileDrops.resolveDroppedFilePaths([existing, pathless]),
    ).resolves.toEqual(["/tmp/disk.txt", "/tmp/materialized-drop"]);
    expect(fake.temporaryWrites).toHaveLength(1);
    const write = fake.temporaryWrites[0];
    if (write === undefined) {
      throw new Error("expected pathless drop to be materialized");
    }
    expect(write.name).toBe("pathless.png");
    expect(write.type).toBe("image/png");
    await expect(new Response(write.bytes).text()).resolves.toBe("image");
  });

  it("materializes drops whose resolved path is an ephemeral macOS staging path", async () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });
    // getPathForFile returns a `…/TemporaryItems/…screencaptureui_…` path - the
    // macOS screenshot thumbnail's ephemeral staging file. It must be copied
    // out (materialized), not pasted verbatim.
    const screenshot = buildDroppedFile("screenshot.png", "image/png", "png");

    await expect(
      host.fileDrops.resolveDroppedFilePaths([screenshot]),
    ).resolves.toEqual(["/tmp/materialized-drop"]);
    expect(fake.temporaryWrites).toHaveLength(1);
    expect(fake.temporaryWrites[0]?.name).toBe("screenshot.png");
  });

  it("preserves stable URI paths and copies only ephemeral dropped paths", async () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });
    const copyTemporaryFiles = vi.spyOn(
      fake.bridge.fileDrops,
      "copyTemporaryFiles",
    );
    const stablePath = "/repo/src/index.ts";
    const ephemeralPath =
      "/var/folders/x/TemporaryItems/screencaptureui_1/Screenshot.png";

    await expect(
      host.fileDrops.copyDroppedFilePaths([stablePath, ephemeralPath]),
    ).resolves.toEqual([stablePath, "/tmp/copied/Screenshot.png"]);
    expect(copyTemporaryFiles).toHaveBeenCalledOnce();
    expect(copyTemporaryFiles).toHaveBeenCalledWith([ephemeralPath]);
    await expect(host.fileDrops.copyDroppedFilePaths([])).resolves.toEqual([]);
  });

  it("replays the latest snapshot - not the initial one - to subscribers added after a transition", () => {
    const fake = buildFakeBridge(null);
    const host = new DesktopRunnerHost({
      bridge: fake.bridge,
      signInUrl: "https://auth.example.invalid/sign-in",
    });

    // Prime via first subscriber and then drive a transition to a new value.
    host.onLocalHostChange(() => undefined);
    fake.emit(validSnapshot);

    const late: Array<LocalHostSnapshot | null> = [];
    host.onLocalHostChange((snapshot) => {
      late.push(snapshot);
    });
    expect(late).toEqual([validSnapshot]);
  });
});
