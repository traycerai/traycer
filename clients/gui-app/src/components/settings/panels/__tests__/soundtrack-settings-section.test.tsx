/**
 * The Soundtrack rows of the Sounds page, through the real settings store and
 * the real soundtrack store (which follows it), behind a fake audio device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SoundtrackSettingsSection } from "@/components/settings/panels/soundtrack-settings-section";
import { setMobileApp } from "@/lib/mobile-app";
import { AQUILO_1 } from "@/lib/soundtrack/__tests__/aquilo-1";
import {
  openedFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
  return { openWebAudioPorts: openFakePorts };
});

/** One stem path per variant, as the v1 schema requires of every layer. */
function files(layer: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `stems/aquilo-1/${layer}-${String(index + 1)}.ogg`,
  );
}

const DEV_MANIFEST = {
  version: 1,
  tracks: [AQUILO_1],
  views: { home: ["aquilo-1"], task: [], bot: [], settings: [] },
  stems: {
    tracks: [
      {
        name: "aquilo-1",
        // Every aquilo-1 layer is pooled, so each has a variant count.
        layers: AQUILO_1.layers.map((layer) => ({
          name: layer.name,
          files: files(layer.name, layer.variants ?? 0),
        })),
      },
    ],
  },
};

beforeEach(() => {
  resetFakePorts();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  vi.stubEnv("MODE", "development");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(DEV_MANIFEST))),
  );
});

afterEach(() => {
  cleanup();
  setMobileApp(false);
  useSoundtrackStore.getState().disable();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function openSession(): Promise<void> {
  useSoundtrackStore.getState().enable();
  await vi.waitFor(() => {
    expect(openedFakePorts).toHaveLength(1);
  });
}

describe("the soundtrack settings rows", () => {
  describe("the Music switch", () => {
    it("turns the soundtrack on from a click, and off from the next", async () => {
      render(<SoundtrackSettingsSection />);
      const music = screen.getByRole("switch", { name: "Music" });
      expect(music.getAttribute("aria-checked")).toBe("false");

      await userEvent.click(music);
      expect(useSettingsStore.getState().soundtrackEnabled).toBe(true);
      expect(music.getAttribute("aria-checked")).toBe("true");
      await vi.waitFor(() => {
        expect(openedFakePorts).toHaveLength(1);
      });
      expect(useSoundtrackStore.getState().enabled).toBe(true);

      await userEvent.click(music);
      expect(useSettingsStore.getState().soundtrackEnabled).toBe(false);
      expect(useSoundtrackStore.getState().enabled).toBe(false);
      expect(openedFakePorts[0].close).toHaveBeenCalledTimes(1);
    });

    it("shows a persisted on as checked", () => {
      useSettingsStore.setState({ soundtrackEnabled: true });
      render(<SoundtrackSettingsSection />);

      expect(
        screen
          .getByRole("switch", { name: "Music" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    it("leaves Volume and Follows drawn and editable while it is off", async () => {
      render(<SoundtrackSettingsSection />);
      expect(useSettingsStore.getState().soundtrackEnabled).toBe(false);
      const before = useSettingsStore.getState().soundtrackVolume;

      screen.getByRole("slider", { name: "Soundtrack volume" }).focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(useSettingsStore.getState().soundtrackVolume).toBeGreaterThan(
        before,
      );

      await userEvent.click(
        screen.getByRole("combobox", { name: "What the soundtrack follows" }),
      );
      await userEvent.click(
        screen.getByRole("option", { name: "Page, alerts and agents" }),
      );
      expect(useSettingsStore.getState().soundtrackDirector).toBe("rules");
    });
  });

  describe("the Playback controls switch", () => {
    const controls = () =>
      screen.queryByRole("switch", { name: "Playback controls" });

    it("is not drawn while Music is off", () => {
      render(<SoundtrackSettingsSection />);

      expect(controls()).toBeNull();
    });

    it("is drawn directly under Music while it is on, off by default", () => {
      useSettingsStore.setState({ soundtrackEnabled: true });
      render(<SoundtrackSettingsSection />);

      expect(
        screen
          .getAllByRole("switch")
          .map((el) => el.getAttribute("aria-label")),
      ).toEqual(["Music", "Playback controls"]);
      expect(controls()?.getAttribute("aria-checked")).toBe("false");
      expect(useSettingsStore.getState().soundtrackPlaybackControls).toBe(
        false,
      );
    });

    it("keeps its value while Music is off and on again", async () => {
      render(<SoundtrackSettingsSection />);
      const music = screen.getByRole("switch", { name: "Music" });
      await userEvent.click(music);
      await userEvent.click(
        screen.getByRole("switch", { name: "Playback controls" }),
      );
      expect(useSettingsStore.getState().soundtrackPlaybackControls).toBe(true);

      await userEvent.click(music);
      expect(controls()).toBeNull();
      expect(useSettingsStore.getState().soundtrackPlaybackControls).toBe(true);

      await userEvent.click(music);
      expect(controls()?.getAttribute("aria-checked")).toBe("true");
    });

    it("plays a paused soundtrack when it is turned off, and keeps Music on", async () => {
      useSettingsStore.setState({
        soundtrackEnabled: true,
        soundtrackPlaybackControls: true,
        soundtrackPaused: true,
      });
      render(<SoundtrackSettingsSection />);

      await userEvent.click(
        screen.getByRole("switch", { name: "Playback controls" }),
      );

      expect(useSettingsStore.getState()).toMatchObject({
        soundtrackEnabled: true,
        soundtrackPlaybackControls: false,
        soundtrackPaused: false,
      });
    });

    it("is not drawn in the installed app, with Music on", () => {
      useSettingsStore.setState({ soundtrackEnabled: true });
      setMobileApp(true);
      render(<SoundtrackSettingsSection />);

      expect(controls()).toBeNull();
    });
  });

  it("moves the open device's volume with nothing reopened", async () => {
    render(<SoundtrackSettingsSection />);
    await openSession();
    const before = useSettingsStore.getState().soundtrackVolume;

    const thumb = screen.getByRole("slider", { name: "Soundtrack volume" });
    thumb.focus();
    await userEvent.keyboard("{ArrowRight}");

    const after = useSettingsStore.getState().soundtrackVolume;
    expect(after).toBeGreaterThan(before);
    expect(openedFakePorts).toHaveLength(1);
    expect(openedFakePorts[0].setVolume).toHaveBeenLastCalledWith(after);
  });

  it("re-plans the running session when the director changes", async () => {
    render(<SoundtrackSettingsSection />);
    await openSession();
    useSoundtrackStore.getState().setSignals({
      view: "home",
      working: 0,
      blocking: 0,
      failure: 1,
      done: 0,
    });
    // The static director never dims; the rules director dims under a failure.
    expect(useSoundtrackStore.getState().lastPlan?.dim).toBe(false);

    await userEvent.click(
      screen.getByRole("combobox", { name: "What the soundtrack follows" }),
    );
    await userEvent.click(
      screen.getByRole("option", { name: "Page, alerts and agents" }),
    );

    expect(useSettingsStore.getState().soundtrackDirector).toBe("rules");
    expect(useSoundtrackStore.getState().directorId).toBe("rules");
    expect(useSoundtrackStore.getState().lastPlan?.dim).toBe(true);
    expect(openedFakePorts).toHaveLength(1);
  });

  it("draws neither row in a build with nothing to play", () => {
    vi.unstubAllEnvs();
    render(<SoundtrackSettingsSection />);

    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("draws neither row in the installed app, with something to play", () => {
    setMobileApp(true);
    render(<SoundtrackSettingsSection />);

    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
