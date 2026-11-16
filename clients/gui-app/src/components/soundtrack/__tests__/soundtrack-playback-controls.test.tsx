/**
 * Where the window's one set of music controls is drawn, and what it names,
 * through the real component, settings and soundtrack stores, actions and
 * session behind a fake audio device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { TabSurfaceActivityContext } from "@/components/layout/tab-surface-activity-context";
import { SoundtrackPageControlsContext } from "@/components/soundtrack/soundtrack-page-controls-context";
import { SoundtrackPlaybackControls } from "@/components/soundtrack/soundtrack-playback-controls";
import { makeAudioBuffer } from "@/lib/soundtrack/__tests__/audio-buffer";
import { FakeLockManager } from "@/lib/soundtrack/__tests__/fake-locks";
import { resetFakePorts } from "@/lib/soundtrack/__tests__/fake-ports";
import { playbackTrack } from "@/lib/soundtrack/__tests__/playback-track";
import type { SoundtrackManifest } from "@/lib/soundtrack/manifest";
import type { MixSignals } from "@/lib/soundtrack/signals";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

const MANIFEST: SoundtrackManifest = {
  tracks: [
    { ...playbackTrack("one", 60), title: "Slow Tide" },
    {
      kind: "composed",
      name: "piece",
      title: "Moonlit Étude",
      recording: "master",
    },
  ],
  views: { home: ["one", "piece"], task: [], bot: [], settings: [] },
  stems: { tracks: [], recordings: [{ name: "master", file: "piece.opus" }] },
};

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => true,
  readSoundtrackManifest: () => MANIFEST,
}));

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts: open } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
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

const HOME: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};

async function advance(seconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1000);
  });
}

function groups(): HTMLElement[] {
  return screen.queryAllByRole("group", { name: "Music playback" });
}

function titles(): string[] {
  return screen
    .queryAllByTestId("epic-playback-track")
    .map((label) => label.textContent);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetFakePorts();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: new FakeLockManager(),
  });
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useSettingsStore.setState({
    soundtrackEnabled: true,
    soundtrackPlaybackControls: true,
  });
});

afterEach(() => {
  cleanup();
  useSoundtrackStore.getState().disable();
  Reflect.deleteProperty(navigator, "locks");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("where the music controls are drawn", () => {
  it("draws the page placement on a focused, visible surface", () => {
    render(<SoundtrackPlaybackControls placement="surface" />);

    expect(groups()).toHaveLength(1);
  });

  it("leaves a surface that is hidden or not focused to the one that is", () => {
    for (const activity of [
      { visible: false, focused: true },
      { visible: true, focused: false },
    ]) {
      const { unmount } = render(
        <TabSurfaceActivityContext value={activity}>
          <SoundtrackPlaybackControls placement="surface" />
        </TabSurfaceActivityContext>,
      );
      expect(groups()).toHaveLength(0);
      unmount();
    }
  });

  it("gives the controls to the Settings modal alone while it is open, even over a hidden surface", () => {
    render(
      <SoundtrackPageControlsContext value={false}>
        <SoundtrackPlaybackControls placement="task" />
        <SoundtrackPlaybackControls placement="surface" />
        <TabSurfaceActivityContext value={{ visible: false, focused: false }}>
          <SoundtrackPlaybackControls placement="settings-modal" />
        </TabSurfaceActivityContext>
      </SoundtrackPageControlsContext>,
    );

    expect(groups()).toHaveLength(1);
  });

  it("draws none for any placement with the option off", () => {
    useSettingsStore.setState({ soundtrackPlaybackControls: false });
    render(
      <>
        <SoundtrackPlaybackControls placement="task" />
        <SoundtrackPlaybackControls placement="surface" />
        <SoundtrackPlaybackControls placement="settings-modal" />
      </>,
    );

    expect(groups()).toHaveLength(0);
  });
});

describe("what the controls name as the music moves on", () => {
  it("names one title through Next, Pause and Previous in the Settings modal over a page that has given the controls up", async () => {
    render(
      <SoundtrackPageControlsContext value={false}>
        <SoundtrackPlaybackControls placement="settings-modal" />
      </SoundtrackPageControlsContext>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    await advance(0);
    act(() => {
      useSoundtrackStore.getState().setSignals(HOME);
    });
    await advance(1);
    const first = titles()[0];
    expect([
      "Slow Tide · Generative variant",
      "Moonlit Étude · Composed",
    ]).toContain(first);

    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    const second = titles()[0];
    expect(second).not.toBe(first);
    expect(screen.getAllByText(second.split(" · ")[0])).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await advance(30);
    expect(titles()).toEqual([second]);

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous track" }));
    expect(titles()).toEqual([first]);
  });
});
