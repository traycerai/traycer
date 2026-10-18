import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import { registerPlatformIpc } from "../platform-ipc";

const showSaveDialog = vi.hoisted(() => vi.fn());
const openPath = vi.hoisted(() => vi.fn(async () => ""));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => `/tmp/traycer-test-${name}`,
  },
  BrowserWindow: {
    fromWebContents: (): null => null,
  },
  clipboard: {
    writeImage: vi.fn(),
    readBuffer: (): Buffer => Buffer.alloc(0),
  },
  dialog: {
    showSaveDialog,
  },
  nativeImage: {
    createFromBuffer: vi.fn(),
  },
  shell: {
    openPath,
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

const STARTUP_TIMEOUT_MS = 30_000;
const URL_A = "https://objects.test/a/report.pdf?sig=abc";

/** The renderer's `webContents`, as far as the download path touches it. */
class FakeSender extends EventEmitter {
  readonly session = new EventEmitter();
  readonly downloadURL = vi.fn<(url: string) => void>();
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }

  willDownloadListeners(): number {
    return this.session.listenerCount("will-download");
  }
}

/** One Electron `DownloadItem`, driven by hand. */
class FakeItem extends EventEmitter {
  readonly setSavePath = vi.fn<(path: string) => void>();
  readonly cancel = vi.fn<() => void>();

  constructor(private readonly chain: readonly string[]) {
    super();
  }

  getURLChain(): string[] {
    return [...this.chain];
  }

  finish(state: "completed" | "cancelled" | "interrupted"): void {
    this.emit("done", {}, state);
  }
}

function installHandlers(): Map<string, InvokeHandler> {
  const handlers = new Map<string, InvokeHandler>();
  registerPlatformIpc({
    handleInvoke: (channel, handler) => {
      handlers.set(channel, handler);
    },
  });
  return handlers;
}

function eventFor(sender: FakeSender): IpcMainInvokeEvent {
  return Object.assign({} as IpcMainInvokeEvent, { sender });
}

function request(url: string) {
  return { url, name: "report.pdf", type: "application/pdf" };
}

/** The microtask turns the save dialog and the listener install take. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

/** Starts `fileDownloadUrl` and lets it reach the point of waiting for the item. */
async function start(
  handlers: Map<string, InvokeHandler>,
  sender: FakeSender,
  url: string,
  savePath: string,
): Promise<{ readonly pending: Promise<unknown> }> {
  const handler = handlers.get(RunnerHostInvoke.fileDownloadUrl);
  if (handler === undefined) throw new Error("file download handler missing");
  showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: savePath });
  const pending = handler(eventFor(sender), request(url));
  await flush();
  // Wrapped: returning the promise itself would make `start` wait for it.
  return { pending: Promise.resolve(pending) };
}

/** What a promise settled with, once it has; `null` while pending. */
function watch<T>(promise: Promise<T>): { readonly outcome: () => string } {
  let outcome = "pending";
  promise.then(
    () => {
      outcome = "fulfilled";
    },
    () => {
      outcome = "rejected";
    },
  );
  return { outcome: () => outcome };
}

