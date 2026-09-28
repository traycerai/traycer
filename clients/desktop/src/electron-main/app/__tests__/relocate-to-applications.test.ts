import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

type RelocateModule = typeof import("../relocate-to-applications");

interface FakeApp {
  isPackaged: boolean;
  isInApplicationsFolder: Mock;
  moveToApplicationsFolder: Mock;
  getPath: Mock;
}

interface FakeDialog {
  showMessageBox: Mock;
  showMessageBoxSync: Mock;
}

interface FakeFs {
  existsSync: Mock;
  writeFileSync: Mock;
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);
const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "resourcesPath",
);

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { configurable: true, value });
}

afterEach(() => {
  if (originalPlatformDescriptor !== undefined) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  if (originalResourcesPathDescriptor === undefined) {
    Reflect.deleteProperty(process, "resourcesPath");
  } else {
    Object.defineProperty(
      process,
      "resourcesPath",
      originalResourcesPathDescriptor,
    );
  }
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("electron");
  vi.doUnmock("node:fs");
  vi.doUnmock("../logger");
});

describe("maybePromptRelocateToApplications", () => {
  it("moves the app when the user accepts on macOS", async () => {
    const { app, dialog, relocate } = await loadRelocate({
      platform: "darwin",
      isPackaged: true,
      isInApplicationsFolder: false,
      messageBoxResponse: 0,
      moveResult: true,
    });

    await relocate.maybePromptRelocateToApplications();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(app.moveToApplicationsFolder).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the app is already in Applications", async () => {
    const { app, dialog, relocate } = await loadRelocate({
      platform: "darwin",
      isPackaged: true,
      isInApplicationsFolder: true,
      messageBoxResponse: 0,
    });

    await relocate.maybePromptRelocateToApplications();

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(app.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it("skips on non-macOS platforms", async () => {
    const { app, relocate } = await loadRelocate({
      platform: "win32",
      isPackaged: true,
      isInApplicationsFolder: false,
      messageBoxResponse: 0,
    });

    await relocate.maybePromptRelocateToApplications();
    expect(app.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it("skips for unpackaged (dev) builds", async () => {
    const { app, relocate } = await loadRelocate({
      platform: "darwin",
      isPackaged: false,
      isInApplicationsFolder: false,
      messageBoxResponse: 0,
    });

    await relocate.maybePromptRelocateToApplications();
    expect(app.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it("skips when the build has no update feed", async () => {
    const { dialog, relocate } = await loadRelocate({
      platform: "darwin",
      isPackaged: true,
      isInApplicationsFolder: false,
      messageBoxResponse: 0,
      hasFeed: false,
    });

    await relocate.maybePromptRelocateToApplications();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("persists the decline so it only asks once", async () => {
    const { app, fs, relocate } = await loadRelocate({
      platform: "darwin",
      isPackaged: true,
      isInApplicationsFolder: false,
      messageBoxResponse: 1,
    });

    await relocate.maybePromptRelocateToApplications();

    expect(app.moveToApplicationsFolder).not.toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("does not prompt again once the user has declined", async () => {
    const { dialog, relocate } = await loadRelocate({
      platform: "darwin",
      isPackaged: true,
      isInApplicationsFolder: false,
      messageBoxResponse: 0,
      declined: true,
    });

    await relocate.maybePromptRelocateToApplications();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("does not throw when the move fails", async () => {
    const { relocate } = await loadRelocate({
      platform: "darwin",
      isPackaged: true,
      isInApplicationsFolder: false,
      messageBoxResponse: 0,
      moveThrows: true,
    });

    await expect(
      relocate.maybePromptRelocateToApplications(),
    ).resolves.toBeUndefined();
  });

  it("reports the location as blocked only on a packaged macOS feed build outside Applications", async () => {
    const { relocate } = await loadRelocate({
      platform: "darwin",
      isPackaged: true,
      isInApplicationsFolder: false,
      messageBoxResponse: 0,
    });
    expect(relocate.isUpdateBlockedByLocation()).toBe(true);
  });
});

// A macOS move-to-Applications relaunch is not a user quit. Electron
// 42.11.6's `moveToApplicationsFolder` (electron_bundle_mover.mm:426-440)
// relaunches, then calls `Browser::Quit()`, which synchronously emits
// `before-quit` - all BEFORE `moveToApplicationsFolder` itself returns. A
// listener on `before-quit` (`wireAppLifecycle`'s quit transaction) must be
// able to tell this apart from an ordinary user quit, so main needs a flag
// it can read while that call is still running. Not on head at all -
// `relocate-to-applications.ts` exports no such thing.
describe("isRelocationRelaunchPending is true only while the native relaunch is in flight", () => {
  it("reads true during moveToApplicationsFolder's synchronous before-quit", async () => {
    const observed: boolean[] = [];
    const { relocate } = await loadRelocateWithMoveStub({
      moveResult: true,
      moveThrows: false,
      onMove: (relocateModule) => {
        observed.push(relocateModule.isRelocationRelaunchPending());
      },
    });

    await relocate.maybePromptRelocateToApplications();

    expect(observed).toEqual([true]);
  });

  it("reads false again after a move that returns false", async () => {
    const { relocate } = await loadRelocateWithMoveStub({
      moveResult: false,
      moveThrows: false,
      onMove: () => undefined,
    });

    await relocate.maybePromptRelocateToApplications();

    expect(relocate.isRelocationRelaunchPending()).toBe(false);
  });

  it("reads false again after a move that throws", async () => {
    const { relocate } = await loadRelocateWithMoveStub({
      moveResult: false,
      moveThrows: true,
      onMove: () => undefined,
    });

    await relocate.maybePromptRelocateToApplications();

    expect(relocate.isRelocationRelaunchPending()).toBe(false);
  });
});

async function loadRelocateWithMoveStub(opts: {
  readonly moveResult: boolean;
  readonly moveThrows: boolean;
  readonly onMove: (relocateModule: RelocateModule) => void;
}): Promise<{ readonly relocate: RelocateModule }> {
  vi.resetModules();
  setPlatform("darwin");
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: "/tmp/traycer-test-resources",
  });
  let relocateModuleRef: RelocateModule | null = null;
  const app: FakeApp = {
    isPackaged: true,
    isInApplicationsFolder: vi.fn(() => false),
    moveToApplicationsFolder: vi.fn(() => {
      if (relocateModuleRef !== null) opts.onMove(relocateModuleRef);
      if (opts.moveThrows) {
        throw new Error("permission denied");
      }
      return opts.moveResult;
    }),
    getPath: vi.fn(() => "/tmp/traycer-test-userdata"),
  };
  const dialog: FakeDialog = {
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
    showMessageBoxSync: vi.fn(() => 0),
  };
  const fs: FakeFs = {
    existsSync: vi.fn((path: string) => path.endsWith("app-update.yml")),
    writeFileSync: vi.fn(),
  };
  vi.doMock("electron", () => ({ app, dialog }));
  vi.doMock("node:fs", () => ({ ...fs, default: fs }));
  vi.doMock("../logger", () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  const relocate = await import("../relocate-to-applications");
  relocateModuleRef = relocate;
  return { relocate };
}

async function loadRelocate(opts: {
  readonly platform: string;
  readonly isPackaged: boolean;
  readonly isInApplicationsFolder: boolean;
  readonly messageBoxResponse: number;
  readonly moveResult?: boolean;
  readonly moveThrows?: boolean;
  readonly declined?: boolean;
  readonly hasFeed?: boolean;
}): Promise<{
  readonly app: FakeApp;
  readonly dialog: FakeDialog;
  readonly fs: FakeFs;
  readonly relocate: RelocateModule;
}> {
  vi.resetModules();
  setPlatform(opts.platform);
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: "/tmp/traycer-test-resources",
  });
  const app: FakeApp = {
    isPackaged: opts.isPackaged,
    isInApplicationsFolder: vi.fn(() => opts.isInApplicationsFolder),
    moveToApplicationsFolder: vi.fn(() => {
      if (opts.moveThrows === true) {
        throw new Error("permission denied");
      }
      return opts.moveResult ?? false;
    }),
    getPath: vi.fn(() => "/tmp/traycer-test-userdata"),
  };
  const dialog: FakeDialog = {
    showMessageBox: vi.fn(() =>
      Promise.resolve({ response: opts.messageBoxResponse }),
    ),
    showMessageBoxSync: vi.fn(() => 0),
  };
  const fs: FakeFs = {
    existsSync: vi.fn((path: string) => {
      if (path.endsWith("app-update.yml")) {
        return opts.hasFeed !== false;
      }
      if (path.endsWith("relocation-declined")) {
        return opts.declined === true;
      }
      return false;
    }),
    writeFileSync: vi.fn(),
  };
  vi.doMock("electron", () => ({ app, dialog }));
  vi.doMock("node:fs", () => ({ ...fs, default: fs }));
  vi.doMock("../logger", () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  return {
    app,
    dialog,
    fs,
    relocate: await import("../relocate-to-applications"),
  };
}
