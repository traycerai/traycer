/**
 * Bringing a soundtrack the person left on back on their next gesture, through
 * the real settings store, the real soundtrack store and the real gesture
 * listener, behind a fake audio device.
 *
 * A build with tracks, as production will be, rather than a development build:
 * its `enable()` opens the device in the gesture's own call, so that a case
 * asserting nothing opened is deciding that, and not reading the state before a
 * dynamic import and a fetch have had their turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SoundtrackWarmupBridge } from "@/components/layout/bridges/soundtrack-signals-bridge";
import { SoundtrackControl } from "@/components/layout/soundtrack/soundtrack-control";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  openedFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

const build = vi.hoisted(() => ({ hasTracks: true }));

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => build.hasTracks,
}));

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
  return { openWebAudioPorts: openFakePorts };
});

function press(): void {
  act(() => {
    window.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
}

function key(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
  });
}

beforeEach(() => {
  build.hasTracks = true;
  resetFakePorts();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  useSoundtrackStore.getState().disable();
});

describe("the soundtrack warm-up", () => {
  it.each([
    ["key", key],
    ["press", press],
  ])("opens the session on the first %s, not before", (_label, gesture) => {
    useSettingsStore.setState({ soundtrackEnabled: true });
    render(<SoundtrackWarmupBridge />);
    expect(openedFakePorts).toHaveLength(0);

    gesture();

    expect(openedFakePorts).toHaveLength(1);
    expect(useSoundtrackStore.getState().enabled).toBe(true);
  });

  it("arms nothing without a wish", () => {
    render(<SoundtrackWarmupBridge />);
    press();
    key();
    expect(openedFakePorts).toHaveLength(0);
  });

  it("arms nothing in a build with nothing to play, whatever a past build left set", () => {
    build.hasTracks = false;
    useSettingsStore.setState({ soundtrackEnabled: true });
    render(<SoundtrackWarmupBridge />);
    press();
    expect(openedFakePorts).toHaveLength(0);
  });

  it("does not open for a wish another window turned off after this one armed", () => {
    useSettingsStore.setState({ soundtrackEnabled: true });
    render(<SoundtrackWarmupBridge />);

    // Another window's write arrives through rehydration as a plain setState.
    act(() => {
      useSettingsStore.setState({ soundtrackEnabled: false });
    });
    press();

    expect(openedFakePorts).toHaveLength(0);
  });

  it("is not armed by another window turning the soundtrack on", () => {
    render(<SoundtrackWarmupBridge />);

    act(() => {
      useSettingsStore.setState({ soundtrackEnabled: true });
    });
    press();

    expect(openedFakePorts).toHaveLength(0);
  });

  it("comes back on the next gesture when a session ends with the wish still set", () => {
    useSettingsStore.setState({ soundtrackEnabled: true });
    render(<SoundtrackWarmupBridge />);
    press();
    expect(openedFakePorts).toHaveLength(1);

    // What another account taking over the window does.
    act(() => {
      useSoundtrackStore.getState().disable();
    });
    expect(openedFakePorts).toHaveLength(1);

    press();
    expect(openedFakePorts).toHaveLength(2);
  });

  it("ends with the soundtrack off when the first press lands on the toggle", async () => {
    useSettingsStore.setState({ soundtrackEnabled: true });
    render(
      <TooltipProvider>
        <SoundtrackWarmupBridge />
        <SoundtrackControl />
      </TooltipProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Soundtrack" }));

    // The press opened the device and its click, the same gesture, closed it.
    expect(openedFakePorts).toHaveLength(1);
    expect(openedFakePorts[0].close).toHaveBeenCalledTimes(1);
    expect(useSoundtrackStore.getState().enabled).toBe(false);
    expect(useSettingsStore.getState().soundtrackEnabled).toBe(false);
  });
});
