/**
 * The voice item end to end in main, short of a real menu bar: a window's
 * focus events and its renderer's live flag and indicator go into the real
 * `VoiceLiveWindows`, the real `VoiceTrayItems` reconciles items from it,
 * and the real Electron view builds them over a recorded `Tray` and `Menu`.
 * The renderer side of an action is played by the test: End there ends the
 * session, which clears the live flag as the renderer does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceTrayAction } from "../../../ipc-contracts/host-types";
import { createElectronVoiceTrayView, VoiceTrayItems } from "../voice-tray-items";
import {
  installVoiceAwayTracking,
  VoiceLiveWindows,
  type VoiceAwayTarget,
} from "../../windows/voice-live-windows";

interface MenuItemLike {
  readonly label?: string;
  readonly type?: string;
  readonly enabled?: boolean;
  readonly click?: () => void;
}

interface RecordedTray {
  title: string | null;
  toolTip: string | null;
  menu: ReadonlyArray<MenuItemLike>;
  destroyed: boolean;
  readonly handlers: Map<string, () => void>;
}

const electron = vi.hoisted(() => ({ trays: [] as RecordedTray[] }));

vi.mock("electron", () => {
  class Tray {
    private readonly record: RecordedTray = {
      title: null,
      toolTip: null,
      menu: [],
      destroyed: false,
      handlers: new Map(),
    };
    constructor(_image: unknown) {
      electron.trays.push(this.record);
    }
    on(event: string, handler: () => void): void {
      this.record.handlers.set(event, handler);
    }
    setTitle(title: string): void {
      this.record.title = title;
    }
    setToolTip(text: string): void {
      this.record.toolTip = text;
    }
    setContextMenu(menu: { readonly template: MenuItemLike[] }): void {
      this.record.menu = menu.template;
    }
    isDestroyed(): boolean {
      return this.record.destroyed;
    }
    destroy(): void {
      this.record.destroyed = true;
    }
  }
  return {
    Tray,
    Menu: {
      buildFromTemplate: (template: MenuItemLike[]) => ({ template }),
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


/** A window whose focus the test moves by hand. */
class FakeWindow implements VoiceAwayTarget {
  private readonly listeners = new Map<string, Array<() => void>>();

  on(event: "focus" | "blur" | "hide", listener: () => void): void {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
  }

