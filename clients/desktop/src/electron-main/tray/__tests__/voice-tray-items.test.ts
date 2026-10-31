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
import {
  createElectronVoiceTrayView,
  VoiceTrayItems,
  type VoiceTrayItemView,
} from "../voice-tray-items";
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A view the item asked for, which the test lets finish building. */
interface PendingView {
  readonly promise: Promise<VoiceTrayItemView>;
  readonly finish: () => void;
}

interface Harness {
  readonly windows: VoiceLiveWindows;
  readonly window: FakeWindow;
  readonly items: VoiceTrayItems;
  /** Each tray check the item made, unanswered until the test answers it. */
  readonly probes: Array<Deferred<boolean>>;
  /** Each view the item asked to build, unbuilt until the test finishes it. */
  readonly views: PendingView[];
  readonly sent: Array<{ windowId: string; action: VoiceTrayAction }>;
  readonly returned: string[];
}

function harness(platform: NodeJS.Platform): Harness {
  const windows = new VoiceLiveWindows();
  const window = new FakeWindow();
  installVoiceAwayTracking(window, "w1", windows);
  const probes: Array<Deferred<boolean>> = [];
  const views: PendingView[] = [];
  const sent: Array<{ windowId: string; action: VoiceTrayAction }> = [];
  const returned: string[] = [];
  const items = new VoiceTrayItems({
    source: windows,
    trayVisible: () => {
      const probe = deferred<boolean>();
      probes.push(probe);
      return probe.promise;
    },
    createView: (indicator, actions) => {
      const view = deferred<VoiceTrayItemView>();
      views.push({
        promise: view.promise,
        finish: () =>
          view.resolve(
            createElectronVoiceTrayView({
              image: {} as Electron.NativeImage,
              platform,
              indicator,
              actions,
            }),
          ),
      });
      return view.promise;
    },
    sendAction: (windowId, action) => {
      sent.push({ windowId, action });
      // The renderer that owns the session ends it, and says so.
      if (action.kind === "end") windows.set(windowId, false);
    },
    returnTo: (windowId) => {
      returned.push(windowId);
    },
  });
  return { windows, window, items, probes, views, sent, returned };
}

/**
 * Answers the item's oldest tray check. The item awaits that same promise
 * and was waiting first, so it has acted on the answer when this returns.
 */
async function answerTrayCheck(h: Harness, visible: boolean): Promise<void> {
  const probe = h.probes.shift();
  if (probe === undefined) throw new Error("the item asked for no tray check");
  probe.resolve(visible);
  await probe.promise;
}

/** Finishes the oldest view the item asked for; as above, the item has taken it on return. */
async function finishView(h: Harness): Promise<void> {
  const view = h.views.shift();
  if (view === undefined) throw new Error("the item asked for no view");
  view.finish();
  await view.promise;
}

/** A tray exists, and the item is built. */
async function showItem(h: Harness): Promise<void> {
  await answerTrayCheck(h, true);
  await finishView(h);
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
    const h = harness("darwin");
    h.window.emit("focus");
    h.windows.set("w1", true);
    // Live in the window the person is looking at: no item is asked for.
    expect(h.probes).toHaveLength(0);

    h.window.emit("blur");
    await showItem(h);
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
    expect(h.sent).toEqual([
      { windowId: "w1", action: { kind: "setMuted", muted: true } },
    ]);
    // The renderer mutes and reports it: the item follows.
    h.windows.setIndicator("w1", { muted: true, pausedForDictation: false });
    expect(tray.title).toBe("Muted");
    menuItem(tray, "Unmute").click?.();
    expect(h.sent.at(-1)).toEqual({
      windowId: "w1",
      action: { kind: "setMuted", muted: false },
    });

    menuItem(tray, "Return to Traycer").click?.();
    expect(h.returned).toEqual(["w1"]);
    // Back in the window, the item stays until the session ends.
    h.window.emit("focus");
    expect(liveTrays()).toHaveLength(1);

    menuItem(tray, "End").click?.();
    expect(h.sent.at(-1)).toEqual({ windowId: "w1", action: { kind: "end" } });
    expect(liveTrays()).toHaveLength(0);
  });

  it("appears when a closed window is hidden, follows the state while it is built, and goes when the session ends however it ends", async () => {
    const h = harness("win32");
    h.windows.set("w1", true);
    h.window.emit("hide");
    await answerTrayCheck(h, true);
    // The state moves while the item is being built: it is built showing it.
    h.windows.setIndicator("w1", { muted: false, pausedForDictation: true });
    await finishView(h);
    const [tray] = liveTrays();
    expect(tray.toolTip).toBe("Traycer voice: Paused for dictation");
    expect(tray.title).toBeNull();

    // Lock, sleep or the renderer's own end: the live flag goes.
    h.windows.set("w1", false);
    expect(liveTrays()).toHaveLength(0);
  });

  it("returns to Traycer on a click off macOS", async () => {
    const h = harness("win32");
    h.windows.set("w1", true);
    h.window.emit("blur");
    await showItem(h);
    liveTrays()[0]?.handlers.get("click")?.();
    expect(h.returned).toEqual(["w1"]);
  });

  it("is away from the start for a session that goes live in a background window", async () => {
    const h = harness("darwin");
    h.window.emit("blur");
    h.windows.set("w1", true);
    await showItem(h);
    expect(liveTrays()).toHaveLength(1);
  });

  it("shows nothing on Linux with no tray to show it in", async () => {
    const h = harness("linux");
    h.windows.set("w1", true);
    h.window.emit("blur");
    await answerTrayCheck(h, false);
    expect(h.views).toHaveLength(0);
    expect(electron.trays).toHaveLength(0);
  });

  it("is never left behind by a session that ends during the tray check, while the item is built, or by quit", async () => {
    const duringCheck = harness("darwin");
    duringCheck.windows.set("w1", true);
    duringCheck.window.emit("blur");
    duringCheck.windows.set("w1", false);
    await answerTrayCheck(duringCheck, true);
    expect(duringCheck.views).toHaveLength(0);

    const duringBuild = harness("darwin");
    duringBuild.windows.set("w1", true);
    duringBuild.window.emit("blur");
    await answerTrayCheck(duringBuild, true);
    expect(duringBuild.views).toHaveLength(1);
    duringBuild.windows.set("w1", false);
    await finishView(duringBuild);
    expect(electron.trays).toHaveLength(1);
    expect(liveTrays()).toHaveLength(0);

    const quitting = harness("darwin");
    quitting.windows.set("w1", true);
    quitting.window.emit("blur");
    await showItem(quitting);
    expect(liveTrays()).toHaveLength(1);
    quitting.items.dispose();
    expect(liveTrays()).toHaveLength(0);
  });
});
