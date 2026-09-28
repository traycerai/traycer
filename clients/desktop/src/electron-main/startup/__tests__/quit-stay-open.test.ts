import { describe, expect, it, vi } from "vitest";
import {
  registryRig,
  type RegistryRig,
} from "../../windows/__tests__/registry-fake-window";
import {
  HiddenToTrayWindows,
  registryCloseToTrayWindows,
} from "../../windows/close-to-tray";
import {
  ensureReachableAfterStayOpen,
  revealHiddenWindowForStopping,
} from "../quit-stay-open";

async function rigWithWindows(count: number): Promise<RegistryRig> {
  const rig = registryRig([]);
  for (let i = 0; i < count; i += 1) {
    await rig.registry.create({ initialRoute: null, beforeLoad: null });
  }
  return rig;
}

describe("revealHiddenWindowForStopping (real WindowRegistry)", () => {
  it("a visible window exists: false, zero show and focus calls", async () => {
    const rig = await rigWithWindows(1);
    expect(
      revealHiddenWindowForStopping(rig.registry, new HiddenToTrayWindows()),
    ).toBe(false);
    expect(rig.created[0].showCalls).toBe(0);
    expect(rig.created[0].focusCalls).toBe(0);
  });

  it("only a hidden MRU window: true, exactly ONE show and ONE focus on it", async () => {
    const rig = await rigWithWindows(1);
    const hidden = new HiddenToTrayWindows();
    const windowId = rig.registry.records()[0].windowId;
    registryCloseToTrayWindows(rig.registry, hidden).hide(windowId);
    expect(revealHiddenWindowForStopping(rig.registry, hidden)).toBe(true);
    expect(rig.created[0].showCalls).toBe(1);
    expect(rig.created[0].focusCalls).toBe(1);
    expect(rig.created[0].isVisible()).toBe(true);
  });

  it("a hidden window plus a visible one: false, the hidden one is left alone", async () => {
    const rig = await rigWithWindows(2);
    const hidden = new HiddenToTrayWindows();
    const windowId = rig.registry.records()[0].windowId;
    registryCloseToTrayWindows(rig.registry, hidden).hide(windowId);
    expect(revealHiddenWindowForStopping(rig.registry, hidden)).toBe(false);
    expect(rig.created[0].showCalls).toBe(0);
    expect(rig.created[0].focusCalls).toBe(0);
    expect(rig.created[1].focusCalls).toBe(0);
  });

  it("no windows: false, and nothing is ever created", async () => {
    const rig = registryRig([]);
    expect(
      revealHiddenWindowForStopping(rig.registry, new HiddenToTrayWindows()),
    ).toBe(false);
    expect(rig.createWindow).not.toHaveBeenCalled();
  });

  it("a destroyed window does not count as visible", async () => {
    const rig = await rigWithWindows(2);
    rig.created[1].destroy();
    const hidden = new HiddenToTrayWindows();
    const windowId = rig.registry.records()[0].windowId;
    registryCloseToTrayWindows(rig.registry, hidden).hide(windowId);
    expect(revealHiddenWindowForStopping(rig.registry, hidden)).toBe(true);
    expect(rig.created[0].showCalls).toBe(1);
  });

  // A still-loading window (never shown, never hidden BY THE ADAPTER) is
  // not a window close-to-tray hid, so it reads as open regardless of its
  // visible/minimized state - `revealHiddenWindowForStopping` has nothing to
  // reveal.
  it("the MRU is a loading window and no window was hidden to the tray: false, 0 show and 0 focus", async () => {
    const rig = registryRig([false]);
    await rig.registry.create({ initialRoute: null, beforeLoad: null });
    expect(
      revealHiddenWindowForStopping(rig.registry, new HiddenToTrayWindows()),
    ).toBe(false);
    expect(rig.created[0].showCalls).toBe(0);
    expect(rig.created[0].focusCalls).toBe(0);
  });

  it("control: the MRU was hidden (via the adapter) and another window is loading: the reveal shows the hidden MRU exactly once", async () => {
    const rig = registryRig([false, true]);
    // Loading window first, then the one that will be hidden - creation
    // order makes the LATTER the MRU.
    await rig.registry.create({ initialRoute: null, beforeLoad: null });
    const bId = await rig.registry.create({
      initialRoute: null,
      beforeLoad: null,
    });
    const hidden = new HiddenToTrayWindows();
    registryCloseToTrayWindows(rig.registry, hidden).hide(bId);
    expect(revealHiddenWindowForStopping(rig.registry, hidden)).toBe(true);
    expect(rig.created[1].showCalls).toBe(1);
    expect(rig.created[1].focusCalls).toBe(1);
    expect(rig.created[0].showCalls).toBe(0);
  });
});

describe("ensureReachableAfterStayOpen (real WindowRegistry)", () => {
  const platforms: readonly NodeJS.Platform[] = ["linux", "win32"];
  for (const platform of platforms) {
    it(`${platform} with zero live windows: openWindow exactly once, createWindow 0 -> 1`, async () => {
      const rig = registryRig([]);
      expect(rig.createWindow).toHaveBeenCalledTimes(0);
      const opened = ensureReachableAfterStayOpen({
        platform,
        windows: rig.registry,
        openWindow: () => {
          void rig.registry.create({ initialRoute: null, beforeLoad: null });
        },
      });
      expect(opened).toBe(true);
      expect(rig.createWindow).toHaveBeenCalledTimes(1);
      expect(rig.registry.records()).toHaveLength(1);
    });

    it(`${platform} with a live window (hidden counts): no call`, async () => {
      const rig = await rigWithWindows(1);
      rig.created[0].hide();
      const openWindow = vi.fn();
      expect(
        ensureReachableAfterStayOpen({
          platform,
          windows: rig.registry,
          openWindow,
        }),
      ).toBe(false);
      expect(openWindow).not.toHaveBeenCalled();
      expect(rig.createWindow).toHaveBeenCalledTimes(1);
    });

    it(`${platform}: a destroyed-only registry counts as zero live windows`, async () => {
      const rig = await rigWithWindows(1);
      rig.created[0].destroy();
      const openWindow = vi.fn();
      expect(
        ensureReachableAfterStayOpen({
          platform,
          windows: rig.registry,
          openWindow,
        }),
      ).toBe(true);
      expect(openWindow).toHaveBeenCalledTimes(1);
    });
  }

  it("darwin: zero calls even with zero windows (the dock reopens)", () => {
    const rig = registryRig([]);
    const openWindow = vi.fn();
    expect(
      ensureReachableAfterStayOpen({
        platform: "darwin",
        windows: rig.registry,
        openWindow,
      }),
    ).toBe(false);
    expect(openWindow).not.toHaveBeenCalled();
    expect(rig.createWindow).not.toHaveBeenCalled();
  });
});