  emit(event: "focus" | "blur" | "hide"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

interface Harness {
  readonly windows: VoiceLiveWindows;
  readonly window: FakeWindow;
  readonly items: VoiceTrayItems;
  readonly sent: Array<{ windowId: string; action: VoiceTrayAction }>;
  readonly returned: string[];
}

function harness(input: {
  readonly platform: NodeJS.Platform;
  readonly trayVisible: boolean;
}): Harness {
  const windows = new VoiceLiveWindows();
  const window = new FakeWindow();
  installVoiceAwayTracking(window, "w1", windows);
  const sent: Array<{ windowId: string; action: VoiceTrayAction }> = [];
  const returned: string[] = [];
  const items = new VoiceTrayItems({
    source: windows,
    trayVisible: () => Promise.resolve(input.trayVisible),
    createView: (indicator, actions) =>
      Promise.resolve(
        createElectronVoiceTrayView({
          image: {} as Electron.NativeImage,
          platform: input.platform,
          indicator,
          actions,
        }),
      ),
    sendAction: (windowId, action) => {
      sent.push({ windowId, action });
      // The renderer that owns the session ends it, and says so.
      if (action.kind === "end") windows.set(windowId, false);
    },
    returnTo: (windowId) => {
      returned.push(windowId);
    },
  });
  return { windows, window, items, sent, returned };
}

/** Lets the item's tray check and build settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function liveTrays(): RecordedTray[] {
  return electron.trays.filter((tray) => !tray.destroyed);
}

function menuItem(tray: RecordedTray, label: string): MenuItemLike {
  const item = tray.menu.find((entry) => entry.label === label);
  if (item === undefined) throw new Error(`no "${label}" in the voice menu`);
  return item;
}

beforeEach(() => {
  electron.trays.length = 0;
});

describe("the voice item", () => {
  it("appears on blur while the session is live, shows its state, and its three actions reach the session", async () => {
    const { windows, window, sent, returned } = harness({
      platform: "darwin",
      trayVisible: true,
    });
    window.emit("focus");
    windows.set("w1", true);
    await settle();
    // Live in the window the person is looking at: nothing in the menu bar.
    expect(liveTrays()).toHaveLength(0);

    window.emit("blur");
    await settle();
    const [tray] = liveTrays();
    expect(liveTrays()).toHaveLength(1);
    expect(tray.title).toBe("Listening");
    expect(tray.menu.map((entry) => entry.label ?? entry.type)).toEqual([
      "Listening",
      "separator",
      "Mute",
      "End",
      "separator",
      "Return to Traycer",
    ]);
    expect(menuItem(tray, "Listening").enabled).toBe(false);

    menuItem(tray, "Mute").click?.();
    expect(sent).toEqual([
      { windowId: "w1", action: { kind: "setMuted", muted: true } },
    ]);
    // The renderer mutes and reports it: the item follows.
    windows.setIndicator("w1", { muted: true, pausedForDictation: false });
    expect(tray.title).toBe("Muted");
    menuItem(tray, "Unmute").click?.();
    expect(sent.at(-1)).toEqual({
      windowId: "w1",
      action: { kind: "setMuted", muted: false },
    });

    menuItem(tray, "Return to Traycer").click?.();
    expect(returned).toEqual(["w1"]);
    // Back in the window, the item stays until the session ends.
    window.emit("focus");
    expect(liveTrays()).toHaveLength(1);

    menuItem(tray, "End").click?.();
    expect(sent.at(-1)).toEqual({ windowId: "w1", action: { kind: "end" } });
    expect(liveTrays()).toHaveLength(0);
  });

  it("appears when a closed window is hidden, and goes when the session ends however it ends", async () => {
    const { windows, window } = harness({
      platform: "win32",
      trayVisible: true,
    });
    windows.set("w1", true);
    window.emit("hide");
    await settle();
    const [tray] = liveTrays();
    expect(tray.toolTip).toBe("Traycer voice: Listening");
    expect(tray.title).toBeNull();

    windows.setIndicator("w1", { muted: false, pausedForDictation: true });
    expect(tray.toolTip).toBe("Traycer voice: Paused for dictation");

    // Lock, sleep or the renderer's own end: the live flag goes.
    windows.set("w1", false);
    expect(liveTrays()).toHaveLength(0);
  });

  it("returns to Traycer on a click off macOS", async () => {
    const { windows, window, returned } = harness({
      platform: "win32",
      trayVisible: true,
    });
    windows.set("w1", true);
    window.emit("blur");
    await settle();
    liveTrays()[0]?.handlers.get("click")?.();
    expect(returned).toEqual(["w1"]);
  });

  it("is away from the start for a session that goes live in a background window", async () => {
    const { windows, window } = harness({
      platform: "darwin",
      trayVisible: true,
    });
    window.emit("blur");
    windows.set("w1", true);
    await settle();
    expect(liveTrays()).toHaveLength(1);
  });

  it("shows nothing on Linux with no tray to show it in", async () => {
    const { windows, window } = harness({
      platform: "linux",
      trayVisible: false,
    });
    windows.set("w1", true);
    window.emit("blur");
    await settle();
    expect(electron.trays).toHaveLength(0);
  });

  it("is never left behind by a session that ends while it is being built, or by quit", async () => {
    const ended = harness({ platform: "darwin", trayVisible: true });
    ended.windows.set("w1", true);
    ended.window.emit("blur");
    ended.windows.set("w1", false);
    await settle();
    expect(liveTrays()).toHaveLength(0);

    const quitting = harness({ platform: "darwin", trayVisible: true });
    quitting.windows.set("w1", true);
    quitting.window.emit("blur");
    await settle();
    expect(liveTrays()).toHaveLength(1);
    quitting.items.dispose();
    expect(liveTrays()).toHaveLength(0);
  });
});
