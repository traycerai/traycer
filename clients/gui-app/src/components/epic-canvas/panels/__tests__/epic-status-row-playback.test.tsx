/**
 * The playback buttons in the real `EpicStatusRow`, through the real settings
 * and soundtrack stores, the real actions and the real session, behind a fake
 * audio device. A second window is a second store over one fake
 * `navigator.locks`; the singleton is this window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { EpicStatusRow } from "@/components/epic-canvas/panels/epic-status-row";
import { FakeLockManager } from "@/lib/soundtrack/__tests__/fake-locks";
import {
  openedFakePorts,
  openFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { playbackTrack } from "@/lib/soundtrack/__tests__/playback-track";
import { CROSSFADE_SECONDS } from "@/lib/soundtrack/player";
import { makeAudioBuffer } from "@/lib/soundtrack/__tests__/audio-buffer";
import type {
  ComposedTrack,
  SoundtrackManifest,
} from "@/lib/soundtrack/manifest";
import type { SoundtrackView } from "@/lib/soundtrack/signals";
import type { MixSignals } from "@/lib/soundtrack/signals";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  createSoundtrackStore,
  useSoundtrackStore,
} from "@/stores/soundtrack/soundtrack-store";

const MANIFEST: SoundtrackManifest = {
  tracks: [playbackTrack("one", 60), playbackTrack("two", 60)],
  views: { home: ["one", "two"], task: [], bot: [], settings: [] },
  stems: { tracks: [] },
};

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => true,
  readSoundtrackManifest: () => manifest,
}));

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts: open } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
  // The default fake device has no recordings; a set piece needs one to load.
  return {
    openWebAudioPorts: (...args: Parameters<typeof open>) => {
      const ports = open(...args);
      return {
        ...ports,
        stems: {
          load: ports.stems.load.bind(ports.stems),
          loadRecording: () => Promise.resolve(makeAudioBuffer(10, 10)),
        },
      };
    },
  };
});

let manifest = MANIFEST;

function pieceOf(name: string, title: string): ComposedTrack {
  return { kind: "composed", name, title, recording: "master" };
}

/** The tracks `home` may play. */
function offerHome(tracks: SoundtrackManifest["tracks"]): void {
  const views: Record<SoundtrackView, readonly string[]> = {
    home: tracks.map((track) => track.name),
    task: [],
    bot: [],
    settings: [],
  };
  manifest = {
    tracks,
    views,
    stems: { tracks: [], recordings: [{ name: "master", file: "piece.opus" }] },
  };
}

const HOME: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};

const NAMES = ["Previous track", "Pause", "Next track"];

function buttonNames(): string[] {
  return screen.queryAllByRole("button").map((button) => {
    return button.getAttribute("aria-label") ?? "";
  });
}

async function advance(seconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1000);
  });
}

function renderRow(): void {
  render(
    <EpicStatusRow>
      <span>status</span>
    </EpicStatusRow>,
  );
}

