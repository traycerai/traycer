import { describe, expect, it, vi } from "vitest";
import type { HostLifecycleMode } from "@traycer/protocol/config/host-lifecycle-policy";
import type { JsonFileStore } from "../../app/json-file-store";
import type { HostLifecycleView } from "../../../ipc-contracts/host-lifecycle-types";
import { log } from "../../app/logger";
import { ensureReachableAfterStayOpen } from "../../startup/quit-stay-open";
import { QuitTransactions } from "../../startup/quit-transaction";
import {
  CloseToTray,
  createCloseToTrayNoticeOnce,
  lastWindowCloseAction,
  registryCloseToTrayWindows,
  parseCloseToTrayNoticeState,
  type CloseToTrayNoticeState,
  type CloseToTrayWindows,
} from "../close-to-tray";
import { registryRig, type RegistryRig } from "./registry-fake-window";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  describeLogError: (cause: unknown) => String(cause),
}));

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("lastWindowCloseAction", () => {
  const cases: ReadonlyArray<
    readonly [HostLifecycleMode, boolean, number, string]
  > = [
    ["linked", true, 0, "hide-to-tray"],
    ["ask", true, 0, "hide-to-tray"],
    ["stop-if-idle", true, 3, "hide-to-tray"],
    ["linked", false, 0, "quit-with-window"],
    ["ask", false, 0, "quit-with-window"],
    ["stop-if-idle", false, 2, "quit-with-window"],
    ["background", true, 0, "close"],
    ["none", false, 0, "close"],
    ["background", true, 1, "quit-with-window"],
    ["none", true, 4, "quit-with-window"],
  ];
  for (const [mode, hasTray, hidden, expected] of cases) {
    it(`${mode} / tray=${String(hasTray)} / hidden others=${String(hidden)} -> ${expected}`, () => {
      expect(
        lastWindowCloseAction({
          mode,
          hasTray,
          otherHiddenWindowCount: hidden,
        }),
      ).toBe(expected);
    });
  }
});

// ---- interceptClose, over a recording fake window set -------------------------

interface FakeWindows extends CloseToTrayWindows {
  live: Set<string>;
  open: number;
  hidden: number;
  readonly calls: string[];
}

function fakeWindows(): FakeWindows {
  const calls: string[] = [];
  const state = {
    live: new Set<string>(["w1"]),
    open: 0,
    hidden: 0,
    calls,
    isLive: (id: string) => state.live.has(id),
    otherOpenWindowCount: () => state.open,
    otherHiddenWindowCount: () => state.hidden,
    hide: (id: string) => {
      calls.push(`hide:${id}`);
    },
    close: (id: string) => {
      calls.push(`close:${id}`);
    },
  };
  return state;
}

interface Rig {
  readonly closer: CloseToTray;
  readonly windows: FakeWindows;
  readonly counts: { quit: number; notice: number; modeReads: number };
  readonly flags: {
    quitting: boolean;
    tray: boolean;
    mode: HostLifecycleMode;
  };
  readonly release: () => void;
}

function rigFor(platform: NodeJS.Platform, hold: boolean): Rig {
  const windows = fakeWindows();
  const counts = { quit: 0, notice: 0, modeReads: 0 };
  const flags: Rig["flags"] = { quitting: false, tray: true, mode: "linked" };
  let openGate: () => void = () => undefined;
  const gate = hold
    ? new Promise<void>((resolve) => {
        openGate = resolve;
      })
    : Promise.resolve();
  const closer = new CloseToTray({
    platform,
    hasTray: () => Promise.resolve(flags.tray),
    isQuitting: () => flags.quitting,
    readQuitMode: async () => {
      counts.modeReads += 1;
      await gate;
      return flags.mode;
    },
    windows,
    requestQuit: () => {
      counts.quit += 1;
    },
    showNoticeOnce: () => {
      counts.notice += 1;
    },
  });
  return { closer, windows, counts, flags, release: openGate };
}

function closeEvent(): { prevented: number; preventDefault(): void } {
  const event = {
    prevented: 0,
    preventDefault: () => {
      event.prevented += 1;
    },
  };
  return event;
}

