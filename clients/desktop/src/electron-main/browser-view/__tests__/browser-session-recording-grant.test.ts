import { beforeEach, describe, expect, it } from "vitest";
import type { Cookie } from "electron";
import { vi } from "vitest";
import type * as RecordingHelperRegistryModule from "../recording/recording-helper-registry";

/**
 * `browser-session.test.ts`'s pattern calls `vi.resetModules()` per test and
 * dynamically re-imports `../browser-session` afterwards, which gives it a
 * FRESH copy of every module it transitively imports - including the
 * registry. A statically-imported registry binding here would be a stale
 * singleton that `browser-session`'s fresh copy never reads from, so the
 * registry is imported dynamically in each test too, from the same
 * `import()` call graph, after `resetModules()` has run.
 */
async function importRegistry(): Promise<typeof RecordingHelperRegistryModule> {
  return await import("../recording/recording-helper-registry");
}

/**
 * Drives the REAL `installBrowserViewSessionPolicy` (via `ensureBrowserViewSession`,
 * the same entry point `browser-session.test.ts` uses) together with the REAL
 * registry, asserting the security boundary end to end: an ordinary guest is
 * refused `getDisplayMedia`/`display-capture` exactly as before, and a
 * registered recording helper is granted exactly its own guest's video and
 * nothing else. Same mocking shape as `browser-session.test.ts` - see that
 * file for the harness this one borrows.
 */

type BrowserPermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (permissionGranted: boolean) => void,
  details: unknown,
) => void;
type BrowserPermissionCheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details: unknown,
) => boolean;
type BrowserDisplayMediaRequestHandler = (
  request: unknown,
  callback: (streams: object) => void,
) => void;
type FakeCookieChangeListener = (
  event: unknown,
  cookie: Cookie,
  cause: string,
  removed: boolean,
) => void;
type BrowserDownloadListener = (
  event: unknown,
  item: unknown,
  webContents: unknown,
) => void;

const electronState = vi.hoisted(() => {
  const state = {
    browserSession: null as FakePolicySession | null,
    defaultSession: null as FakePolicySession | null,
    fromPartitionCalls: [] as Array<{
      readonly partition: string;
      readonly options: { readonly cache: boolean };
    }>,
  };
  return state;
});

vi.mock("electron", () => ({
  app: {
    getPath: (_key: string): string => "/tmp/traycer-desktop-test",
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "unknown",
  },
  dialog: {
    showSaveDialogSync: () => "/tmp/traycer-downloads/file.txt",
    showMessageBoxSync: () => 1,
  },
  session: {
    get defaultSession(): FakePolicySession | null {
      return electronState.defaultSession;
    },
    fromPartition: (
      partition: string,
      options: { readonly cache: boolean },
    ): FakePolicySession => {
      electronState.fromPartitionCalls.push({ partition, options });
      const browserSession = electronState.browserSession;
      if (browserSession === null) {
        throw new Error("browser session fake missing");
      }
      return browserSession;
    },
  },
}));

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

class FakePolicySession {
  permissionRequestHandler: BrowserPermissionRequestHandler | null = null;
  permissionCheckHandler: BrowserPermissionCheckHandler | null = null;
  devicePermissionHandler: ((details: unknown) => boolean) | null = null;
  usbProtectedClassesHandler: ((details: unknown) => unknown[]) | null = null;
  bluetoothPairingHandler:
    | ((
        details: unknown,
        callback: (response: { readonly confirmed: boolean }) => void,
      ) => void)
    | null = null;
  displayMediaRequestHandler: BrowserDisplayMediaRequestHandler | null = null;
  readonly downloadListeners: BrowserDownloadListener[] = [];
  beforeRequestListener:
    | ((
        details: { readonly url: string; readonly webContentsId?: number },
        callback: (response: { readonly cancel?: boolean }) => void,
      ) => void)
    | null = null;
  readonly webRequest = {
    onBeforeRequest: (
      listener: (
        details: { readonly url: string; readonly webContentsId?: number },
        callback: (response: { readonly cancel?: boolean }) => void,
      ) => void,
    ): void => {
      this.beforeRequestListener = listener;
    },
  };

