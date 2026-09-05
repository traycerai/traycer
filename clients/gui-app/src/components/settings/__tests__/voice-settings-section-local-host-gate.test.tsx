/**
 * The voice row is shown only where the shell has a LOCAL host.
 *
 * `useDictationAvailability` refuses dictation outright without one, so
 * anywhere else this row would be a toggle for something the shell will not
 * do - and its description promises on-device transcription that a shell whose
 * every reachable host is another machine cannot deliver.
 *
 * The gate used to key on the mobile PRODUCT flag, which happened to coincide
 * on the only two shells that existed. Every surface is asserted separately
 * here because that coincidence is exactly what a browser shell breaks: it
 * has the phone's capabilities and the desktop's product flag.
 *
 * The expected answers are written out per shell rather than derived from the
 * fixture's own capability fields - a table computed from the gate's input
 * would agree with whatever the gate does.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { setMobileApp } from "@/lib/mobile-app";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { VoiceSettingsSection } from "@/components/settings/voice-settings-section";
import { shellSurfaces } from "../../../../__tests__/shell-surfaces";

const VOICE_ROW_SHOWN: ReadonlyMap<string, boolean> = new Map([
  ["desktop", true],
  ["installed mobile", false],
  ["webapp", false],
  ["browser dev", false],
]);

afterEach(() => {
  cleanup();
  setMobileApp(false);
});

describe("VoiceSettingsSection", () => {
  it("has an expectation for every shell that mounts the app", () => {
    expect(
      shellSurfaces()
        .map((surface) => surface.name)
        .sort(),
    ).toEqual([...VOICE_ROW_SHOWN.keys()].sort());
  });

  describe.each(shellSurfaces())("on $name", (surface) => {
    it("shows the toggle only where dictation can be honoured", () => {
      setMobileApp(surface.mobileApp);
      render(
        <RunnerHostProvider runnerHost={surface.runnerHost}>
          <VoiceSettingsSection />
        </RunnerHostProvider>,
      );
      const toggle = screen.queryByRole("switch", { name: "Voice input" });
      expect(toggle !== null).toBe(VOICE_ROW_SHOWN.get(surface.name));
    });
  });
});
