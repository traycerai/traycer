import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import { registerPlatformIpc } from "../platform-ipc";

const showSaveDialog = vi.hoisted(() => vi.fn());
const openPath = vi.hoisted(() => vi.fn(async () => ""));
const writeFileMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  writeFile: writeFileMock,
}));

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
  setLogLevel: vi.fn(),
}));
vi.mock("@traycer/protocol/config/log-level", () => ({
  isLogLevel: () => true,
}));

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;

/** A renderer's `webContents`, as far as the save path touches it. */
class FakeSender extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
  /** The main frame starts loading another document. */
  navigate(): void {
    this.emit(
      "did-start-navigation",
      {},
      "https://elsewhere.test/",
      false,
      true,
    );
  }
  /** The main frame changes only its hash. */
  navigateInPlace(): void {
    this.emit("did-start-navigation", {}, "https://app.test/#x", true, true);
  }
  /** A subframe navigates. */
  navigateSubframe(): void {
    this.emit("did-start-navigation", {}, "https://frame.test/", false, false);
  }
  crash(): void {
    this.emit("render-process-gone");
  }
  destroy(): void {
    this.emit("destroyed");
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

function handlerFor(
  handlers: Map<string, InvokeHandler>,
  channel: string,
): InvokeHandler {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return handler;
}

function eventFor(sender: FakeSender): IpcMainInvokeEvent {
  return Object.assign({} as IpcMainInvokeEvent, { sender });
}

const BYTES = new Uint8Array([122, 105, 112]).buffer;

interface SaveRig {
  pick(sender: FakeSender): Promise<unknown>;
  write(sender: FakeSender, id: unknown): Promise<unknown>;
  cancel(sender: FakeSender, id: unknown): Promise<unknown>;
}

function rig(): SaveRig {
  const handlers = installHandlers();
  return {
    pick: async (sender) =>
      handlerFor(handlers, RunnerHostInvoke.fileSavePick)(eventFor(sender), {
        name: "roadmap.zip",
        type: "application/zip",
      }),
    write: async (sender, id) =>
      handlerFor(handlers, RunnerHostInvoke.fileSaveWrite)(eventFor(sender), {
        id,
        bytes: BYTES,
      }),
    cancel: async (sender, id) =>
      handlerFor(handlers, RunnerHostInvoke.fileSaveCancel)(
        eventFor(sender),
        id,
      ),
  };
}

/** The sender picks a destination; returns the one-shot id. */
async function picked(save: SaveRig, sender: FakeSender): Promise<string> {
  showSaveDialog.mockResolvedValueOnce({
    canceled: false,
    filePath: "/tmp/picked/roadmap.zip",
  });
  const id = await save.pick(sender);
  if (typeof id !== "string") throw new Error("the pick returned no id");
  return id;
}

afterEach(() => {
  showSaveDialog.mockReset();
  writeFileMock.mockReset();
});

describe("a native save in two steps", () => {
  it("writes the picked bytes once, and the id is spent by the write", async () => {
    const save = rig();
    const sender = new FakeSender(1);
    const id = await picked(save, sender);

    await expect(save.write(sender, id)).resolves.toMatchObject({
      name: "roadmap.zip",
    });
    expect(writeFileMock).toHaveBeenCalledTimes(1);

    await expect(save.write(sender, id)).rejects.toThrow(/already used/);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it("a cancelled id writes nothing afterwards", async () => {
    const save = rig();
    const sender = new FakeSender(1);
    const id = await picked(save, sender);

    await save.cancel(sender, id);

    await expect(save.write(sender, id)).rejects.toThrow(/already used/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown id", async () => {
    const save = rig();
    const sender = new FakeSender(1);
    await picked(save, sender);

    await expect(save.write(sender, "not-an-id")).rejects.toThrow(
      /unknown or already used/,
    );
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("rejects a foreign sender's id and leaves the owner's target in place", async () => {
    const save = rig();
    const owner = new FakeSender(1);
    const stranger = new FakeSender(2);
    const id = await picked(save, owner);

    await expect(save.write(stranger, id)).rejects.toThrow(
      /belongs to another document/,
    );
    expect(writeFileMock).not.toHaveBeenCalled();
    await expect(save.write(owner, id)).resolves.toMatchObject({
      name: "roadmap.zip",
    });
  });
});

describe("a save across the end of the picking document", () => {
  it("rejects the write after the main frame navigated between pick and write", async () => {
    const save = rig();
    const sender = new FakeSender(1);
    const id = await picked(save, sender);
    // Observed once the pick ran; a second pick is not needed to see it.
    sender.navigate();

    await expect(save.write(sender, id)).rejects.toThrow(
      /unknown or already used/,
    );
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("hands nothing back when the document ended while the dialog was open", async () => {
    const save = rig();
    const sender = new FakeSender(1);
    let answer: (value: { canceled: boolean; filePath: string }) => void = () =>
      undefined;
    showSaveDialog.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const pending = save.pick(sender);
    await Promise.resolve();

    sender.navigate();
    answer({ canceled: false, filePath: "/tmp/picked/roadmap.zip" });

    await expect(pending).resolves.toBeNull();
  });

  it.each([
    ["the renderer process went away", (sender: FakeSender) => sender.crash()],
    [
      "the web contents was destroyed",
      (sender: FakeSender) => sender.destroy(),
    ],
  ])("rejects the write after %s", async (_name, end) => {
    const save = rig();
    const sender = new FakeSender(1);
    const id = await picked(save, sender);

    end(sender);

    await expect(save.write(sender, id)).rejects.toThrow();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("keeps the id through a hash-only change and a subframe navigation", async () => {
    const save = rig();
    const sender = new FakeSender(1);
    const id = await picked(save, sender);

    sender.navigateInPlace();
    sender.navigateSubframe();

    await expect(save.write(sender, id)).resolves.toMatchObject({
      name: "roadmap.zip",
    });
  });
});