  readonly cookies = {
    get: (_filter: { readonly domain: string }): Promise<Cookie[]> =>
      Promise.resolve([]),
    on: (_event: "changed", _listener: FakeCookieChangeListener): void => {},
    off: (_event: "changed", _listener: FakeCookieChangeListener): void => {},
  };

  setPermissionRequestHandler(
    handler: BrowserPermissionRequestHandler | null,
  ): void {
    this.permissionRequestHandler = handler;
  }

  setPermissionCheckHandler(
    handler: BrowserPermissionCheckHandler | null,
  ): void {
    this.permissionCheckHandler = handler;
  }

  setDevicePermissionHandler(
    handler: ((details: unknown) => boolean) | null,
  ): void {
    this.devicePermissionHandler = handler;
  }

  setUSBProtectedClassesHandler(
    handler: ((details: unknown) => unknown[]) | null,
  ): void {
    this.usbProtectedClassesHandler = handler;
  }

  setBluetoothPairingHandler(
    handler:
      | ((
          details: unknown,
          callback: (response: { readonly confirmed: boolean }) => void,
        ) => void)
      | null,
  ): void {
    this.bluetoothPairingHandler = handler;
  }

  setDisplayMediaRequestHandler(
    handler: BrowserDisplayMediaRequestHandler | null,
  ): void {
    this.displayMediaRequestHandler = handler;
  }

  on(event: "will-download", listener: BrowserDownloadListener): void {
    expect(event).toBe("will-download");
    this.downloadListeners.push(listener);
  }

  clearStorageDataCalls = 0;

  clearStorageData(): Promise<void> {
    this.clearStorageDataCalls += 1;
    return Promise.resolve();
  }
}

const PRIMARY = { profile: "primary" as const, sessionId: "session-1" };

function readRequestHandler(
  session: FakePolicySession,
): BrowserPermissionRequestHandler {
  const handler = session.permissionRequestHandler;
  if (handler === null) throw new Error("permission request handler missing");
  return handler;
}

function readCheckHandler(
  session: FakePolicySession,
): BrowserPermissionCheckHandler {
  const handler = session.permissionCheckHandler;
  if (handler === null) throw new Error("permission check handler missing");
  return handler;
}

function readDisplayMediaHandler(
  session: FakePolicySession,
): BrowserDisplayMediaRequestHandler {
  const handler = session.displayMediaRequestHandler;
  if (handler === null) throw new Error("display media handler missing");
  return handler;
}

function requestAllowed(
  handler: BrowserPermissionRequestHandler,
  permission: string,
  webContents: unknown,
): boolean {
  return requestAllowedWithDetails(handler, permission, webContents, {});
}

/**
 * The `media` answers depend on the DETAILS Electron hands the handler, which
 * differ per handler (`electron.d.ts`, Electron 42):
 * `MediaAccessPermissionRequest.mediaTypes` on the request handler,
 * `PermissionCheckHandlerHandlerDetails.mediaType` on the check one.
 */
function requestAllowedWithDetails(
  handler: BrowserPermissionRequestHandler,
  permission: string,
  webContents: unknown,
  details: unknown,
): boolean {
  let allowed: boolean | null = null;
  handler(
    webContents,
    permission,
    (value) => {
      allowed = value;
    },
    details,
  );
  if (allowed === null) throw new Error("permission callback never invoked");
  return allowed;
}

function askDisplayMedia(
  handler: BrowserDisplayMediaRequestHandler,
  request: unknown,
): object {
  let streams: object | null = null;
  handler(request, (value) => {
    streams = value;
  });
  if (streams === null) throw new Error("display media callback never invoked");
  return streams;
}