describe("CloseToTray.interceptClose", () => {
  it("darwin: not intercepted, no preventDefault, no mode read", async () => {
    const rig = rigFor("darwin", false);
    const event = closeEvent();
    expect(rig.closer.interceptClose("w1", event)).toBe(false);
    await flush();
    expect(event.prevented).toBe(0);
    expect(rig.counts.modeReads).toBe(0);
  });

  it("quitting: not intercepted", async () => {
    const rig = rigFor("linux", false);
    rig.flags.quitting = true;
    const event = closeEvent();
    expect(rig.closer.interceptClose("w1", event)).toBe(false);
    expect(event.prevented).toBe(0);
    expect(rig.counts.modeReads).toBe(0);
  });

  it("another open (visible or minimized) window: not intercepted; the last window: intercepted", async () => {
    const rig = rigFor("win32", false);
    rig.windows.open = 1;
    const event = closeEvent();
    expect(rig.closer.interceptClose("w1", event)).toBe(false);
    expect(event.prevented).toBe(0);
    expect(rig.counts.modeReads).toBe(0);

    rig.windows.open = 0;
    const last = closeEvent();
    expect(rig.closer.interceptClose("w1", last)).toBe(true);
    expect(last.prevented).toBe(1);
    await flush();
    expect(rig.counts.modeReads).toBe(1);
  });

  it("tray + a policy that acts on the host: hide and the notice exactly once, no quit, no close", async () => {
    const rig = rigFor("linux", false);
    rig.closer.interceptClose("w1", closeEvent());
    await flush();
    expect(rig.windows.calls).toEqual(["hide:w1"]);
    expect(rig.counts.notice).toBe(1);
    expect(rig.counts.quit).toBe(0);
  });

  it("no tray: requestQuit with the window alive (no hide, no close)", async () => {
    const rig = rigFor("linux", false);
    rig.flags.tray = false;
    rig.closer.interceptClose("w1", closeEvent());
    await flush();
    expect(rig.counts.quit).toBe(1);
    expect(rig.windows.calls).toEqual([]);
    expect(rig.counts.notice).toBe(0);
  });

  it("background with hidden others: requestQuit (an invisible app must not stay alive)", async () => {
    const rig = rigFor("win32", false);
    rig.flags.mode = "background";
    rig.windows.hidden = 1;
    rig.closer.interceptClose("w1", closeEvent());
    await flush();
    expect(rig.counts.quit).toBe(1);
    expect(rig.windows.calls).toEqual([]);
  });

  it("background, no hidden others: the close is re-issued and passes through exactly once", async () => {
    const rig = rigFor("linux", false);
    rig.flags.mode = "background";
    const first = closeEvent();
    expect(rig.closer.interceptClose("w1", first)).toBe(true);
    expect(first.prevented).toBe(1);
    await flush();
    expect(rig.windows.calls).toEqual(["close:w1"]);
    expect(rig.counts.quit).toBe(0);

    // The re-issued close is let through, without a preventDefault...
    const reissued = closeEvent();
    expect(rig.closer.interceptClose("w1", reissued)).toBe(false);
    expect(reissued.prevented).toBe(0);
    // ...and only once: the next close is intercepted again.
    const next = closeEvent();
    expect(rig.closer.interceptClose("w1", next)).toBe(true);
    expect(next.prevented).toBe(1);
  });

  it("a quit that starts during the policy read: nothing happens", async () => {
    const rig = rigFor("linux", true);
    rig.closer.interceptClose("w1", closeEvent());
    rig.flags.quitting = true;
    rig.release();
    await flush();
    expect(rig.windows.calls).toEqual([]);
    expect(rig.counts.quit).toBe(0);
    expect(rig.counts.notice).toBe(0);
  });

  it("a window destroyed during the read: nothing happens", async () => {
    const rig = rigFor("linux", true);
    rig.closer.interceptClose("w1", closeEvent());
    rig.windows.live.delete("w1");
    rig.release();
    await flush();
    expect(rig.windows.calls).toEqual([]);
    expect(rig.counts.quit).toBe(0);
  });

  it("a second close while the read is pending prevents but does not read twice", async () => {
    const rig = rigFor("linux", true);
    const first = closeEvent();
    const second = closeEvent();
    expect(rig.closer.interceptClose("w1", first)).toBe(true);
    expect(rig.closer.interceptClose("w1", second)).toBe(true);
    expect(second.prevented).toBe(1);
    rig.release();
    await flush();
    expect(rig.counts.modeReads).toBe(1);
    expect(rig.windows.calls).toEqual(["hide:w1"]);
    expect(rig.counts.notice).toBe(1);
  });

  it("an unreadable policy is Background: the close goes through", async () => {
    const windows = fakeWindows();
    const closer = new CloseToTray({
      platform: "linux",
      hasTray: () => Promise.resolve(true),
      isQuitting: () => false,
      readQuitMode: () => Promise.reject(new Error("unreadable")),
      windows,
      requestQuit: () => undefined,
      showNoticeOnce: () => undefined,
    });
    closer.interceptClose("w1", closeEvent());
    await flush();
    expect(windows.calls).toEqual(["close:w1"]);
  });
});