function wishForControls(): void {
  useSettingsStore.setState({
    soundtrackEnabled: true,
    soundtrackPlaybackControls: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  manifest = MANIFEST;
  resetFakePorts();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: new FakeLockManager(),
  });
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  useSoundtrackStore.getState().disable();
  Reflect.deleteProperty(navigator, "locks");
  Reflect.deleteProperty(globalThis, "runnerHost");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the playback buttons in the status row", () => {
  it("draws none by default, and keeps the row's own items", () => {
    useSettingsStore.setState({ soundtrackEnabled: true });
    renderRow();

    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.getByText("status")).toBeTruthy();
  });

  it("draws none with the option on and Music off", () => {
    useSettingsStore.setState({ soundtrackPlaybackControls: true });
    renderRow();

    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("draws Previous, Pause and Next, in that order, before any session exists", () => {
    wishForControls();
    renderRow();

    expect(useSoundtrackStore.getState().enabled).toBe(false);
    expect(buttonNames()).toEqual(NAMES);
  });

  it("follows Music: gone when it is turned off, back when it is turned on", () => {
    wishForControls();
    renderRow();
    expect(buttonNames()).toEqual(NAMES);

    act(() => {
      useSettingsStore.getState().setSoundtrackEnabled(false);
    });
    expect(screen.queryAllByRole("button")).toEqual([]);

    act(() => {
      useSettingsStore.getState().setSoundtrackEnabled(true);
    });
    expect(buttonNames()).toEqual(NAMES);
  });

  it("shows Play after a launch that kept the pause, and Play opens the session and the music", async () => {
    useSettingsStore.setState({
      soundtrackEnabled: true,
      soundtrackPlaybackControls: true,
      soundtrackPaused: true,
    });
    renderRow();
    expect(buttonNames()).toEqual(["Previous track", "Play", "Next track"]);

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    // The session lock is granted on a later turn.
    await advance(0);
    act(() => {
      useSoundtrackStore.getState().setSignals(HOME);
    });
    await advance(1);

    expect(buttonNames()).toEqual(NAMES);
    expect(openedFakePorts).toHaveLength(1);
    expect(openedFakePorts[0].output.allPlays()).not.toEqual([]);
  });

  it("swaps Pause and Play on the one element, so focus stays on it", () => {
    wishForControls();
    renderRow();
    const toggle = screen.getByTestId("epic-playback-toggle");
    toggle.focus();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(useSoundtrackStore.getState().paused).toBe(true);
    expect(screen.getByRole("button", { name: "Play" })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(useSoundtrackStore.getState().paused).toBe(false);
    expect(screen.getByRole("button", { name: "Pause" })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
  });

  it("reaches the running session: Pause holds the clock, Next and Previous move the track", async () => {
    wishForControls();
    renderRow();
    // With no session yet, the first press only opens one, from its gesture.
    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    await advance(0);
    act(() => {
      useSoundtrackStore.getState().setSignals(HOME);
    });
    await advance(1);
    const { output } = openedFakePorts[0];
    expect(output.ramps("bus1")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    expect(output.ramps("bus1")).toEqual([
      expect.objectContaining({ target: 1, seconds: CROSSFADE_SECONDS }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Previous track" }));
    expect(output.ramps("bus0").at(-1)).toMatchObject({
      target: 1,
      seconds: CROSSFADE_SECONDS,
    });

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const calls = output.calls.length;
    await advance(30);
    expect(output.calls).toHaveLength(calls);
  });

  it("keeps the buttons drawn, reading Pause, when the device refuses a Play and the session ends", async () => {
    wishForControls();
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    await advance(0);
    act(() => {
      useSoundtrackStore.getState().setSignals(HOME);
    });
    await advance(1);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    openedFakePorts[0].refuseResumes();

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await advance(0);

    expect(useSoundtrackStore.getState().enabled).toBe(false);
    expect(buttonNames()).toEqual(NAMES);
  });

  describe("with another window holding the session", () => {
    it("draws none for a window waiting on the lock, and draws them again when it takes it", async () => {
      wishForControls();
      const other = createSoundtrackStore({
        readManifest: () => MANIFEST,
        openPorts: openFakePorts,
        random: () => 0,
        recordingChannel: () => null,
        openMediaSession: () => null,
      });
      other.getState().enable();
      await advance(0);
      renderRow();
      expect(buttonNames()).toEqual(NAMES);

      act(() => {
        useSoundtrackStore.getState().enable();
      });
      await advance(0);
      expect(useSoundtrackStore.getState().waitingForLock).toBe(true);
      expect(screen.queryAllByRole("button")).toEqual([]);

      act(() => {
        other.getState().disable();
      });
      await advance(0);
      expect(useSoundtrackStore.getState().enabled).toBe(true);
      expect(buttonNames()).toEqual(NAMES);
    });
  });
});

/** Opens the session from a Next press, as a person's first gesture does, and lets a view sound. */
async function startMusic(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Next track" }));
  await advance(0);
  act(() => {
    useSoundtrackStore.getState().setSignals(HOME);
  });
  await advance(1);
}

function identity(): string | null {
  return screen.queryByTestId("epic-playback-track")?.textContent ?? null;
}

/** What the three buttons are described by, as a screen reader would read it. */
function descriptions(): (string | null)[] {
  return ["previous", "toggle", "next"].map((name) => {
    const id = screen
      .getByTestId(`epic-playback-${name}`)
      .getAttribute("aria-describedby");
    return id === null
      ? null
      : (document.getElementById(id)?.textContent ?? null);
  });
}

describe("the identity of the track that is sounding", () => {
  it("names nothing before a track sounds, and leaves the button names alone", () => {
    wishForControls();
    renderRow();

    expect(identity()).toBeNull();
    expect(descriptions()).toEqual([null, null, null]);
    expect(buttonNames()).toEqual(NAMES);
  });

  it("shows the track's title rather than its internal name, as a generative variant, and describes every button by it", async () => {
    offerHome([{ ...playbackTrack("one-internal", 60), title: "Slow Tide" }]);
    wishForControls();
    renderRow();
    await startMusic();

    expect(identity()).toBe("Slow Tide · Generative variant");
    expect(descriptions()).toEqual(Array(3).fill(identity()));
    expect(buttonNames()).toEqual(NAMES);
  });

  it("falls back to the internal name for a blank title", async () => {
    offerHome([{ ...playbackTrack("two", 60), title: "   " }]);
    wishForControls();
    renderRow();
    await startMusic();

    expect(identity()).toBe("two · Generative variant");
  });

  it("calls a complete recording Composed", async () => {
    offerHome([pieceOf("piece-internal", "Moonlit Étude")]);
    wishForControls();
    renderRow();
    await startMusic();

    expect(identity()).toBe("Moonlit Étude · Composed");
    expect(useSoundtrackStore.getState().soundingTrack?.kind).toBe("composed");
  });

  it("follows Next and Previous through the session, and holds through a pause", async () => {
    offerHome([
      { ...playbackTrack("one", 60), title: "Slow Tide" },
      pieceOf("piece", "Moonlit Étude"),
    ]);
    wishForControls();
    renderRow();
    await startMusic();
    // The first track is a random draw; Next then always goes to the other one.
    const generative = "Slow Tide · Generative variant";
    const composed = "Moonlit Étude · Composed";
    const first = identity();
    const second = first === generative ? composed : generative;
    expect([generative, composed]).toContain(first);

    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    expect(identity()).toBe(second);

    fireEvent.click(screen.getByRole("button", { name: "Previous track" }));
    expect(identity()).toBe(first);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await advance(30);
    expect(identity()).toBe(first);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(descriptions()).toEqual(Array(3).fill(identity()));
  });

  it("goes when the view has no track, with the buttons still drawn", async () => {
    offerHome([{ ...playbackTrack("one", 60), title: "Slow Tide" }]);
    wishForControls();
    renderRow();
    await startMusic();
    expect(identity()).not.toBeNull();

    act(() => {
      useSoundtrackStore.getState().setSignals({ ...HOME, view: "settings" });
    });
    await advance(2);

    expect(useSoundtrackStore.getState().soundingTrack).toBeNull();
    expect(identity()).toBeNull();
    expect(descriptions()).toEqual([null, null, null]);
    expect(buttonNames()).toEqual(NAMES);
  });

  it("goes when Music ends the session, with the buttons still drawn", async () => {
    offerHome([{ ...playbackTrack("one", 60), title: "Slow Tide" }]);
    wishForControls();
    renderRow();
    await startMusic();
    expect(identity()).not.toBeNull();

    act(() => {
      useSoundtrackStore.getState().disable();
    });

    expect(useSoundtrackStore.getState().soundingTrack).toBeNull();
    expect(identity()).toBeNull();
    expect(buttonNames()).toEqual(NAMES);
  });

  it("goes when set pieces are turned off while one is the one sounding", async () => {
    Reflect.set(globalThis, "runnerHost", {
      soundtrackSourceAvailable: true,
      readSoundtrackSet: () => Promise.resolve({ kind: "unavailable" }),
    });
    offerHome([pieceOf("piece", "Moonlit Étude")]);
    wishForControls();
    renderRow();
    await startMusic();
    expect(identity()).toBe("Moonlit Étude · Composed");

    act(() => {
      useSoundtrackStore.getState().setSetPiecesEnabled(false);
    });

    expect(useSoundtrackStore.getState().soundingTrack).toBeNull();
    expect(identity()).toBeNull();
    expect(buttonNames()).toEqual(NAMES);
  });
});
