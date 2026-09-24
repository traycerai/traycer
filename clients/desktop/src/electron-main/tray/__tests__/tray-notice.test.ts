import { afterEach, describe, expect, it, vi } from "vitest";
import { TRAY_NOTICE_CONFIRM_TIMEOUT_MS } from "../tray";
import type { TrayManagedWindow } from "../tray";

// `showNotice`: a balloon on win32, a system Notification on linux, nothing on
// darwin. The platform is read from `node:process` at call time, so each case
// re-imports the tray module against a mocked `node:process`. Since T08
// (CLOSE-LNX-NO-TRAY), `showNotice` resolves only once the platform confirms
// the notice was actually DISPLAYED - `balloon-show` on win32, the
// notification's `show` on linux - within `TRAY_NOTICE_CONFIRM_TIMEOUT_MS`;
// a `failed` event or a silent timeout resolves `false`.

interface TrayEventHandle {
  emit(event: "balloon-show"): void;
}

interface NotificationEventHandle {
  emit(event: "show" | "failed"): void;
}

const recorded = vi.hoisted(() => ({
  balloons: [] as Array<{ title: string; content: string; iconType: string }>,
  notifications: [] as Array<{ title: string; body: string; shown: number }>,
  notificationSupported: true,
  trays: [] as TrayEventHandle[],
  notificationHandles: [] as NotificationEventHandle[],
}));

vi.mock("electron", () => {
  class MockTray {
    private readonly listeners = new Map<string, Set<() => void>>();
    constructor() {
      recorded.trays.push(this);
    }
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
    once(event: string, cb: () => void): void {
      const set = this.listeners.get(event) ?? new Set<() => void>();
      set.add(cb);
      this.listeners.set(event, set);
    }
    removeListener(event: string, cb: () => void): void {
      this.listeners.get(event)?.delete(cb);
    }
    emit(event: string): void {
      for (const cb of this.listeners.get(event) ?? []) cb();
    }
  }
  class MockNotification {
    private readonly entry: { title: string; body: string; shown: number };
    private readonly listeners = new Map<string, Set<() => void>>();
    constructor(options: { title: string; body: string }) {
      this.entry = { title: options.title, body: options.body, shown: 0 };
      recorded.notifications.push(this.entry);
      recorded.notificationHandles.push(this);
    }
    static isSupported(): boolean {
      return recorded.notificationSupported;
    }
    show(): void {
      this.entry.shown += 1;
    }
    once(event: string, cb: () => void): void {
      const set = this.listeners.get(event) ?? new Set<() => void>();
      set.add(cb);
      this.listeners.set(event, set);
    }
    removeAllListeners(event: string): void {
      this.listeners.delete(event);
    }
    emit(event: string): void {
      for (const cb of this.listeners.get(event) ?? []) cb();
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
  showNotice(notice: { title: string; content: string }): Promise<boolean>;
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
  const controller = new mod.DesktopTrayController(window, image, {
    onEpicSelected: null,
    onCommand: null,
  });
  return { showNotice: (notice) => controller.showNotice(notice) };
}

afterEach(() => {
  vi.doUnmock("node:process");
  vi.useRealTimers();
  recorded.balloons.length = 0;
  recorded.notifications.length = 0;
  recorded.notificationSupported = true;
  recorded.trays.length = 0;
  recorded.notificationHandles.length = 0;
});

describe("DesktopTrayController.showNotice", () => {
  it("win32: resolves true once the tray confirms balloon-show", async () => {
    const tray = await trayOn("win32");
    const promise = tray.showNotice(NOTICE);
    expect(recorded.balloons).toEqual([
      { title: NOTICE.title, content: NOTICE.content, iconType: "info" },
    ]);
    expect(recorded.notifications).toEqual([]);
    recorded.trays[0].emit("balloon-show");
    await expect(promise).resolves.toBe(true);
  });

  it("win32: resolves false when balloon-show never fires within the timeout", async () => {
    vi.useFakeTimers();
    const tray = await trayOn("win32");
    const promise = tray.showNotice(NOTICE);
    await vi.advanceTimersByTimeAsync(TRAY_NOTICE_CONFIRM_TIMEOUT_MS);
    await expect(promise).resolves.toBe(false);
  });

  it("linux: resolves true on the notification's show", async () => {
    const tray = await trayOn("linux");
    const promise = tray.showNotice(NOTICE);
    expect(recorded.notifications).toEqual([
      { title: NOTICE.title, body: NOTICE.content, shown: 1 },
    ]);
    expect(recorded.balloons).toEqual([]);
    recorded.notificationHandles[0].emit("show");
    await expect(promise).resolves.toBe(true);
  });

  it("linux: resolves false on the notification's failed", async () => {
    const tray = await trayOn("linux");
    const promise = tray.showNotice(NOTICE);
    recorded.notificationHandles[0].emit("failed");
    await expect(promise).resolves.toBe(false);
  });

  it("linux: resolves false when neither show nor failed fires within the timeout", async () => {
    vi.useFakeTimers();
    const tray = await trayOn("linux");
    const promise = tray.showNotice(NOTICE);
    await vi.advanceTimersByTimeAsync(TRAY_NOTICE_CONFIRM_TIMEOUT_MS);
    await expect(promise).resolves.toBe(false);
  });

  it("linux without notification support: resolves false, no Notification constructed", async () => {
    recorded.notificationSupported = false;
    const tray = await trayOn("linux");
    await expect(tray.showNotice(NOTICE)).resolves.toBe(false);
    expect(recorded.notifications).toEqual([]);
    expect(recorded.balloons).toEqual([]);
  });

  it("darwin: resolves false, nothing constructed", async () => {
    const tray = await trayOn("darwin");
    await expect(tray.showNotice(NOTICE)).resolves.toBe(false);
    expect(recorded.notifications).toEqual([]);
    expect(recorded.balloons).toEqual([]);
  });
});