// ---- hasTray: asked only for modes whose quit acts on the host, and only at
// settle time, so a quit that starts while it is pending still wins ---------------

describe("CloseToTray.interceptClose - hasTray", () => {
  const HOST_ACTING_MODES: readonly HostLifecycleMode[] = [
    "linked",
    "ask",
    "stop-if-idle",
  ];

  for (const mode of HOST_ACTING_MODES) {
    it(`${mode}: hasTray resolving false -> quit-with-window (window stays, no notice)`, async () => {
      const windows = fakeWindows();
      let quitCount = 0;
      let noticeCount = 0;
      const closer = new CloseToTray({
        platform: "linux",
        hasTray: () => Promise.resolve(false),
        isQuitting: () => false,
        readQuitMode: async () => mode,
        windows,
        requestQuit: () => {
          quitCount += 1;
        },
        showNoticeOnce: () => {
          noticeCount += 1;
        },
      });
      closer.interceptClose("w1", closeEvent());
      await flush();
      expect(quitCount).toBe(1);
      expect(windows.calls).toEqual([]);
      expect(noticeCount).toBe(0);
    });

    it(`${mode}: hasTray resolving true -> hide-to-tray, notice requested`, async () => {
      const windows = fakeWindows();
      let quitCount = 0;
      let noticeCount = 0;
      const closer = new CloseToTray({
        platform: "linux",
        hasTray: () => Promise.resolve(true),
        isQuitting: () => false,
        readQuitMode: async () => mode,
        windows,
        requestQuit: () => {
          quitCount += 1;
        },
        showNoticeOnce: () => {
          noticeCount += 1;
        },
      });
      closer.interceptClose("w1", closeEvent());
      await flush();
      expect(windows.calls).toEqual(["hide:w1"]);
      expect(noticeCount).toBe(1);
      expect(quitCount).toBe(0);
    });
  }

  it("hasTray rejecting: quit-with-window (a rejection reads as false)", async () => {
    const windows = fakeWindows();
    let quitCount = 0;
    const closer = new CloseToTray({
      platform: "linux",
      hasTray: () => Promise.reject(new Error("dbus unreachable")),
      isQuitting: () => false,
      readQuitMode: async () => "linked",
      windows,
      requestQuit: () => {
        quitCount += 1;
      },
      showNoticeOnce: () => undefined,
    });
    closer.interceptClose("w1", closeEvent());
    await flush();
    expect(quitCount).toBe(1);
    expect(windows.calls).toEqual([]);
  });

  it("background and none: hasTray is never called", async () => {
    for (const mode of ["background", "none"] as const) {
      const windows = fakeWindows();
      let hasTrayCalls = 0;
      const closer = new CloseToTray({
        platform: "linux",
        hasTray: () => {
          hasTrayCalls += 1;
          return Promise.resolve(true);
        },
        isQuitting: () => false,
        readQuitMode: async () => mode,
        windows,
        requestQuit: () => undefined,
        showNoticeOnce: () => undefined,
      });
      closer.interceptClose("w1", closeEvent());
      await flush();
      expect(hasTrayCalls).toBe(0);
    }
  });

  it("a quit that starts while hasTray is pending: neither hide nor quit (the isQuitting check after the await)", async () => {
    const windows = fakeWindows();
    let resolveHasTray: (value: boolean) => void = () => undefined;
    let quitting = false;
    let quitCount = 0;
    let noticeCount = 0;
    const closer = new CloseToTray({
      platform: "linux",
      hasTray: () =>
        new Promise<boolean>((resolve) => {
          resolveHasTray = resolve;
        }),
      isQuitting: () => quitting,
      readQuitMode: async () => "linked",
      windows,
      requestQuit: () => {
        quitCount += 1;
      },
      showNoticeOnce: () => {
        noticeCount += 1;
      },
    });
    closer.interceptClose("w1", closeEvent());
    await flush();
    quitting = true;
    resolveHasTray(true);
    await flush();
    expect(windows.calls).toEqual([]);
    expect(quitCount).toBe(0);
    expect(noticeCount).toBe(0);
  });
});

