/**
 * Two sections are not offered in the installed mobile app, for two different
 * reasons: Keybindings because chord capture reads `keydown` on `window` and a
 * touch shell can never commit one, and Link a phone because the panel is the
 * DISPLAY end of a pairing whose scanner end is the mobile app itself.
 *
 * The table itself keeps both, because ids resolve routes, remembered tab
 * paths and titles; only the OFFERED list drops them.
 */
import { afterEach, describe, expect, it } from "vitest";

import { setMobileApp } from "@/lib/mobile-app";
import {
  SETTINGS_SECTIONS,
  isSettingsSectionVisible,
  visibleSettingsSections,
} from "@/lib/settings-sections";

afterEach(() => {
  setMobileApp(false);
});

describe("visibleSettingsSections", () => {
  it("offers every section on other builds", () => {
    setMobileApp(false);
    // Identity, not just equality: consumers memoize on this list.
    expect(visibleSettingsSections()).toBe(SETTINGS_SECTIONS);
    expect(isSettingsSectionVisible("keybindings")).toBe(true);
    expect(isSettingsSectionVisible("link-phone")).toBe(true);
  });

  it("omits keybindings in the installed mobile app", () => {
    setMobileApp(true);
    const ids = visibleSettingsSections().map((section) => section.id);
    expect(ids).not.toContain("keybindings");
    expect(isSettingsSectionVisible("keybindings")).toBe(false);
  });

  it("omits link-phone in the installed mobile app", () => {
    setMobileApp(true);
    const ids = visibleSettingsSections().map((section) => section.id);
    expect(ids).not.toContain("link-phone");
    expect(isSettingsSectionVisible("link-phone")).toBe(false);
  });

  it("drops nothing else in the installed mobile app", () => {
    setMobileApp(true);
    const ids = visibleSettingsSections().map((section) => section.id);
    const expected = SETTINGS_SECTIONS.map((section) => section.id).filter(
      (id) => id !== "keybindings" && id !== "link-phone",
    );
    expect(ids).toEqual(expected);
  });

  it("keeps both sections in the resolver table so their ids still resolve", () => {
    setMobileApp(true);
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(ids).toContain("keybindings");
    expect(ids).toContain("link-phone");
  });
});
