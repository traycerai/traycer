/**
 * The soundtrack store's entry in the system's media controls, with the REAL
 * session behind the fake ports. The media session is the one fake: it records
 * what the store tells it, and keeps the handlers the store gave it, which are
 * what the system's buttons call.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  openFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { playbackTrack } from "@/lib/soundtrack/__tests__/playback-track";
import type { SoundtrackManifest } from "@/lib/soundtrack/manifest";
import type { MediaSessionHandlers } from "@/lib/soundtrack/media-session";
import type { MixSignals } from "@/lib/soundtrack/signals";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { createSoundtrackStore } from "../soundtrack-store";

const HOME: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};

// With a random draw of 0, home opens on Calm and Next picks Bright.
const MANIFEST: SoundtrackManifest = {
  tracks: [
    { ...playbackTrack("calm", 60), title: "Calm" },
    { ...playbackTrack("bright", 60), title: "Bright" },
  ],
  views: { home: ["calm", "bright"], task: [], bot: [], settings: [] },
  stems: { tracks: [] },
};

function newWindow() {
  const sessions: {
    readonly handlers: MediaSessionHandlers;
    readonly setTrack: Mock<(title: string | null) => void>;
    readonly setPaused: Mock<(paused: boolean) => void>;
    readonly close: Mock<() => void>;
  }[] = [];
  const openMediaSession = vi.fn((handlers: MediaSessionHandlers) => {
    const session = {
      handlers,
      setTrack: vi.fn<(title: string | null) => void>(),
      setPaused: vi.fn<(paused: boolean) => void>(),
      close: vi.fn<() => void>(),
    };
    sessions.push(session);
    return session;
  });
  const store = createSoundtrackStore({
    readManifest: () => MANIFEST,
    openPorts: openFakePorts,
    random: () => 0,
    recordingChannel: () => null,
    openMediaSession,
  });
  return { store, openMediaSession, sessions };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetFakePorts();
  useSettingsStore.getState().setSoundtrackPaused(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("soundtrack store: the system's media controls", () => {
  it("names the sounding track, and the other one at Next without a tick", () => {
    const { store, openMediaSession, sessions } = newWindow();

    store.getState().enable();
    store.getState().setSignals(HOME);

    expect(openMediaSession).toHaveBeenCalledTimes(1);
    expect(sessions[0].setTrack).toHaveBeenLastCalledWith("Calm");

    store.getState().next();
    expect(sessions[0].setTrack).toHaveBeenLastCalledWith("Bright");
    store.getState().disable();
  });

  it("reports Pause and Play as the store is paused and played, and opens paused when the store already was", () => {
    const { store, sessions } = newWindow();
    store.getState().enable();
    store.getState().setPaused(true);
    store.getState().setPaused(false);
    expect(sessions[0].setPaused.mock.calls).toEqual([[true], [false]]);
    store.getState().disable();

    store.getState().setPaused(true);
    store.getState().enable();
    expect(sessions[1].setPaused).toHaveBeenCalledExactlyOnceWith(true);
    store.getState().disable();
  });

  it("closes the session with the device, and a new one is opened at the next enable", () => {
    const { store, openMediaSession, sessions } = newWindow();
    store.getState().enable();

    store.getState().disable();
    expect(sessions[0].close).toHaveBeenCalledTimes(1);

    store.getState().enable();
    expect(openMediaSession).toHaveBeenCalledTimes(2);
    expect(sessions[1].close).not.toHaveBeenCalled();
    store.getState().disable();
  });

  it("moves the person's wish from the system's Pause and Play, and plays on a skip", () => {
    const { store, sessions } = newWindow();
    store.getState().enable();
    store.getState().setSignals(HOME);
    const { play, pause, next } = sessions[0].handlers;

    pause();
    expect(useSettingsStore.getState().soundtrackPaused).toBe(true);
    play();
    expect(useSettingsStore.getState().soundtrackPaused).toBe(false);

    pause();
    next();
    expect(useSettingsStore.getState().soundtrackPaused).toBe(false);
    expect(sessions[0].setTrack).toHaveBeenLastCalledWith("Bright");
    store.getState().disable();
  });
});
