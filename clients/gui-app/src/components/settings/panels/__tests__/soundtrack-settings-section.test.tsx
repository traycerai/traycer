/**
 * The Soundtrack rows of the Sounds page, through the real settings store and
 * the real soundtrack store (which follows it), behind a fake audio device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SoundtrackSettingsSection } from "@/components/settings/panels/soundtrack-settings-section";
import { setMobileApp } from "@/lib/mobile-app";
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

const DEV_MANIFEST = {
  trackNames: ["aquilo-1"],
  views: { home: ["aquilo-1"], task: [], bot: [], settings: [] },
  stems: { tracks: [] },
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