// ---- the one-time notice --------------------------------------------------------

function memoryStore(initial: CloseToTrayNoticeState): {
  readonly store: JsonFileStore<CloseToTrayNoticeState>;
  readonly saves: CloseToTrayNoticeState[];
} {
  const saves: CloseToTrayNoticeState[] = [];
  let current = initial;
  return {
    saves,
    store: {
      load: () => Promise.resolve(current),
      save: (value) => {
        saves.push(value);
        current = value;
        return Promise.resolve();
      },
      flush: () => Promise.resolve(),
    },
  };
}

describe("createCloseToTrayNoticeOnce", () => {
  it("show -> true: saved once, and a later call never calls show again", async () => {
    const { store, saves } = memoryStore({ shown: false });
    let shown = 0;
    const once = createCloseToTrayNoticeOnce({
      store,
      show: () => {
        shown += 1;
        return Promise.resolve(true);
      },
    });
    once();
    once();
    once();
    await flush();
    expect(shown).toBe(1);
    expect(saves).toEqual([{ shown: true }]);

    once();
    await flush();
    expect(shown).toBe(1);
  });

  it("show -> false: not saved, and the next call calls show again, which then succeeds and saves", async () => {
    const { store, saves } = memoryStore({ shown: false });
    let shown = 0;
    let result = false;
    const once = createCloseToTrayNoticeOnce({
      store,
      show: () => {
        shown += 1;
        return Promise.resolve(result);
      },
    });
    once();
    await flush();
    expect(shown).toBe(1);
    expect(saves).toEqual([]);

    result = true;
    once();
    await flush();
    expect(shown).toBe(2);
    expect(saves).toEqual([{ shown: true }]);
  });

  it("store already {shown:true}: show never called", async () => {
    const { store, saves } = memoryStore({ shown: true });
    let shown = 0;
    const once = createCloseToTrayNoticeOnce({
      store,
      show: () => {
        shown += 1;
        return Promise.resolve(true);
      },
    });
    once();
    await flush();
    expect(shown).toBe(0);
    expect(saves).toEqual([]);
  });

  it("two calls while the first show is still pending: show is called once", async () => {
    const { store, saves } = memoryStore({ shown: false });
    let shown = 0;
    let resolveShow: (value: boolean) => void = () => undefined;
    const once = createCloseToTrayNoticeOnce({
      store,
      show: () => {
        shown += 1;
        return new Promise<boolean>((resolve) => {
          resolveShow = resolve;
        });
      },
    });
    once();
    once();
    await flush();
    expect(shown).toBe(1);
    resolveShow(true);
    await flush();
    expect(saves).toEqual([{ shown: true }]);
  });

  it("show rejects: not saved, WARN logged, and the next call retries", async () => {
    vi.mocked(log.warn).mockClear();
    const { store, saves } = memoryStore({ shown: false });
    let shown = 0;
    let shouldReject = true;
    const once = createCloseToTrayNoticeOnce({
      store,
      show: () => {
        shown += 1;
        return shouldReject
          ? Promise.reject(new Error("no notification daemon"))
          : Promise.resolve(true);
      },
    });
    once();
    await flush();
    expect(shown).toBe(1);
    expect(saves).toEqual([]);
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.filter(
          ([message]) => message === "[close-to-tray] notice failed",
        ),
    ).toHaveLength(1);

    shouldReject = false;
    once();
    await flush();
    expect(shown).toBe(2);
    expect(saves).toEqual([{ shown: true }]);
  });

  it("a fresh process (new closure) over a saved flag stays quiet", async () => {
    const { store } = memoryStore({ shown: false });
    let shown = 0;
    const show = (): Promise<boolean> => {
      shown += 1;
      return Promise.resolve(true);
    };
    createCloseToTrayNoticeOnce({ store, show })();
    await flush();
    createCloseToTrayNoticeOnce({ store, show })();
    await flush();
    expect(shown).toBe(1);
  });

  it("parseCloseToTrayNoticeState accepts only shown:true", () => {
    expect(parseCloseToTrayNoticeState({ shown: true })).toEqual({
      shown: true,
    });
    for (const value of [null, undefined, {}, { shown: "yes" }, 7, []]) {
      expect(parseCloseToTrayNoticeState(value)).toEqual({ shown: false });
    }
  });
});

