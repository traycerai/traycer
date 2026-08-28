import { EventEmitter } from "node:events";
import type { Certificate, CertificatePrincipal } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSessionCertificateErrorChange,
  BrowserSessionDownloadChange,
} from "../browser-session";

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
type BrowserDownloadListener = (
  event: unknown,
  item: FakeDownloadItem,
  webContents: FakeDownloadWebContents,
) => void;

const electronState = vi.hoisted(() => {
  const state = {
    browserSession: null as FakePolicySession | null,
    defaultSession: null as FakePolicySession | null,
    saveDialogResult: "/tmp/traycer-downloads/file.txt" as string | undefined,
    saveDialogCalls: 0,
    messageBoxResult: 1,
    messageBoxCalls: 0,
    fromPartitionCalls: [] as Array<{
      readonly partition: string;
      readonly options: { readonly cache: boolean };
    }>,
  };
  return state;
});

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "unknown",
  },
  dialog: {
    showSaveDialogSync: () => {
      electronState.saveDialogCalls += 1;
      return electronState.saveDialogResult;
    },
    showMessageBoxSync: () => {
      electronState.messageBoxCalls += 1;
      return electronState.messageBoxResult;
    },
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
}

class FakeTrackedWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }

  once(event: "destroyed", listener: () => void): this {
    return super.once(event, listener);
  }
}

class FakeCertificate implements Certificate {
  data = "certificate";
  fingerprint = "fingerprint";
  issuer = certificatePrincipal("issuer");
  issuerCert: Certificate = this;
  issuerName = "issuer";
  serialNumber = "01";
  subject = certificatePrincipal("subject");
  subjectName = "subject";
  validExpiry = 4_102_444_800;
  validStart = 1_704_067_200;
}

function certificatePrincipal(commonName: string): CertificatePrincipal {
  return {
    commonName,
    country: "",
    locality: "",
    organizations: [],
    organizationUnits: [],
    state: "",
  };
}

class FakeDownloadItem {
  readonly emitter = new EventEmitter();
  savePath = "";
  cancelCalls = 0;

  constructor(
    readonly url: string,
    readonly filename: string,
    readonly mimeType: string,
    readonly totalBytes: number,
    public receivedBytes: number,
  ) {}

  getURL(): string {
    return this.url;
  }

  getFilename(): string {
    return this.filename;
  }

  getMimeType(): string {
    return this.mimeType;
  }

  getTotalBytes(): number {
    return this.totalBytes;
  }

  getReceivedBytes(): number {
    return this.receivedBytes;
  }

  getSavePath(): string {
    return this.savePath;
  }

  setSavePath(path: string): void {
    this.savePath = path;
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  on(
    event: "updated" | "done",
    listener: (downloadEvent: unknown, state: string) => void,
  ): void {
    this.emitter.on(event, listener);
  }

  emitUpdated(state: string, receivedBytes: number): void {
    this.receivedBytes = receivedBytes;
    this.emitter.emit("updated", {}, state);
  }

  emitDone(state: string, receivedBytes: number): void {
    this.receivedBytes = receivedBytes;
    this.emitter.emit("done", {}, state);
  }
}

class FakeDownloadWebContents {
  constructor(
    readonly id: number,
    readonly url: string,
  ) {}

