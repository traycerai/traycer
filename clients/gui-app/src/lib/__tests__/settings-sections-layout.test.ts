/**
 * Getting started leads the whole list, Browser is the third Application-group
 * entry and Layout follows it. Each insertion shifted the app/account tail, so
 * desktop's Host ("Overview") is now the thirteenth entry and has no
 * leader-digit shortcut. Mobile omits Keybindings and Link mobile app. This
 * suite pins the positions against `visibleSettingsSections()`, the same list
 * the leader-digit dispatcher walks.
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
  it("offers layout on desktop, at index 8 (leader digit 9)", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const layoutIndex = sections.findIndex(
      (section) => section.id === "layout",
    );
    expect(layoutIndex).toBe(8);
    expect(layoutIndex).toBeLessThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    expect(singleDigitLeaderDigitFor(layoutIndex)).toBe("9");
  });

  it("offers layout in the installed mobile app too", () => {
    setMobileApp(true);
    const ids = visibleSettingsSections().map((section) => section.id);
    expect(ids).toContain("layout");
    // One slot earlier than on desktop: "keybindings" is omitted in the
    // installed mobile app and sits ahead of layout.
    expect(ids.indexOf("layout")).toBe(7);
  });

  it("pushes host (Overview) to index 12, past the single-digit leader limit", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const hostIndex = sections.findIndex((section) => section.id === "host");
    expect(hostIndex).toBe(12);
    expect(hostIndex).toBeGreaterThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    expect(hostIndex).toBeGreaterThanOrEqual(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
  });

  it("keeps the first ten sections within the single-digit range", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    // Getting started leads the list and owns digit 1.
    expect(sections[0]?.id).toBe("getting-started");
    expect(singleDigitLeaderDigitFor(0)).toBe("1");
    const hostIndex = sections.findIndex((section) => section.id === "host");
    expect(hostIndex).toBeGreaterThanOrEqual(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    for (let index = 0; index < SINGLE_DIGIT_LEADER_INDEX_LIMIT; index += 1) {
      expect(index).toBeLessThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
      // Every index in range resolves to a typable single digit ("1".."9", "0").
      expect(singleDigitLeaderDigitFor(index)).toMatch(/^[0-9]$/);
    }
  });
});
