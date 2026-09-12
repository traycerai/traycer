import { describe, expect, it } from "vitest";
import {
  isMobileFooterRowAvailable,
  isStatusBarControlsAvailable,
  isStatusBarPlacementAvailable,
  type SettingsAvailabilityContext,
} from "@/lib/settings/settings-availability";

const DESKTOP: SettingsAvailabilityContext = {
  runnerHost: null,
  featureSettings: null,
  mobileApp: false,
  mobileFooter: false,
};

const MOBILE_APP: SettingsAvailabilityContext = { ...DESKTOP, mobileApp: true };

/**
 * The three Layout ▸ Status bar gates, which differ only in what they do with
 * the mobile footer - and that is the whole point: one predicate widens with
 * the switch, one is the switch, and one deliberately does not move.
 */
describe("status bar availability", () => {
  it("keeps every footer control on a desktop build, whatever the switch says", () => {
    // `mobileFooter` is a preference about a viewport this build answers with
    // `placement` instead, so it decides nothing here.
    for (const mobileFooter of [false, true]) {
      const context = { ...DESKTOP, mobileFooter };
      expect(isStatusBarControlsAvailable(context)).toBe(true);
      expect(isStatusBarPlacementAvailable(context)).toBe(true);
      expect(isMobileFooterRowAvailable(context)).toBe(false);
    }
  });

  it("withholds the footer controls in the installed mobile app until the switch is on", () => {
    expect(isStatusBarControlsAvailable(MOBILE_APP)).toBe(false);
    expect(
      isStatusBarControlsAvailable({ ...MOBILE_APP, mobileFooter: true }),
    ).toBe(true);
  });

  it("never gives that build the placement segment back", () => {
    // The mobile header keeps the gauge and the resource monitor whatever the
    // strip does, so there is no second surface for the segment to name - and
    // a search result for a row the phone will not draw lands nowhere.
    for (const mobileFooter of [false, true]) {
      expect(
        isStatusBarPlacementAvailable({ ...MOBILE_APP, mobileFooter }),
      ).toBe(false);
    }
  });

  it("offers the switch in both of that build's states", () => {
    // It is the control that flips the gate above, so a predicate that went
    // away with the rows it governs would leave no way back.
    for (const mobileFooter of [false, true]) {
      expect(isMobileFooterRowAvailable({ ...MOBILE_APP, mobileFooter })).toBe(
        true,
      );
    }
  });
});
