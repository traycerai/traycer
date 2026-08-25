/**
 * The prevent-sleep row is hidden in the installed mobile app. The setting's
 * only consumer, `PreventSleepController`, holds an OS power-save blocker
 * through the desktop power bridge, and `resolveDesktopPowerBridge` returns
 * null there - so the switch would persist a preference nothing acts on while
 * its description promises the device stays awake.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { setMobileApp } from "@/lib/mobile-app";
import { PreventSleepSettingsSection } from "@/components/settings/prevent-sleep-settings-section";

afterEach(() => {
  cleanup();
  setMobileApp(false);
});

describe("PreventSleepSettingsSection", () => {
  it("renders nothing in the installed mobile app", () => {
    setMobileApp(true);
    render(<PreventSleepSettingsSection />);
    expect(
      screen.queryByRole("switch", { name: "Prevent sleep while running" }),
    ).toBeNull();
  });

  it("renders the toggle on other builds", () => {
    setMobileApp(false);
    render(<PreventSleepSettingsSection />);
    expect(
      screen.getByRole("switch", { name: "Prevent sleep while running" }),
    ).not.toBeNull();
  });
});
