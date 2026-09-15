/**
 * Onboarding landed as the second Application-group entry, directly after
 * General, which pushed every later digit along by one. Layout - the seventh
 * Application-group entry before Onboarding existed - is now the eighth
 * (desktop index 7, leader digit "8"). The knock-on effect lands on the
 * account group: Usage, which used to be the tenth entry (digit "0"), is now
 * the eleventh and sits exactly at `SINGLE_DIGIT_LEADER_INDEX_LIMIT` - so it
 * loses its leader-digit shortcut entirely - and `host` ("Overview") is
 * pushed one slot further still, past the limit rather than sitting at it.
 * This suite pins all of that against `visibleSettingsSections()`, the same
 * positional list the leader-digit dispatcher walks.
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
  it("offers onboarding directly after general on desktop", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const onboardingIndex = sections.findIndex(
      (section) => section.id === "onboarding",
    );
    expect(onboardingIndex).toBe(1);
    expect(singleDigitLeaderDigitFor(onboardingIndex)).toBe("2");
  });

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
    // Two slots earlier than on desktop: "keybindings" AND "onboarding" are
    // both omitted in the installed mobile app, and both sit ahead of layout
    // on desktop, so layout lands two positions sooner here.
    expect(ids.indexOf("layout")).toBe(5);
  });

  it("pushes host (Overview) to index 11, past the single-digit leader limit", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const hostIndex = sections.findIndex((section) => section.id === "host");
    expect(hostIndex).toBe(11);
    expect(hostIndex).toBeGreaterThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
  });

  it("gives the first SINGLE_DIGIT_LEADER_INDEX_LIMIT sections a typable digit", () => {
    for (let index = 0; index < SINGLE_DIGIT_LEADER_INDEX_LIMIT; index += 1) {
      // Every index in range resolves to a typable single digit ("1".."9", "0").
      expect(singleDigitLeaderDigitFor(index)).toMatch(/^[0-9]$/);
    }
  });

  it("pushes usage past the single-digit limit", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const usageIndex = sections.findIndex((section) => section.id === "usage");
    // Usage now sits exactly at the limit - one slot later than it used to, so
    // it has no leader digit at all rather than an untypable double digit.
    expect(usageIndex).toBe(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
  });
});
