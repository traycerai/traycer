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
import type { SoundtrackManifest } from "@/lib/soundtrack/manifest";
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
  readSoundtrackManifest: () => MANIFEST,
}));

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts: open } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
  return { openWebAudioPorts: open };
});

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

  describe("with another window holding the session", () => {
    it("draws none for a window waiting on the lock, and draws them again when it takes it", async () => {
      wishForControls();
      const other = createSoundtrackStore({
        readManifest: () => MANIFEST,
        openPorts: openFakePorts,
        random: () => 0,
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