describe("browser session recording grant boundary", () => {
  beforeEach(() => {
    electronState.browserSession = new FakePolicySession();
    electronState.defaultSession = new FakePolicySession();
    electronState.fromPartitionCalls = [];
    vi.clearAllMocks();
    // `browser-session` memoises one hardened Session per partition name, so
    // each case needs a fresh module instance to pair with its fresh fakes.
    vi.resetModules();
  });

  it("still denies getDisplayMedia for an ordinary guest page", async () => {
    const mod = await import("../browser-session");
    const session = new FakePolicySession();
    electronState.browserSession = session;
    mod.ensureBrowserViewSession(PRIMARY);

    const handler = readDisplayMediaHandler(session);
    const streams = askDisplayMedia(handler, {
      frame: { processId: 1, routingId: 2 },
    });

    expect(streams).not.toHaveProperty("video");
  });

  it("grants a registered helper's request its own registered guest frame, and never a crossed one", async () => {
    const mod = await import("../browser-session");
    const registry = await importRegistry();
    const session = new FakePolicySession();
    electronState.browserSession = session;
    mod.ensureBrowserViewSession(PRIMARY);
    const handler = readDisplayMediaHandler(session);

    const guestFrameA = { guest: "A" };
    const guestFrameB = { guest: "B" };
    const disposeA = registry.registerRecordingHelper({
      recordingId: "rec-a",
      helperWebContentsId: 201,
      helperFrame: () => ({ processId: 1, routingId: 11 }),
      video: () => guestFrameA,
    });
    const disposeB = registry.registerRecordingHelper({
      recordingId: "rec-b",
      helperWebContentsId: 202,
      helperFrame: () => ({ processId: 2, routingId: 22 }),
      video: () => guestFrameB,
    });

    const streamsA = askDisplayMedia(handler, {
      frame: { processId: 1, routingId: 11 },
    });
    expect(streamsA).toMatchObject({ video: guestFrameA });
    expect((streamsA as { video: object }).video).toBe(guestFrameA);

    const streamsB = askDisplayMedia(handler, {
      frame: { processId: 2, routingId: 22 },
    });
    expect((streamsB as { video: object }).video).toBe(guestFrameB);
    expect((streamsB as { video: object }).video).not.toBe(guestFrameA);

    disposeA();
    disposeB();
  });

  it("denies the helper again once its registration's disposer has run", async () => {
    const mod = await import("../browser-session");
    const registry = await importRegistry();
    const session = new FakePolicySession();
    electronState.browserSession = session;
    mod.ensureBrowserViewSession(PRIMARY);
    const handler = readDisplayMediaHandler(session);

    const dispose = registry.registerRecordingHelper({
      recordingId: "rec-a",
      helperWebContentsId: 201,
      helperFrame: () => ({ processId: 1, routingId: 11 }),
      video: () => ({ guest: "A" }),
    });

    const grantedStreams = askDisplayMedia(handler, {
      frame: { processId: 1, routingId: 11 },
    });
    expect(grantedStreams).toHaveProperty("video");

    dispose();

    const deniedStreams = askDisplayMedia(handler, {
      frame: { processId: 1, routingId: 11 },
    });
    expect(deniedStreams).not.toHaveProperty("video");
  });

  it("grants display-capture only to a registered helper's own webContents, refuses an ordinary guest and a revoked helper", async () => {
    const mod = await import("../browser-session");
    const registry = await importRegistry();
    const session = new FakePolicySession();
    electronState.browserSession = session;
    mod.ensureBrowserViewSession(PRIMARY);
    const requestHandler = readRequestHandler(session);
    const checkHandler = readCheckHandler(session);

    // An ordinary, unregistered guest.
    expect(requestAllowed(requestHandler, "display-capture", { id: 999 })).toBe(
      false,
    );
    expect(
      checkHandler({ id: 999 }, "display-capture", "https://example.com", {}),
    ).toBe(false);
    // Also refused for the request handler's `null` webContents shape (used
    // elsewhere in this suite for the always-allowed set) - display-capture
    // must never fall into that bucket.
    expect(requestAllowed(requestHandler, "display-capture", null)).toBe(false);

    const dispose = registry.registerRecordingHelper({
      recordingId: "rec-a",
      helperWebContentsId: 55,
      helperFrame: () => ({ processId: 1, routingId: 11 }),
      video: () => ({ guest: "A" }),
    });

    expect(requestAllowed(requestHandler, "display-capture", { id: 55 })).toBe(
      true,
    );
    expect(
      checkHandler({ id: 55 }, "display-capture", "https://example.com", {}),
    ).toBe(true);

    dispose();

    expect(requestAllowed(requestHandler, "display-capture", { id: 55 })).toBe(
      false,
    );
    expect(
      checkHandler({ id: 55 }, "display-capture", "https://example.com", {}),
    ).toBe(false);
  });

  it("keeps every other permission exactly as before for an ordinary webContents", async () => {
    const mod = await import("../browser-session");
    const session = new FakePolicySession();
    electronState.browserSession = session;
    mod.ensureBrowserViewSession(PRIMARY);
    const requestHandler = readRequestHandler(session);
    const checkHandler = readCheckHandler(session);

    // The static allow-set is granted for any ordinary/unregistered
    // webContents, including null.
    for (const permission of [
      "clipboard-sanitized-write",
      "fullscreen",
      "mediaKeySystem",
      "pointerLock",
      "storage-access",
      "top-level-storage-access",
    ]) {
      expect(requestAllowed(requestHandler, permission, null)).toBe(true);
      expect(checkHandler(null, permission, "https://example.com", {})).toBe(
        true,
      );
    }

    // A non-member is refused for an ordinary webContents too.
    for (const permission of ["geolocation", "media", "notifications"]) {
      expect(requestAllowed(requestHandler, permission, null)).toBe(false);
      expect(checkHandler(null, permission, "https://example.com", {})).toBe(
        false,
      );
    }
  });

  it("scopes the helper exception BOTH ways: a registered helper gets display-capture and nothing else, not even the static allow-set", async () => {
    const mod = await import("../browser-session");
    const registry = await importRegistry();
    const session = new FakePolicySession();
    electronState.browserSession = session;
    mod.ensureBrowserViewSession(PRIMARY);
    const requestHandler = readRequestHandler(session);
    const checkHandler = readCheckHandler(session);

    const dispose = registry.registerRecordingHelper({
      recordingId: "rec-a",
      helperWebContentsId: 55,
      helperFrame: () => ({ processId: 1, routingId: 11 }),
      video: () => ({ guest: "A" }),
    });

    // A registered helper is a one-job document of ours, not a guest: the
    // ordinary allow-set (granted to every guest) is REFUSED to it.
    for (const permission of [
      "clipboard-sanitized-write",
      "fullscreen",
      "mediaKeySystem",
      "pointerLock",
      "storage-access",
      "top-level-storage-access",
      "geolocation",
      "notifications",
    ]) {
      expect(requestAllowed(requestHandler, permission, { id: 55 })).toBe(
        false,
      );
      expect(
        checkHandler({ id: 55 }, permission, "https://example.com", {}),
      ).toBe(false);
    }

    // display-capture and a VIDEO media ask are the two exceptions, and only
    // for the helper.
    expect(requestAllowed(requestHandler, "display-capture", { id: 55 })).toBe(
      true,
    );
    expect(
      checkHandler({ id: 55 }, "display-capture", "https://example.com", {}),
    ).toBe(true);
    expect(requestAllowed(requestHandler, "media", { id: 55 })).toBe(true);

    dispose();
  });

  /**
   * THE BUG THIS MATRIX EXISTS FOR. Chromium runs a `getDisplayMedia` call
   * through the MEDIA permission handlers before it ever consults
   * `setDisplayMediaRequestHandler`, so a helper denied `media` had its
   * `getDisplayMedia` rejected `NotAllowedError` and every recording ended
   * `helper-start-failed`.
   */
  it("admits a registered helper's video media ask, refuses an audio one, and refuses every guest media ask", async () => {
    const mod = await import("../browser-session");
    const registry = await importRegistry();
    const session = new FakePolicySession();
    electronState.browserSession = session;
    mod.ensureBrowserViewSession(PRIMARY);
    const requestHandler = readRequestHandler(session);
    const checkHandler = readCheckHandler(session);

    const dispose = registry.registerRecordingHelper({
      recordingId: "rec-a",
      helperWebContentsId: 55,
      helperFrame: () => ({ processId: 1, routingId: 11 }),
      video: () => ({ guest: "A" }),
    });

    // Video, on both handlers' detail shapes, and on details that say nothing
    // (`getDisplayMedia` is the only thing our helper document asks for).
    for (const details of [
      {},
      { mediaTypes: ["video"] },
      { mediaType: "video" },
      { mediaType: "unknown" },
    ]) {
      expect(
        requestAllowedWithDetails(requestHandler, "media", { id: 55 }, details),
      ).toBe(true);
      expect(
        checkHandler({ id: 55 }, "media", "https://example.com", details),
      ).toBe(true);
    }

    // Audio is refused outright - a recording has no audio track (D14).
    for (const details of [
      { mediaTypes: ["audio"] },
      { mediaTypes: ["video", "audio"] },
      { mediaType: "audio" },
    ]) {
      expect(
        requestAllowedWithDetails(requestHandler, "media", { id: 55 }, details),
      ).toBe(false);
      expect(
        checkHandler({ id: 55 }, "media", "https://example.com", details),
      ).toBe(false);
    }

    // A helper still gets nothing else - the static allow-set included.
    expect(
      requestAllowed(requestHandler, "clipboard-sanitized-write", { id: 55 }),
    ).toBe(false);
    expect(
      checkHandler(
        { id: 55 },
        "clipboard-sanitized-write",
        "https://example.com",
        {},
      ),
    ).toBe(false);

    // An ordinary guest is refused media whatever it asks for, and
    // display-capture too: `media` is not in BROWSER_ALLOWED_PERMISSIONS and
    // this fix does not put it there.
    for (const details of [
      {},
      { mediaTypes: ["video"] },
      { mediaType: "video" },
    ]) {
      expect(
        requestAllowedWithDetails(
          requestHandler,
          "media",
          { id: 999 },
          details,
        ),
      ).toBe(false);
      expect(
        checkHandler({ id: 999 }, "media", "https://example.com", details),
      ).toBe(false);
      expect(
        requestAllowedWithDetails(requestHandler, "media", null, details),
      ).toBe(false);
    }
    expect(requestAllowed(requestHandler, "display-capture", { id: 999 })).toBe(
      false,
    );

    dispose();

    // Revoked: the helper's own media ask goes back to a guest's answer.
    expect(requestAllowed(requestHandler, "media", { id: 55 })).toBe(false);
  });

  /**
   * ORDER. The permission check is what a `getDisplayMedia` hits first; the
   * display-media request handler is only reached once it has said yes, and it
   * is the one that names the guest frame.
   */
  it("consults the display-media request handler after the permission check, and answers the helper's own guest mainFrame", async () => {
    const mod = await import("../browser-session");
    const registry = await importRegistry();
    const session = new FakePolicySession();
    electronState.browserSession = session;
    mod.ensureBrowserViewSession(PRIMARY);
    const requestHandler = readRequestHandler(session);
    const displayMediaHandler = readDisplayMediaHandler(session);

    const guestMainFrame = { processId: 9, routingId: 90 };
    const dispose = registry.registerRecordingHelper({
      recordingId: "rec-a",
      helperWebContentsId: 55,
      helperFrame: () => ({ processId: 1, routingId: 11 }),
      video: () => guestMainFrame,
    });

    const order: string[] = [];
    const mediaAllowed = requestAllowedWithDetails(
      requestHandler,
      "media",
      { id: 55 },
      { mediaTypes: ["video"] },
    );
    order.push(`permission:${String(mediaAllowed)}`);
    const streams = askDisplayMedia(displayMediaHandler, {
      frame: { processId: 1, routingId: 11 },
    });
    order.push("display-media");

    expect(order).toEqual(["permission:true", "display-media"]);
    expect(streams).toEqual({ video: guestMainFrame });

    dispose();
  });

  it("does not grow BROWSER_ALLOWED_PERMISSIONS: display-capture is refused for an unregistered webContents", async () => {
    const mod = await import("../browser-session");
    const registry = await importRegistry();
    const session = new FakePolicySession();
    electronState.browserSession = session;
    mod.ensureBrowserViewSession(PRIMARY);
    const requestHandler = readRequestHandler(session);

    expect(registry.recordingHelperRegistrationCount()).toBe(0);
    expect(
      requestAllowed(requestHandler, "display-capture", { id: 4242 }),
    ).toBe(false);
  });
});
