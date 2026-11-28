import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostLifecycleMode } from "@traycer/protocol/config/host-lifecycle-policy";
import {
  appIconBadgeWindows,
  installAppIconBadgeTracking,
} from "../app-icon-badge-windows";
import {
  CloseToTray,
  HiddenToTrayWindows,
  registryCloseToTrayWindows,
} from "../close-to-tray";
import type { WindowRegistry } from "../window-registry";
import { registryRig, type RegistryFakeWindow } from "./registry-fake-window";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const installed: string[] = [];

function trackedRegistry(): {
  readonly registry: WindowRegistry<RegistryFakeWindow>;
  open(): Promise<{ readonly id: string; readonly window: RegistryFakeWindow }>;
} {
  const { registry } = registryRig([]);
  return {
    registry,
    open: async () => {
      const id = await registry.create({
        initialRoute: null,
        beforeLoad: null,
      });
      const window = registry.getWindowById(id);
      if (window === null) throw new Error("registered window is missing");
      installAppIconBadgeTracking(window, id, appIconBadgeWindows);
      installed.push(id);
      return { id, window };
    },
  };
}

function shownCount(): number {
  return appIconBadgeWindows.snapshot().count;
}

afterEach(() => {
  for (const id of installed) appIconBadgeWindows.forget(id);
  installed.length = 0;
});

describe("app icon badge windows", () => {
  it("follows the focused visible window's published count", async () => {
    const rig = trackedRegistry();
    const first = await rig.open();
    const second = await rig.open();
    appIconBadgeWindows.setCount(first.id, 3);
    appIconBadgeWindows.setCount(second.id, 5);
    expect(shownCount()).toBe(0);

    first.window.focus();
    expect(shownCount()).toBe(3);
    second.window.focus();
    expect(shownCount()).toBe(5);
    first.window.focus();
    expect(shownCount()).toBe(3);
  });

  it("drops a window the app hides to the tray and restores it when that window is shown", async () => {
    const rig = trackedRegistry();
    const first = await rig.open();
    const second = await rig.open();
    appIconBadgeWindows.setCount(first.id, 3);
    appIconBadgeWindows.setCount(second.id, 5);
    second.window.focus();
    first.window.focus();
    expect(shownCount()).toBe(3);

    // Electron's own hide (occlusion, another Space) is not the app hiding it.
    first.window.hide();
    expect(shownCount()).toBe(3);

    const hiddenToTray = new HiddenToTrayWindows();
    const windows = registryCloseToTrayWindows(rig.registry, hiddenToTray);
    windows.hide(first.id);
    expect(shownCount()).toBe(5);
    windows.hide(second.id);
    expect(shownCount()).toBe(0);

    first.window.show();
    expect(shownCount()).toBe(3);
  });

  it("does not count a window CloseToTray hid because a voice session is live", async () => {
    const rig = trackedRegistry();
    const staying = await rig.open();
    const voice = await rig.open();
    appIconBadgeWindows.setCount(staying.id, 3);
    appIconBadgeWindows.setCount(voice.id, 5);
    staying.window.focus();
    voice.window.focus();
    expect(shownCount()).toBe(5);

    const closer = new CloseToTray({
      platform: "darwin",
      hasTray: () => Promise.resolve(false),
      isQuitting: () => false,
      readQuitMode: (): Promise<HostLifecycleMode> =>
        Promise.resolve("background"),
      windows: registryCloseToTrayWindows(
        rig.registry,
        new HiddenToTrayWindows(),
      ),
      requestQuit: () => undefined,
      showNoticeOnce: () => undefined,
      voiceLive: (windowId) => windowId === voice.id,
    });
    const event = { preventDefault: (): void => undefined };
    expect(closer.interceptClose(voice.id, event)).toBe(true);
    expect(shownCount()).toBe(3);

    appIconBadgeWindows.setCount(voice.id, 9);
    expect(shownCount()).toBe(3);
  });

  it("drops a closed window, and a replaced renderer until it publishes again", async () => {
    const rig = trackedRegistry();
    const staying = await rig.open();
    const closing = await rig.open();
    appIconBadgeWindows.setCount(staying.id, 3);
    appIconBadgeWindows.setCount(closing.id, 5);
    staying.window.focus();
    closing.window.focus();
    expect(shownCount()).toBe(5);

    closing.window.close();
    expect(shownCount()).toBe(3);
    appIconBadgeWindows.setCount(closing.id, 9);
    expect(shownCount()).toBe(3);

    staying.window.commitNavigation();
    expect(shownCount()).toBe(0);
    appIconBadgeWindows.setCount(staying.id, 3);
    expect(shownCount()).toBe(3);

    staying.window.failLoad(true);
    expect(shownCount()).toBe(0);
    appIconBadgeWindows.setCount(staying.id, 3);
    expect(shownCount()).toBe(3);

    staying.window.rendererGone();
    expect(shownCount()).toBe(0);
    appIconBadgeWindows.setCount(staying.id, 3);
    expect(shownCount()).toBe(3);

    staying.window.failLoad(false);
    expect(shownCount()).toBe(3);
  });
});
