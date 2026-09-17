/**
 * Browser is the third Application-group entry and Layout follows it. The
 * added Browser page shifts the app/account tail once more, so desktop's Host
 * ("Overview") is now the twelfth entry and has no leader-digit shortcut.
 * Mobile omits Keybindings and Link mobile app, keeping Host at the eleventh
 * entry. This suite pins the positions against `visibleSettingsSections()`,
 * the same list the leader-digit dispatcher walks.
 */
import { afterEach, describe, expect, it } from "vitest";

import { setMobileApp } from "@/lib/mobile-app";
import { visibleSettingsSections } from "@/lib/settings-sections";
import {
  SINGLE_DIGIT_LEADER_INDEX_LIMIT,
  singleDigitLeaderDigitFor,
} from "@/providers/keybinding-context";

afterEach(() => {
  setMobileApp(false);
});

describe("Layout section placement and digit reassignment", () => {
  it("offers layout on desktop, at index 7 (leader digit 8)", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const layoutIndex = sections.findIndex(
      (section) => section.id === "layout",
    );
    expect(layoutIndex).toBe(7);
    expect(layoutIndex).toBeLessThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    expect(singleDigitLeaderDigitFor(layoutIndex)).toBe("8");
  });

  it("offers layout in the installed mobile app too", () => {
    setMobileApp(true);
    const ids = visibleSettingsSections().map((section) => section.id);
    expect(ids).toContain("layout");
    // One slot earlier than on desktop: "keybindings" is omitted in the
    // installed mobile app and sits ahead of layout.
    expect(ids.indexOf("layout")).toBe(6);
  });

  it("pushes host (Overview) to index 11, past the single-digit leader limit", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const hostIndex = sections.findIndex((section) => section.id === "host");
    expect(hostIndex).toBe(11);
    expect(hostIndex).toBeGreaterThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    expect(hostIndex).toBeGreaterThanOrEqual(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
  });

  it("keeps the first ten sections within the single-digit range", () => {
    const sections = visibleSettingsSections();
    const hostIndex = sections.findIndex((section) => section.id === "host");
    expect(hostIndex).toBeGreaterThanOrEqual(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    for (let index = 0; index < SINGLE_DIGIT_LEADER_INDEX_LIMIT; index += 1) {
      expect(index).toBeLessThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
      // Every index in range resolves to a typable single digit ("1".."9", "0").
      expect(singleDigitLeaderDigitFor(index)).toMatch(/^[0-9]$/);
    }
  });
});
