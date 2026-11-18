/**
 * The voice row is hidden in the installed mobile app, where the build refuses
 * dictation outright (`useDictationAvailability`). A toggle for a feature the
 * build will not perform is worse than no toggle - and its description promises
 * on-device transcription the mobile app cannot deliver, since every host it
 * reaches is a remote machine.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { setMobileApp } from "@/lib/mobile-app";
import { VoiceSettingsSection } from "@/components/settings/voice-settings-section";

afterEach(() => {
  cleanup();
  setMobileApp(false);
});

describe("VoiceSettingsSection", () => {
  it("renders nothing in the installed mobile app", () => {
    setMobileApp(true);
    render(<VoiceSettingsSection />);
    expect(screen.queryByRole("switch", { name: "Voice input" })).toBeNull();
  });

  it("renders the toggle on other builds", () => {
    setMobileApp(false);
    render(<VoiceSettingsSection />);
    expect(screen.getByRole("switch", { name: "Voice input" })).not.toBeNull();
  });
});