// ---- the window-creation-count guarantees, over a REAL WindowRegistry ------------

const VIEW: HostLifecycleView = {
  desired: { mode: "ask", rev: 1, updatedBy: "desktop", updatedAt: null },
  applied: { localHostCapability: "managed", supervisor: "not-running" },
  pending: "none",
};

describe("window-creation count (real WindowRegistry)", () => {
  it("Windows/Linux, no tray, Ask: closing the last window keeps it alive through a cancelled quit - createWindow called exactly once in total", async () => {
    const { registry, created, createWindow } = registryRig();
    const windowId = await registry.create({
      initialRoute: null,
      beforeLoad: null,
    });
    expect(createWindow).toHaveBeenCalledTimes(1);
    const window = created[0];

    let quitting = false;
    let stayedOpen = 0;
    let nativeAsks = 0;
    const txs = new QuitTransactions({
      isInstallingUpdate: () => false,
      lifecycle: {
        readQuitPolicy: async () => ({ mode: "ask", rev: 1 }),
        writeQuitVerdict: async () => "written",
        releaseQuitVerdict: async () => undefined,
        setMode: async () => ({ kind: "applied", view: VIEW }),
      },
      controller: {
        stopHost: async () => ({ kind: "stopped", forced: false }),
        holdAutomaticIntents: () => ({ release: () => undefined }),
        quiesce: () => undefined,
      },
      // No renderer can answer: the native dialog, answered Cancel.
      requestDecision: () => Promise.reject(new Error("no listening window")),
      withdrawDecision: () => undefined,
      askNatively: async () => {
        nativeAsks += 1;
        return { kind: "cancel" };
      },
      publishState: () => undefined,
      unsyncedEditsGate: async () => "proceed",
      runUpdateInstallSequence: async () => undefined,
      authorizeQuitAfterFlush: () => {
        quitting = true;
      },
      authorizeQuitNow: () => undefined,
      stayOpen: () => {
        stayedOpen += 1;
        ensureReachableAfterStayOpen({
          platform: "linux",
          windows: registry,
          openWindow: () => {
            void registry.create({ initialRoute: null, beforeLoad: null });
          },
        });
      },
      revealStopping: () => undefined,
      setStoppingIndicator: () => undefined,
      revealDelayMs: 1_000,
      deadlineMs: 5_000,
    });
    const closer = new CloseToTray({
      platform: "linux",
      hasTray: () => Promise.resolve(false),
      isQuitting: () => quitting,
      readQuitMode: async () => "ask",
      windows: registryCloseToTrayWindows(registry),
      requestQuit: () => {
        txs.onBeforeQuit();
      },
      showNoticeOnce: () => undefined,
    });
    window.onClose((event) => {
      closer.interceptClose(windowId, event);
    });

    window.close();
    await flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await flush();

    // The quit ran with the window alive, and the native Cancel left it open.
    expect(nativeAsks).toBe(1);
    expect(stayedOpen).toBe(1);
    expect(quitting).toBe(false);
    expect(window.isDestroyed()).toBe(false);
    expect(registry.records().map((record) => record.windowId)).toEqual([
      windowId,
    ]);
    // Never closed and recreated.
    expect(createWindow).toHaveBeenCalledTimes(1);
  });

  it("control: under Background the same close DOES destroy the window (the count assertion can fail)", async () => {
    const { registry, created, createWindow } = registryRig();
    const windowId = await registry.create({
      initialRoute: null,
      beforeLoad: null,
    });
    const window = created[0];
    const closer = new CloseToTray({
      platform: "linux",
      hasTray: () => Promise.resolve(false),
      isQuitting: () => false,
      readQuitMode: async () => "background",
      windows: registryCloseToTrayWindows(registry),
      requestQuit: () => undefined,
      showNoticeOnce: () => undefined,
    });
    window.onClose((event) => {
      closer.interceptClose(windowId, event);
    });
    window.close();
    await flush();
    expect(window.isDestroyed()).toBe(true);
    expect(registry.records()).toEqual([]);
    expect(createWindow).toHaveBeenCalledTimes(1);
  });

  it("tray + Linked: the last window is hidden, stays registered, and is never recreated", async () => {
    const { registry, created, createWindow } = registryRig();
    const windowId = await registry.create({
      initialRoute: null,
      beforeLoad: null,
    });
    const window = created[0];
    const closer = new CloseToTray({
      platform: "win32",
      hasTray: () => Promise.resolve(true),
      isQuitting: () => false,
      readQuitMode: async () => "linked",
      windows: registryCloseToTrayWindows(registry),
      requestQuit: () => undefined,
      showNoticeOnce: () => undefined,
    });
    window.onClose((event) => {
      closer.interceptClose(windowId, event);
    });
    window.close();
    await flush();
    expect(window.hideCalls).toBe(1);
    expect(window.isDestroyed()).toBe(false);
    expect(registry.records()).toHaveLength(1);
    expect(createWindow).toHaveBeenCalledTimes(1);
  });
});

