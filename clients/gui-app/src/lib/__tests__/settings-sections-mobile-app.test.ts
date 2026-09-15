/**
 * The offered list differs from the table in BOTH directions, and the table
 * keeps every id either way, because ids resolve routes, remembered tab paths
 * and titles.
 *
 * Two sections the installed mobile app does not offer, for two different
 * reasons: Keybindings because chord capture reads `keydown` on `window` and a
 * touch shell can never commit one, and Link mobile app because the panel is the
 * DISPLAY end of a pairing whose scanner end is the mobile app itself.
 *
 * One section ONLY the installed mobile app offers: Delete account, which
 * exists to satisfy App Store review guideline 5.1.1(v). Desktop and the web
 * GUI are not under that rule and manage the account on the web, so the row is
 * theirs to not have - and `/settings/delete-account` redirects there, which is
 * what `isSettingsSectionVisible` is asked in that route's `beforeLoad`.
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
  it("offers every section but the mobile-only one on other builds", () => {
    setMobileApp(false);
    const ids = visibleSettingsSections().map((section) => section.id);
    expect(ids).toEqual(
      SETTINGS_SECTIONS.map((section) => section.id).filter(
        (id) => id !== "delete-account",
      ),
    );
    expect(isSettingsSectionVisible("keybindings")).toBe(true);
    expect(isSettingsSectionVisible("link-phone")).toBe(true);
    expect(isSettingsSectionVisible("delete-account")).toBe(false);
  });

  // Identity, not just equality: consumers memoize on this list and compare it
  // by reference. It used to be `SETTINGS_SECTIONS` itself on non-mobile
  // builds, which gave this for free; now that both builds drop something, the
  // guarantee comes from each list being resolved once at module load.
  it("returns one stable list per build", () => {
    setMobileApp(false);
    expect(visibleSettingsSections()).toBe(visibleSettingsSections());
    setMobileApp(true);
    expect(visibleSettingsSections()).toBe(visibleSettingsSections());
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

  it("offers delete-account only in the installed mobile app", () => {
    setMobileApp(true);
    const ids = visibleSettingsSections().map((section) => section.id);
    expect(ids).toContain("delete-account");
    expect(isSettingsSectionVisible("delete-account")).toBe(true);
    // In the Account group, and last in it: the group must stay contiguous
    // (the sidebar renders one heading per run), and this is its one
    // irreversible action.
    const account = visibleSettingsSections().filter(
      (section) => section.group === "account",
    );
    expect(account.at(-1)?.id).toBe("delete-account");
  });

  it("drops nothing else in the installed mobile app", () => {
    setMobileApp(true);
    const ids = visibleSettingsSections().map((section) => section.id);
    const expected = SETTINGS_SECTIONS.map((section) => section.id).filter(
      (id) => id !== "keybindings" && id !== "link-phone",
    );
    expect(ids).toEqual(expected);
  });

  it("keeps every section in the resolver table so its id still resolves", () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    setMobileApp(true);
    expect(ids).toContain("keybindings");
    expect(ids).toContain("link-phone");
    setMobileApp(false);
    expect(ids).toContain("delete-account");
  });
});
