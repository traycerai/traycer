/**
 * The toggle through the REAL soundtrack store and settings store, behind a
 * fake audio device. `soundtrackOffered()` is false under vitest's MODE, so
 * each case that needs a control turns the development build on, which also
 * routes `enable()` through the dev manifest's fetch (answered here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  openedFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";
import { SoundtrackControl } from "../soundtrack-control";

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
  return { openWebAudioPorts: openFakePorts };
});

const EMPTY_DEV_MANIFEST = {
  trackNames: [],
  views: { home: [], task: [], bot: [], settings: [] },
  stems: { tracks: [] },
};

function offer(): void {
  vi.stubEnv("MODE", "development");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(EMPTY_DEV_MANIFEST))),
  );
}

function renderControl(): void {
  render(
    <TooltipProvider>
      <SoundtrackControl />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  resetFakePorts();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  useSoundtrackStore.getState().disable();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the soundtrack control", () => {
  it("opens a session on a press and ends it on the press off", async () => {
    offer();
    renderControl();
    const button = screen.getByRole("button", { name: "Soundtrack" });

    await userEvent.click(button);
    await vi.waitFor(() => {
      expect(openedFakePorts).toHaveLength(1);
    });
    expect(useSoundtrackStore.getState().enabled).toBe(true);

    await userEvent.click(button);
    expect(useSoundtrackStore.getState().enabled).toBe(false);
    expect(openedFakePorts[0].close).toHaveBeenCalledTimes(1);
  });

  it("follows the wish in aria-pressed", async () => {
    offer();
    renderControl();
    const button = screen.getByRole("button", { name: "Soundtrack" });
    expect(button.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("opens the device at the volume the person set", async () => {
    offer();
    useSettingsStore.getState().setSoundtrackVolume(0.8);
    renderControl();

    await userEvent.click(screen.getByRole("button", { name: "Soundtrack" }));
    await vi.waitFor(() => {
      expect(openedFakePorts).toHaveLength(1);
    });
    expect(openedFakePorts[0].volumeAtOpen).toBe(0.8);
  });

  it("is not drawn in a build with nothing to play", () => {
    renderControl();
    expect(screen.queryByRole("button", { name: "Soundtrack" })).toBeNull();
  });
});
