/**
 * The prevent-sleep row is shown only where the shell installs a power bridge.
 *
 * The setting's only consumer, `PreventSleepController`, holds an OS
 * power-save blocker through that bridge. Without it the switch would persist
 * a preference nothing acts on while its description promises the device stays
 * awake - so the row is keyed on the same `resolveDesktopPowerBridge` the
 * controller resolves, feature-detected because `power` is a duck-typed extra
 * rather than a typed `IRunnerHost` field.
 *
 * Asserted per shell, with the answers written out rather than derived from
 * the fixture's own bridge field: the gate used to key on the mobile product
 * flag, which a browser shell (phone capabilities, desktop product flag)
 * breaks.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { setMobileApp } from "@/lib/mobile-app";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { PreventSleepSettingsSection } from "@/components/settings/prevent-sleep-settings-section";
import { shellSurfaces } from "../../../../__tests__/shell-surfaces";

const PREVENT_SLEEP_ROW_SHOWN: ReadonlyMap<string, boolean> = new Map([
  ["desktop", true],
  ["installed mobile", false],
  ["webapp", false],
  ["browser dev", false],
]);

afterEach(() => {
  cleanup();
  setMobileApp(false);
});

describe("PreventSleepSettingsSection", () => {
  it("has an expectation for every shell that mounts the app", () => {
    expect(
      shellSurfaces()
        .map((surface) => surface.name)
        .sort(),
    ).toEqual([...PREVENT_SLEEP_ROW_SHOWN.keys()].sort());
  });

  describe.each(shellSurfaces())("on $name", (surface) => {
    it("shows the toggle only where something can act on it", () => {
      setMobileApp(surface.mobileApp);
      render(
        <RunnerHostProvider runnerHost={surface.runnerHost}>
          <PreventSleepSettingsSection />
        </RunnerHostProvider>,
      );
      const toggle = screen.queryByRole("switch", {
        name: "Prevent sleep while running",
      });
      expect(toggle !== null).toBe(PREVENT_SLEEP_ROW_SHOWN.get(surface.name));
    });
  });
});
