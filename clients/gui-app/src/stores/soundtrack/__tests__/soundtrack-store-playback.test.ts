/**
 * The soundtrack store's pause, with the real session, players and scheduler
 * behind the fake ports (their clock stops on `pause`), and for the window
 * waiting on the session lock, two stores over one fake `navigator.locks`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLockManager } from "@/lib/soundtrack/__tests__/fake-locks";
import {
  openedFakePorts,
  openFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { playbackTrack } from "@/lib/soundtrack/__tests__/playback-track";
import type { SoundtrackManifest } from "@/lib/soundtrack/manifest";
import type { MixSignals } from "@/lib/soundtrack/signals";
import { createSoundtrackStore } from "../soundtrack-store";

const HOME: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};

const MANIFEST: SoundtrackManifest = {
  tracks: [playbackTrack("calm", 60)],
  views: { home: ["calm"], task: [], bot: [], settings: [] },
  stems: { tracks: [] },
};

function newWindow() {
  return createSoundtrackStore({
    readManifest: () => MANIFEST,
    openPorts: openFakePorts,
    random: () => 0,
  });
}

async function advance(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetFakePorts();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: new FakeLockManager(),
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "locks");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("soundtrack store: pause", () => {
  it("opens a session paused when the setting says paused, and plays at Play", async () => {
    const store = newWindow();
    store.getState().setPaused(true);
    store.getState().enable();
    // The session lock is granted on a later turn.
    await advance(0);
    store.getState().setSignals(HOME);
    await advance(20);

    const { output } = openedFakePorts[0];
    expect(store.getState().enabled).toBe(true);
    expect(output.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    store.getState().setPaused(false);
    await advance(1);
    expect(output.allPlays()).not.toEqual([]);
    store.getState().disable();
  });

  it("passes a volume set during a pause to the device, and ducks nothing for a chime until Play", async () => {
    const store = newWindow();
    store.getState().enable();
    // The session lock is granted on a later turn.
    await advance(0);
    store.getState().setSignals(HOME);
    await advance(1);
    store.getState().setPaused(true);

    store.getState().setVolume(0.3);
    store.getState().duck(0.5);
    const { setVolume, duck } = openedFakePorts[0];
    expect(setVolume).toHaveBeenLastCalledWith(0.3);
    expect(duck).not.toHaveBeenCalled();

    store.getState().setPaused(false);
    store.getState().duck(0.5);
    expect(duck).toHaveBeenCalledExactlyOnceWith(0.5);
    store.getState().disable();
  });

  it("closes the device and keeps where each view got to when ended while paused, leaving no timer", async () => {
    const store = newWindow();
    store.getState().enable();
    // The session lock is granted on a later turn.
    await advance(0);
    store.getState().setSignals(HOME);
    await advance(3);
    store.getState().setPaused(true);
    await advance(100);

    store.getState().disable();
    expect(openedFakePorts[0].close).toHaveBeenCalledTimes(1);
    const { home } = store.getState().resumePositions;
    expect(home?.trackName).toBe("calm");
    // The 100 s of the pause are not played: the position is where it held.
    expect(home?.elapsedSeconds).toBeGreaterThan(2.9);
    expect(home?.elapsedSeconds).toBeLessThan(3.1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("soundtrack store: the lock across windows", () => {
  it("never reads a free lock as a wait", async () => {
    const store = newWindow();
    const seen: boolean[] = [];
    store.subscribe((state) => {
      seen.push(state.waitingForLock);
    });

    store.getState().enable();
    await advance(0);
    expect(store.getState().enabled).toBe(true);
    expect(seen).not.toContain(true);
    store.getState().disable();
  });

  it("marks a window waiting while another plays, and not once it plays", async () => {
    const first = newWindow();
    const second = newWindow();
    first.getState().enable();
    await advance(0);

    second.getState().enable();
    await advance(0);
    expect(second.getState().waitingForLock).toBe(true);
    expect(first.getState().waitingForLock).toBe(false);

    first.getState().disable();
    await advance(0);
    expect(second.getState().waitingForLock).toBe(false);
    expect(second.getState().enabled).toBe(true);
    second.getState().disable();
  });

  it("reads a window as no longer waiting once Music is turned off", async () => {
    const first = newWindow();
    const second = newWindow();
    first.getState().enable();
    await advance(0);
    second.getState().enable();
    await advance(0);
    expect(second.getState().waitingForLock).toBe(true);

    second.getState().disable();
    expect(second.getState().waitingForLock).toBe(false);
    first.getState().disable();
  });

  it("opens paused in a window that takes the lock while the setting is paused", async () => {
    const first = newWindow();
    const second = newWindow();
    first.getState().enable();
    await advance(0);
    second.getState().enable();
    await advance(0);
    first.getState().setPaused(true);
    second.getState().setPaused(true);

    first.getState().disable();
    await advance(0);
    second.getState().setSignals(HOME);
    await advance(20);

    expect(second.getState().enabled).toBe(true);
    expect(openedFakePorts).toHaveLength(2);
    expect(openedFakePorts[1].output.calls).toEqual([]);
    second.getState().disable();
  });
});
