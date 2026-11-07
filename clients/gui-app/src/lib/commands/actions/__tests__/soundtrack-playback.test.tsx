/**
 * Play, Pause, Next and Previous through the real actions, the real persisted
 * settings store, the real soundtrack store, the real session and the real
 * gesture listener, behind a fake audio device. A launch is the settings
 * store rehydrating from what an earlier launch left in storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { SoundtrackWarmupBridge } from "@/components/layout/bridges/soundtrack-signals-bridge";
import {
  nextTrack,
  pauseMusic,
  playMusic,
  previousTrack,
  setPlaybackControlsOn,
  setSoundtrackOn,
} from "@/lib/commands/actions/soundtrack";
import { playbackTrack } from "@/lib/soundtrack/__tests__/playback-track";
import {
  openedFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { CROSSFADE_SECONDS } from "@/lib/soundtrack/player";
import type { SoundtrackManifest } from "@/lib/soundtrack/manifest";
import type { MixSignals } from "@/lib/soundtrack/signals";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

const MANIFEST: SoundtrackManifest = {
  tracks: [playbackTrack("one", 60), playbackTrack("two", 60)],
  views: { home: ["one", "two"], task: [], bot: [], settings: [] },
  stems: { tracks: [] },
};

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => true,
  readSoundtrackManifest: () => MANIFEST,
}));

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
  return { openWebAudioPorts: openFakePorts };
});

const HOME: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};

/** What an earlier launch left in storage, picked up as a launch does. */
async function launchWith(persisted: Record<string, unknown>): Promise<void> {
  window.localStorage.setItem(
    "traycer-gui-app:settings",
    JSON.stringify({ state: persisted, version: 1 }),
  );
  await useSettingsStore.persist.rehydrate();
}

function firstGesture(): void {
  act(() => {
    window.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
}

async function advance(seconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1000);
  });
}

/** Signals for the home view, and long enough for a sample to be placed. */
async function listen(): Promise<void> {
  act(() => {
    useSoundtrackStore.getState().setSignals(HOME);
  });
  await advance(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetFakePorts();
  window.localStorage.clear();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  useSoundtrackStore.getState().disable();
  vi.useRealTimers();
});

describe("a launch that kept the pause", () => {
  beforeEach(async () => {
    await launchWith({ soundtrackEnabled: true, soundtrackPaused: true });
    render(<SoundtrackWarmupBridge />);
  });

  it("makes no sound at the first gesture", async () => {
    firstGesture();
    await advance(5);

    expect(openedFakePorts).toHaveLength(0);
    expect(useSoundtrackStore.getState().enabled).toBe(false);
    expect(useSettingsStore.getState().soundtrackPaused).toBe(true);
  });

  it("opens the session at Play, from that gesture, and the music plays", async () => {
    firstGesture();
    playMusic();
    await listen();

    expect(openedFakePorts).toHaveLength(1);
    expect(useSettingsStore.getState().soundtrackPaused).toBe(false);
    expect(openedFakePorts[0].output.allPlays()).not.toEqual([]);
  });

  it.each([
    ["Next", nextTrack],
    ["Previous", previousTrack],
  ])("opens the session at %s and plays", async (_label, skip) => {
    skip();
    await listen();

    expect(openedFakePorts).toHaveLength(1);
    expect(useSettingsStore.getState().soundtrackPaused).toBe(false);
    expect(openedFakePorts[0].output.allPlays()).not.toEqual([]);
  });

  it("opens nothing when the playback controls are turned on", () => {
    setPlaybackControlsOn(true);

    expect(openedFakePorts).toHaveLength(0);
    expect(useSettingsStore.getState().soundtrackPaused).toBe(true);
  });

  it("opens the session and plays when the playback controls are turned off", async () => {
    setPlaybackControlsOn(false);
    await listen();

    expect(openedFakePorts).toHaveLength(1);
    expect(useSettingsStore.getState().soundtrackPaused).toBe(false);
    expect(openedFakePorts[0].output.allPlays()).not.toEqual([]);
  });
});

describe("a launch that did not", () => {
  it("plays at the first gesture", async () => {
    await launchWith({ soundtrackEnabled: true });
    render(<SoundtrackWarmupBridge />);

    firstGesture();
    await listen();

    expect(openedFakePorts).toHaveLength(1);
    expect(openedFakePorts[0].output.allPlays()).not.toEqual([]);
  });
});