describe("registryCloseToTrayWindows (real WindowRegistry)", () => {
  async function twoWindows(): Promise<{
    readonly rig: RegistryRig;
    readonly ids: readonly [string, string];
  }> {
    const rig = registryRig();
    const first = await rig.registry.create({
      initialRoute: null,
      beforeLoad: null,
    });
    const second = await rig.registry.create({
      initialRoute: null,
      beforeLoad: null,
    });
    return { rig, ids: [first, second] };
  }

  function closerFor(
    registry: RegistryRig["registry"],
    mode: HostLifecycleMode,
  ): CloseToTray {
    return new CloseToTray({
      platform: "linux",
      hasTray: () => Promise.resolve(true),
      isQuitting: () => false,
      readQuitMode: async () => mode,
      windows: registryCloseToTrayWindows(registry),
      requestQuit: () => undefined,
      showNoticeOnce: () => undefined,
    });
  }

  it("a minimized other window counts as OPEN: the close is not intercepted", async () => {
    const { rig, ids } = await twoWindows();
    rig.created[1].minimized = true;
    rig.created[1].hide();
    const event = closeEvent();
    expect(
      closerFor(rig.registry, "linked").interceptClose(ids[0], event),
    ).toBe(false);
    expect(event.prevented).toBe(0);
  });

  it("a hidden (not minimized) other window counts as HIDDEN, not open: the close is intercepted", async () => {
    const { rig, ids } = await twoWindows();
    rig.created[1].hide();
    const adapter = registryCloseToTrayWindows(rig.registry);
    expect(adapter.otherOpenWindowCount(ids[0])).toBe(0);
    expect(adapter.otherHiddenWindowCount(ids[0])).toBe(1);
    const event = closeEvent();
    expect(
      closerFor(rig.registry, "linked").interceptClose(ids[0], event),
    ).toBe(true);
    expect(event.prevented).toBe(1);
  });

  it("a visible other window counts as open (positive control)", async () => {
    const { rig, ids } = await twoWindows();
    const adapter = registryCloseToTrayWindows(rig.registry);
    expect(adapter.otherOpenWindowCount(ids[0])).toBe(1);
    expect(adapter.otherHiddenWindowCount(ids[0])).toBe(0);
  });

  it("a force-closed or destroyed window counts as neither, and isLive is false", async () => {
    const { rig, ids } = await twoWindows();
    const adapter = registryCloseToTrayWindows(rig.registry);
    await rig.registry.forceCloseById(ids[1]);
    expect(adapter.otherOpenWindowCount(ids[0])).toBe(0);
    expect(adapter.otherHiddenWindowCount(ids[0])).toBe(0);
    expect(adapter.isLive(ids[1])).toBe(false);
    expect(adapter.isLive(ids[0])).toBe(true);

    const third = await rig.registry.create({
      initialRoute: null,
      beforeLoad: null,
    });
    rig.created[2].destroy();
    expect(adapter.otherOpenWindowCount(ids[0])).toBe(0);
    expect(adapter.otherHiddenWindowCount(ids[0])).toBe(0);
    expect(adapter.isLive(third)).toBe(false);
  });

  it("hide and close reach the real window", async () => {
    const { rig, ids } = await twoWindows();
    const adapter = registryCloseToTrayWindows(rig.registry);
    adapter.hide(ids[1]);
    expect(rig.created[1].hideCalls).toBe(1);
    expect(rig.created[0].hideCalls).toBe(0);
    adapter.close(ids[1]);
    expect(rig.created[1].closeCalls).toBe(1);
    expect(rig.created[0].closeCalls).toBe(0);
  });
});

