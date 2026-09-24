import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrayManagedWindow } from "../tray";

// `showNotice`: a balloon on win32, a system Notification on linux, nothing on
// darwin. The platform is read from `node:process` at call time, so each case
// re-imports the tray module against a mocked `node:process`.

const recorded = vi.hoisted(() => ({
  balloons: [] as Array<{ title: string; content: string; iconType: string }>,
  notifications: [] as Array<{ title: string; body: string; shown: number }>,
  notificationSupported: true,
}));

vi.mock("electron", () => {
  class MockTray {
    setToolTip(): void {}
    on(): void {}
    setContextMenu(): void {}
    destroy(): void {}
    displayBalloon(options: {
      title: string;
      content: string;
      iconType: string;
    }): void {
      recorded.balloons.push(options);
    }
  }
  class MockNotification {
    private readonly entry: { title: string; body: string; shown: number };
    constructor(options: { title: string; body: string }) {
      this.entry = { title: options.title, body: options.body, shown: 0 };
      recorded.notifications.push(this.entry);
    }
    static isSupported(): boolean {
      return recorded.notificationSupported;
    }
    show(): void {
      this.entry.shown += 1;
    }
  }
  return {
    app: {
      getAppPath: (): string => "/unused",
      getPath: (): string => "/tmp",
      quit: vi.fn(),
    },
    BrowserWindow: class {},
    Menu: { buildFromTemplate: (template: unknown): unknown => ({ template }) },
    Tray: MockTray,
    Notification: MockNotification,
    nativeImage: {
      createFromPath: (): unknown => ({}),
      createEmpty: (): unknown => ({}),
    },
  };
});

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../../config", async (importActual) => {
  const actual = await importActual<typeof import("../../../config")>();
  return { ...actual, isDevBuild: false };
});

const NOTICE = { title: "Traycer is still running", content: "In the tray." };

async function trayOn(platform: NodeJS.Platform): Promise<{
  showNotice(notice: { title: string; content: string }): void;
}> {
  vi.resetModules();
  vi.doMock("node:process", () => ({ platform, default: { platform } }));
  const mod = await import("../tray");
  const window: TrayManagedWindow = {
    isDestroyed: () => false,
    isVisible: () => false,
    show: () => undefined,
    focus: () => undefined,
  };
  // The mocked `Tray` accepts anything; the image is never read.
  const image = (await import("electron")).nativeImage.createEmpty();
  return new mod.DesktopTrayController(window, image, {
    onEpicSelected: null,
    onCommand: null,
  });
}

afterEach(() => {
  vi.doUnmock("node:process");
  recorded.balloons.length = 0;
  recorded.notifications.length = 0;
  recorded.notificationSupported = true;
});

describe("DesktopTrayController.showNotice", () => {
  it("win32: a tray balloon, and no Notification", async () => {
    const tray = await trayOn("win32");
    tray.showNotice(NOTICE);
    expect(recorded.balloons).toEqual([
      { title: NOTICE.title, content: NOTICE.content, iconType: "info" },
    ]);
    expect(recorded.notifications).toEqual([]);
  });

  it("linux: one shown system Notification, and no balloon", async () => {
    const tray = await trayOn("linux");
    tray.showNotice(NOTICE);
    expect(recorded.notifications).toEqual([
      { title: NOTICE.title, body: NOTICE.content, shown: 1 },
    ]);
    expect(recorded.balloons).toEqual([]);
  });

  it("linux without notification support: nothing", async () => {
    recorded.notificationSupported = false;
    const tray = await trayOn("linux");
    tray.showNotice(NOTICE);
    expect(recorded.notifications).toEqual([]);
    expect(recorded.balloons).toEqual([]);
  });

  it("darwin: nothing", async () => {
    const tray = await trayOn("darwin");
    tray.showNotice(NOTICE);
    expect(recorded.notifications).toEqual([]);
    expect(recorded.balloons).toEqual([]);
  });
});