describe("with a session open", () => {
  beforeEach(async () => {
    useSettingsStore.setState({ soundtrackPlaybackControls: true });
    setSoundtrackOn(true);
    await listen();
  });

  it("pauses the session and the setting, and Play continues it", async () => {
    pauseMusic();
    const { output } = openedFakePorts[0];
    const calls = output.calls.length;
    await advance(30);

    expect(useSoundtrackStore.getState().paused).toBe(true);
    expect(useSettingsStore.getState().soundtrackEnabled).toBe(true);
    expect(output.calls).toHaveLength(calls);

    playMusic();
    await advance(10);
    expect(output.calls.length).toBeGreaterThan(calls);
    expect(openedFakePorts).toHaveLength(1);
  });

  it("plays, and reads unpaused, when Next is pressed while paused", async () => {
    pauseMusic();
    nextTrack();
    const { output } = openedFakePorts[0];

    expect(useSettingsStore.getState().soundtrackPaused).toBe(false);
    expect(useSoundtrackStore.getState().paused).toBe(false);
    // The track picked is the other one, on its own bus, brought up at once.
    expect(output.ramps("bus1")).toEqual([
      expect.objectContaining({ target: 1, seconds: CROSSFADE_SECONDS }),
    ]);
    const calls = output.calls.length;
    await advance(1);
    expect(output.calls.length).toBeGreaterThan(calls);
  });

  it("plays, and reads unpaused, when Previous is pressed while paused", async () => {
    pauseMusic();
    await advance(5);
    previousTrack();
    const { output } = openedFakePorts[0];

    expect(useSettingsStore.getState().soundtrackPaused).toBe(false);
    expect(useSoundtrackStore.getState().paused).toBe(false);
    // Nothing is earlier: the track restarts from its top on its own bus.
    expect(output.ramps("bus0").at(-1)).toMatchObject({
      target: 1,
      seconds: CROSSFADE_SECONDS,
    });
    const calls = output.calls.length;
    await advance(1);
    expect(output.calls.length).toBeGreaterThan(calls);
  });

  it("plays when the playback controls are turned off while paused", async () => {
    pauseMusic();
    const { output } = openedFakePorts[0];
    const calls = output.calls.length;

    setPlaybackControlsOn(false);
    expect(useSettingsStore.getState().soundtrackPaused).toBe(false);
    await advance(10);
    expect(output.calls.length).toBeGreaterThan(calls);
  });

  it("keeps the pause when Music is turned off, and plays when it is turned on again", async () => {
    pauseMusic();

    setSoundtrackOn(false);
    expect(openedFakePorts[0].close).toHaveBeenCalledTimes(1);
    expect(useSoundtrackStore.getState().enabled).toBe(false);
    expect(useSettingsStore.getState().soundtrackPaused).toBe(true);

    setSoundtrackOn(true);
    expect(useSettingsStore.getState().soundtrackPaused).toBe(false);
    expect(openedFakePorts).toHaveLength(2);
    await listen();
    expect(openedFakePorts[1].output.allPlays()).not.toEqual([]);
  });
});

describe("a Play the audio device refuses", () => {
  /** Opens a session and pauses it, then makes `unpause` meet a refusal. */
  async function refused(unpause: () => void): Promise<number> {
    render(<SoundtrackWarmupBridge />);
    useSettingsStore.setState({ soundtrackPlaybackControls: true });
    setSoundtrackOn(true);
    await listen();
    pauseMusic();
    openedFakePorts[0].refuseResumes();

    unpause();
    await advance(0);
    return (
      useSoundtrackStore.getState().resumePositions.home?.elapsedSeconds ?? 0
    );
  }

  /** The next gesture, and a second at the music after it. */
  async function gestureAndListen(): Promise<void> {
    firstGesture();
    await listen();
  }

  const WAYS_TO_PLAY: ReadonlyArray<readonly [string, () => void]> = [
    ["Play", playMusic],
    ["turning the playback controls off", () => setPlaybackControlsOn(false)],
  ];

  it.each(WAYS_TO_PLAY)(
    "ends the session after %s, leaving the wish to hear it, and the next gesture alone plays from where it got to",
    async (_label, unpause) => {
      const gotTo = await refused(unpause);

      expect(useSoundtrackStore.getState().enabled).toBe(false);
      expect(openedFakePorts[0].close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(useSettingsStore.getState()).toMatchObject({
        soundtrackEnabled: true,
        soundtrackPaused: false,
      });
      expect(gotTo).toBeGreaterThan(0.5);

      await gestureAndListen();
      expect(openedFakePorts).toHaveLength(2);
      expect(useSoundtrackStore.getState().enabled).toBe(true);
      expect(openedFakePorts[1].output.allPlays()).not.toEqual([]);
      useSoundtrackStore.getState().disable();
      const resumedAt =
        useSoundtrackStore.getState().resumePositions.home?.elapsedSeconds ?? 0;
      expect(resumedAt).toBeGreaterThan(gotTo + 0.5);
      expect(resumedAt).toBeLessThan(gotTo + 2);
    },
  );
});
