/**
 * The Layout section landed as the seventh Application-group entry, which
 * pushed every host-group section one slot later. That is a digit
 * reassignment, not just a new row: `host` ("Overview") used to be the tenth
 * entry (digit "0") and is now the eleventh, past
 * `SINGLE_DIGIT_LEADER_INDEX_LIMIT` — so it lost its leader-digit shortcut
 * entirely. This suite pins both facts against `visibleSettingsSections()`,
 * the same positional list the leader-digit dispatcher walks.
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
  it("offers layout on desktop, at index 6 (leader digit 7)", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const layoutIndex = sections.findIndex(
      (section) => section.id === "layout",
    );
    expect(layoutIndex).toBe(6);
    expect(layoutIndex).toBeLessThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    expect(singleDigitLeaderDigitFor(layoutIndex)).toBe("7");
  });

  it("offers layout in the installed mobile app too", () => {
    setMobileApp(true);
    const ids = visibleSettingsSections().map((section) => section.id);
    expect(ids).toContain("layout");
    // One slot earlier than on desktop: "keybindings" (index 4 on desktop)
    // is omitted in the installed mobile app and sits ahead of layout.
    expect(ids.indexOf("layout")).toBe(5);
  });

  it("pushes host (Overview) to index 10, past the single-digit leader limit", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const hostIndex = sections.findIndex((section) => section.id === "host");
    expect(hostIndex).toBe(10);
    expect(hostIndex).toBe(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    expect(hostIndex).toBeGreaterThanOrEqual(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
  });

  it("keeps every section before host within the single-digit range", () => {
    const sections = visibleSettingsSections();
    const hostIndex = sections.findIndex((section) => section.id === "host");
    for (let index = 0; index < hostIndex; index += 1) {
      expect(index).toBeLessThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
      // Every index in range resolves to a typable single digit ("1".."9", "0").
      expect(singleDigitLeaderDigitFor(index)).toMatch(/^[0-9]$/);
    }
  });
});
