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
