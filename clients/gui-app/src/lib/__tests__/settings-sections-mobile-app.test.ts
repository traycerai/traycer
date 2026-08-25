/**
 * Keybindings is not offered in the installed mobile app: chord capture reads
 * `keydown` on `window`, a binding commits on the next full chord and clears
 * only with Backspace, so on a touch shell the chip arms and can never resolve.
 *
 * The table itself keeps the section, because ids resolve routes, remembered
 * tab paths and titles; only the OFFERED list drops it.
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
  });

  it("omits keybindings in the installed mobile app", () => {
    setMobileApp(true);
    const ids = visibleSettingsSections().map((section) => section.id);
    expect(ids).not.toContain("keybindings");
    expect(isSettingsSectionVisible("keybindings")).toBe(false);
  });

  it("drops nothing else in the installed mobile app", () => {
    setMobileApp(true);
    const ids = visibleSettingsSections().map((section) => section.id);
    const expected = SETTINGS_SECTIONS.map((section) => section.id).filter(
      (id) => id !== "keybindings",
    );
    expect(ids).toEqual(expected);
  });

  it("keeps the section in the resolver table so its id still resolves", () => {
    setMobileApp(true);
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(ids).toContain("keybindings");
  });
});