describe("reopen after a native Cancel (composition, counted by window creation)", () => {
  async function cancelledQuit(platform: NodeJS.Platform): Promise<{
    readonly createWindow: number;
    readonly windows: number;
  }> {
    const { registry, createWindow } = registryRig();
    const windowId = await registry.create({
      initialRoute: null,
      beforeLoad: null,
    });
    // The window is gone before the quit, as with a `window-all-closed` quit.
    await registry.forceCloseById(windowId);
    expect(createWindow).toHaveBeenCalledTimes(1);
    let stayedOpen = 0;
    const txs = new QuitTransactions({
      isInstallingUpdate: () => false,
      lifecycle: {
        readQuitPolicy: async () => ({ mode: "ask", rev: 1 }),
        writeQuitVerdict: async () => "written",
        releaseQuitVerdict: async () => undefined,
        setMode: async () => ({ kind: "applied", view: VIEW }),
      },
      controller: {
        stopHost: async () => ({ kind: "stopped", forced: false }),
        holdAutomaticIntents: () => ({ release: () => undefined }),
        quiesce: () => undefined,
      },
      requestDecision: () => Promise.reject(new Error("no window")),
      withdrawDecision: () => undefined,
      askNatively: async () => ({ kind: "cancel" }),
      publishState: () => undefined,
      unsyncedEditsGate: async () => "proceed",
      runUpdateInstallSequence: async () => undefined,
      authorizeQuitAfterFlush: () => undefined,
      authorizeQuitNow: () => undefined,
      stayOpen: () => {
        stayedOpen += 1;
        ensureReachableAfterStayOpen({
          platform,
          windows: registry,
          openWindow: () => {
            void registry.create({ initialRoute: null, beforeLoad: null });
          },
        });
      },
      revealStopping: () => undefined,
      setStoppingIndicator: () => undefined,
      revealDelayMs: 1_000,
      deadlineMs: 5_000,
    });
    txs.onBeforeQuit();
    await flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await flush();
    expect(stayedOpen).toBe(1);
    return {
      createWindow: createWindow.mock.calls.length,
      windows: registry.records().length,
    };
  }

  it("linux: exactly ONE new window (createWindow 1 -> 2)", async () => {
    expect(await cancelledQuit("linux")).toEqual({
      createWindow: 2,
      windows: 1,
    });
  });

  it("win32: exactly ONE new window", async () => {
    expect(await cancelledQuit("win32")).toEqual({
      createWindow: 2,
      windows: 1,
    });
  });

  it("darwin: no window is created (the dock reopens)", async () => {
    expect(await cancelledQuit("darwin")).toEqual({
      createWindow: 1,
      windows: 0,
    });
  });
});