describe("file.downloadUrl through the registered handler", () => {
  let handlers: Map<string, InvokeHandler>;
  let sender: FakeSender;

  beforeEach(() => {
    showSaveDialog.mockReset();
    openPath.mockClear();
    handlers = installHandlers();
    sender = new FakeSender();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the claimed item its path, resolves when it completes, and lets the saved file be opened", async () => {
    const { pending } = await start(
      handlers,
      sender,
      URL_A,
      "/tmp/out/report.pdf",
    );
    expect(sender.downloadURL).toHaveBeenCalledWith(URL_A);
    expect(sender.willDownloadListeners()).toBe(1);

    const item = new FakeItem([URL_A]);
    sender.session.emit("will-download", {}, item, sender);
    expect(item.setSavePath).toHaveBeenCalledExactlyOnceWith(
      "/tmp/out/report.pdf",
    );
    expect(sender.willDownloadListeners()).toBe(0);

    item.finish("completed");
    await expect(pending).resolves.toEqual({
      name: "report.pdf",
      path: "/tmp/out/report.pdf",
    });
    const open = handlers.get(RunnerHostInvoke.fileOpenSaved);
    if (open === undefined) throw new Error("file open handler missing");
    await open(eventFor(sender), "/tmp/out/report.pdf");
    expect(openPath).toHaveBeenCalledWith("/tmp/out/report.pdf");
  });

  it("answers null for a cancelled download, and rejects an interrupted one", async () => {
    const { pending: cancelled } = await start(
      handlers,
      sender,
      URL_A,
      "/tmp/out/c.pdf",
    );
    const cancelledItem = new FakeItem([URL_A]);
    sender.session.emit("will-download", {}, cancelledItem, sender);
    cancelledItem.finish("cancelled");
    await expect(cancelled).resolves.toBeNull();

    const { pending: interrupted } = await start(
      handlers,
      sender,
      URL_A,
      "/tmp/out/i.pdf",
    );
    const interruptedItem = new FakeItem([URL_A]);
    sender.session.emit("will-download", {}, interruptedItem, sender);
    interruptedItem.finish("interrupted");
    await expect(interrupted).rejects.toThrow("interrupted");
    expect(sender.willDownloadListeners()).toBe(0);
  });

  it("never touches the session when the save dialog is dismissed", async () => {
    showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: "" });
    const handler = handlers.get(RunnerHostInvoke.fileDownloadUrl);
    if (handler === undefined) throw new Error("file download handler missing");

    await expect(handler(eventFor(sender), request(URL_A))).resolves.toBeNull();
    expect(sender.downloadURL).not.toHaveBeenCalled();
    expect(sender.willDownloadListeners()).toBe(0);
  });

  it("claims an item whose chain starts at the canonical form of the URL", async () => {
    vi.useFakeTimers();
    const url = "https://Example.COM:443/a b?x=1";
    await start(handlers, sender, url, "/tmp/out/canon.pdf");

    const item = new FakeItem([new URL(url).href]);
    sender.session.emit("will-download", {}, item, sender);

    expect(new URL(url).href).toBe("https://example.com/a%20b?x=1");
    expect(item.setSavePath).toHaveBeenCalledExactlyOnceWith(
      "/tmp/out/canon.pdf",
    );
  });

  it("leaves an item with another chain, or one from another WebContents, unclaimed", async () => {
    vi.useFakeTimers();
    await start(handlers, sender, URL_A, "/tmp/out/mine.pdf");

    const elsewhere = new FakeItem(["https://objects.test/other.pdf"]);
    sender.session.emit("will-download", {}, elsewhere, sender);
    const foreign = new FakeItem([URL_A]);
    sender.session.emit("will-download", {}, foreign, new FakeSender());

    expect(elsewhere.setSavePath).not.toHaveBeenCalled();
    expect(foreign.setSavePath).not.toHaveBeenCalled();
    expect(sender.willDownloadListeners()).toBe(1);

    const mine = new FakeItem([URL_A]);
    sender.session.emit("will-download", {}, mine, sender);
    expect(mine.setSavePath).toHaveBeenCalledExactlyOnceWith(
      "/tmp/out/mine.pdf",
    );
  });

  it("claims each of two concurrent same-URL items once, each with its own path", async () => {
    vi.useFakeTimers();
    const { pending: first } = await start(
      handlers,
      sender,
      URL_A,
      "/tmp/out/first.pdf",
    );
    const { pending: second } = await start(
      handlers,
      sender,
      URL_A,
      "/tmp/out/second.pdf",
    );
    expect(sender.willDownloadListeners()).toBe(2);

    const itemOne = new FakeItem([URL_A]);
    const itemTwo = new FakeItem([URL_A]);
    sender.session.emit("will-download", {}, itemOne, sender);
    sender.session.emit("will-download", {}, itemTwo, sender);

    expect(itemOne.setSavePath).toHaveBeenCalledExactlyOnceWith(
      "/tmp/out/first.pdf",
    );
    expect(itemTwo.setSavePath).toHaveBeenCalledExactlyOnceWith(
      "/tmp/out/second.pdf",
    );
    expect(sender.willDownloadListeners()).toBe(0);
    itemOne.finish("completed");
    itemTwo.finish("completed");
    await expect(first).resolves.toMatchObject({ path: "/tmp/out/first.pdf" });
    await expect(second).resolves.toMatchObject({
      path: "/tmp/out/second.pdf",
    });
  });

  it("settles and removes its listener when no download ever starts within 30 s", async () => {
    vi.useFakeTimers();
    const { pending } = await start(
      handlers,
      sender,
      URL_A,
      "/tmp/out/late.pdf",
    );
    const watched = watch(pending);

    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS - 1);
    expect(watched.outcome()).toBe("pending");
    expect(sender.willDownloadListeners()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(watched.outcome()).not.toBe("pending");
    expect(sender.willDownloadListeners()).toBe(0);
  });

  it("does not time a claimed download out: the 30 s is for the start only", async () => {
    vi.useFakeTimers();
    const { pending } = await start(
      handlers,
      sender,
      URL_A,
      "/tmp/out/slow.pdf",
    );
    const watched = watch(pending);
    const item = new FakeItem([URL_A]);
    sender.session.emit("will-download", {}, item, sender);

    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS * 2);
    expect(watched.outcome()).toBe("pending");
    expect(item.cancel).not.toHaveBeenCalled();

    item.finish("completed");
    await expect(pending).resolves.toMatchObject({
      path: "/tmp/out/slow.pdf",
    });
  });

  it("settles and removes its listener when the sender is destroyed before the download starts", async () => {
    vi.useFakeTimers();
    const { pending } = await start(
      handlers,
      sender,
      URL_A,
      "/tmp/out/gone.pdf",
    );
    const watched = watch(pending);

    sender.destroy();
    await flush();

    expect(watched.outcome()).not.toBe("pending");
    expect(sender.willDownloadListeners()).toBe(0);
  });

  it("settles when the sender is destroyed mid-download", async () => {
    vi.useFakeTimers();
    const { pending } = await start(
      handlers,
      sender,
      URL_A,
      "/tmp/out/mid.pdf",
    );
    const watched = watch(pending);
    const item = new FakeItem([URL_A]);
    sender.session.emit("will-download", {}, item, sender);

    sender.destroy();
    await flush();

    expect(watched.outcome()).not.toBe("pending");
  });

  it("rejects, with no listener left behind, when the session refuses to start the download", async () => {
    sender.downloadURL.mockImplementationOnce(() => {
      throw new Error("Invalid URL");
    });
    const handler = handlers.get(RunnerHostInvoke.fileDownloadUrl);
    if (handler === undefined) throw new Error("file download handler missing");
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: "/tmp/out/bad.pdf",
    });

    await expect(handler(eventFor(sender), request(URL_A))).rejects.toThrow(
      "Invalid URL",
    );
    expect(sender.willDownloadListeners()).toBe(0);
  });
});
