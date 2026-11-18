/**
 * The prevent-sleep row is hidden in the installed mobile app. The setting's
 * only consumer, `PreventSleepController`, holds an OS power-save blocker
 * through the desktop power bridge, and `resolveDesktopPowerBridge` returns
 * null there - so the switch would persist a preference nothing acts on while
 * its description promises the device stays awake.
 *
 * It is one row of General ▸ Agents: the component returns the row alone and
 * the panel draws the group, so hiding the row does not leave a heading over
 * an empty card.
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
    expect(screen.queryByText("Running agents")).toBeNull();
    expect(screen.queryByText("Prevent sleep while running")).toBeNull();
  });

  it("renders the toggle as a row without its own group heading on other builds", () => {
    setMobileApp(false);
    render(<PreventSleepSettingsSection />);
    expect(
      screen.getByRole("switch", { name: "Prevent sleep while running" }),
    ).not.toBeNull();
    expect(screen.getByText("Prevent sleep while running")).not.toBeNull();
    expect(
      screen.queryByRole("heading", { level: 2, name: "Running agents" }),
    ).toBeNull();
  });
});