  getURL(): string {
    return this.url;
  }
}

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

function requestAllowed(
  handler: BrowserPermissionRequestHandler,
  permission: string,
): boolean {
  let allowed = false;
  handler(
    null,
    permission,
    (value) => {
      allowed = value;
    },
    {},
  );
  return allowed;
}

function realCookieCryptoState() {
  return {
    mode: "real" as const,
    persistence: "persistent" as const,
    reason: "os-backed" as const,
    storageBackend: null,
    encryptionAvailable: true,
  };
}

function degradedCookieCryptoState() {
  return {
    mode: "degraded" as const,
    persistence: "ephemeral" as const,
    reason: "keychain-denied" as const,
    storageBackend: null,
    encryptionAvailable: false,
  };
}

describe("browser view session policy", () => {
  beforeEach(() => {
    electronState.browserSession = new FakePolicySession();
    electronState.defaultSession = new FakePolicySession();
    electronState.fromPartitionCalls = [];
    electronState.saveDialogResult = "/tmp/traycer-downloads/file.txt";
    electronState.saveDialogCalls = 0;
    electronState.messageBoxResult = 1;
    electronState.messageBoxCalls = 0;
    vi.clearAllMocks();
  });

  it("uses a dedicated persistent partition without mutating defaultSession", async () => {
    const crypto = await import("../storage/browser-cookie-crypto");
    vi.spyOn(crypto, "getBrowserCookieCryptoState").mockReturnValue(
      realCookieCryptoState(),
    );
    const mod = await import("../browser-session");

    const browserSession = mod.ensureBrowserViewSession();
    const preferences = mod.createBrowserViewWebPreferences();

    expect(electronState.fromPartitionCalls).toEqual([
      {
        partition: mod.BROWSER_VIEW_PARTITION,
        options: { cache: true },
      },
    ]);
    expect(browserSession).toBe(electronState.browserSession);
    expect(mod.BROWSER_VIEW_PARTITION.startsWith("persist:")).toBe(true);
    expect(preferences).toMatchObject({
      partition: mod.BROWSER_VIEW_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    expect(preferences).not.toHaveProperty("preload");
    expect(preferences).not.toHaveProperty("webSecurity", false);
    expect(electronState.defaultSession?.permissionRequestHandler).toBeNull();
    expect(electronState.defaultSession?.permissionCheckHandler).toBeNull();
    expect(electronState.defaultSession?.downloadListeners).toEqual([]);
  });

  it("uses a session-only partition when cookie crypto is degraded", async () => {
    const crypto = await import("../storage/browser-cookie-crypto");
    vi.spyOn(crypto, "getBrowserCookieCryptoState").mockReturnValue(
      degradedCookieCryptoState(),
    );
    const mod = await import("../browser-session");

    mod.ensureBrowserViewSession();
    const preferences = mod.createBrowserViewWebPreferences();
    const partition = preferences.partition;
    if (partition === undefined) throw new Error("partition missing");

    expect(electronState.fromPartitionCalls).toEqual([
      {
        partition,
        options: { cache: true },
      },
    ]);
    expect(partition.startsWith("persist:")).toBe(false);
    expect(preferences).toMatchObject({
      partition,
    });
  });

  it("installs browser-specific permission and download handlers", async () => {
    const mod = await import("../browser-session");
    const session = new FakePolicySession();
    electronState.browserSession = session;

    mod.ensureBrowserViewSession();

    const requestHandler = readRequestHandler(session);
    const checkHandler = readCheckHandler(session);
    expect(requestAllowed(requestHandler, "storage-access")).toBe(true);
    expect(requestAllowed(requestHandler, "top-level-storage-access")).toBe(
      true,
    );
    expect(requestAllowed(requestHandler, "media")).toBe(false);
    expect(requestAllowed(requestHandler, "geolocation")).toBe(false);
    expect(
      checkHandler(null, "storage-access", "https://example.com", {}),
    ).toBe(true);
    expect(checkHandler(null, "media", "https://example.com", {})).toBe(false);
    expect(session.devicePermissionHandler?.({})).toBe(false);
    expect(session.usbProtectedClassesHandler?.({})).toEqual([]);
    expect(session.downloadListeners).toHaveLength(1);
  });

  it("surfaces download prompt, progress, completion, and cancellation states", async () => {
    const mod = await import("../browser-session");
    const session = new FakePolicySession();
    const changes: BrowserSessionDownloadChange[] = [];
    const offDownloadChange = mod.onBrowserViewDownloadChange((change) => {
      changes.push(change);
    });
    electronState.browserSession = session;

    mod.ensureBrowserViewSession();
    const listener = session.downloadListeners[0];
    if (listener === undefined) throw new Error("download listener missing");
    const webContents = new FakeDownloadWebContents(7, "https://app.test/");
    const completedItem = new FakeDownloadItem(
      "https://app.test/file.txt",
      "file.txt",
      "text/plain",
      100,
      0,
    );

    listener({}, completedItem, webContents);

    expect(completedItem.savePath).toBe("/tmp/traycer-downloads/file.txt");
    expect(electronState.saveDialogCalls).toBe(1);
    expect(changes.map((change) => change.state)).toEqual([
      "prompting",
      "progressing",
    ]);
    completedItem.emitUpdated("progressing", 50);
    completedItem.emitDone("completed", 100);
    expect(changes.at(-2)).toMatchObject({
      state: "progressing",
      receivedBytes: 50,
      canCancel: true,
    });
    expect(changes.at(-1)).toMatchObject({
      state: "completed",
      receivedBytes: 100,
      canCancel: false,
      savePath: "/tmp/traycer-downloads/file.txt",
    });

    const cancellableItem = new FakeDownloadItem(
      "https://app.test/large.bin",
      "large.bin",
      "application/octet-stream",
      200,
      25,
    );
    listener({}, cancellableItem, webContents);
    const cancellableDownloadId = changes.at(-1)?.downloadId;
    if (cancellableDownloadId === undefined) {
      throw new Error("download id missing");
    }

    expect(mod.cancelBrowserViewDownload(cancellableDownloadId)).toBe(true);
    expect(cancellableItem.cancelCalls).toBe(1);
    cancellableItem.emitDone("cancelled", 25);
    expect(changes.at(-1)).toMatchObject({
      state: "cancelled",
      canCancel: false,
    });

    offDownloadChange();
  });

  it("requires explicit confirmation before accepting dangerous downloads", async () => {
    const mod = await import("../browser-session");
    const session = new FakePolicySession();
    const changes: BrowserSessionDownloadChange[] = [];
    const offDownloadChange = mod.onBrowserViewDownloadChange((change) => {
      changes.push(change);
    });
    electronState.messageBoxResult = 0;
    electronState.browserSession = session;

    mod.ensureBrowserViewSession();
    const listener = session.downloadListeners[0];
    if (listener === undefined) throw new Error("download listener missing");
    const item = new FakeDownloadItem(
      "https://app.test/install.sh",
      "install.sh",
      "text/x-shellscript",
      10,
      0,
    );

    listener({}, item, new FakeDownloadWebContents(8, "https://app.test/"));

    expect(electronState.messageBoxCalls).toBe(1);
    expect(electronState.saveDialogCalls).toBe(0);
    expect(item.cancelCalls).toBe(1);
    expect(changes.map((change) => change.state)).toEqual([
      "prompting",
      "cancelled",
    ]);
    expect(changes[0]).toMatchObject({ dangerType: ".sh" });

    offDownloadChange();
  });

  it("clears browser identity and pending certificate errors on destruction", async () => {
    const mod = await import("../browser-session");
    const webContents = new FakeTrackedWebContents(42);
    const certificateErrors: BrowserSessionCertificateErrorChange[] = [];
    const stop = mod.onBrowserViewCertificateError((change) => {
      certificateErrors.push(change);
    });

    mod.registerBrowserViewWebContents(webContents);
    expect(mod.isBrowserViewWebContents(webContents)).toBe(true);
    mod.handleBrowserViewCertificateError({
      webContentsId: webContents.id,
      url: "https://invalid.test",
      hostname: "invalid.test",
      error: "net::ERR_CERT_AUTHORITY_INVALID",
      fingerprint: "fingerprint",
      certificate: new FakeCertificate(),
    });
    const certificateErrorId = certificateErrors[0]?.certificateErrorId;
    if (certificateErrorId === undefined) {
      throw new Error("certificate error was not recorded");
    }
    expect(
      mod.readBrowserViewPendingCertificateError(certificateErrorId),
    ).not.toBeNull();

    webContents.emit("destroyed");
    expect(mod.isBrowserViewWebContents(webContents)).toBe(false);
    expect(
      mod.readBrowserViewPendingCertificateError(certificateErrorId),
    ).toBeNull();
    stop();
  });
});
