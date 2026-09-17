/**
 * Two insertions moved the leader digits. The Layout section landed as the
 * seventh Application-group entry and pushed every host-group section one
 * slot later, which cost `host` ("Overview") its digit. Then Getting started
 * took the first slot of all, so every section after it moved once more and
 * `usage` now sits at `SINGLE_DIGIT_LEADER_INDEX_LIMIT` with no digit either.
 * This suite pins those positions against `visibleSettingsSections()`, the
 * same positional list the leader-digit dispatcher walks.
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
    // One slot earlier than on desktop: "keybindings" (index 5 on desktop)
    // is omitted in the installed mobile app and sits ahead of layout.
    expect(ids.indexOf("layout")).toBe(6);
  });

  it("pushes host (Overview) to index 11, past the single-digit leader limit", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const hostIndex = sections.findIndex((section) => section.id === "host");
    expect(hostIndex).toBe(11);
    expect(hostIndex).toBeGreaterThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
  });

  it("gives Getting started the first digit and leaves only usage before host without one", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    expect(sections[0]?.id).toBe("getting-started");
    expect(singleDigitLeaderDigitFor(0)).toBe("1");
    const hostIndex = sections.findIndex((section) => section.id === "host");
    const undigited = sections
      .slice(0, hostIndex)
      .filter((_section, index) => index >= SINGLE_DIGIT_LEADER_INDEX_LIMIT)
      .map((section) => section.id);
    expect(undigited).toEqual(["usage"]);
    for (let index = 0; index < SINGLE_DIGIT_LEADER_INDEX_LIMIT; index += 1) {
      // Every index in range resolves to a typable single digit ("1".."9", "0").
      expect(singleDigitLeaderDigitFor(index)).toMatch(/^[0-9]$/);
    }
  });
});
