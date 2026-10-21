/**
 * Getting started leads the whole list, Browser is the third Application-group
 * entry and Layout is the last of the Application group. Personal follows it,
 * so Providers - the first Personal entry - is the tenth desktop entry and
 * takes leader digit 0; everything after it (the rest of Personal, all of
 * Account, the host group) has no digit, Sessions included. Desktop's Host
 * ("Overview") is the twenty-seventh entry. Mobile omits Keybindings and Link
 * mobile app. This suite pins the positions against `visibleSettingsSections()`,
 * the same list the leader-digit dispatcher walks. Vitest runs as a dev build,
 * so that list includes the two dev-only proof pages, which sit after Personal
 * and ahead of Sessions.
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

  it("gives Providers, the first Personal entry, leader digit 0 at index 9", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const providersIndex = sections.findIndex(
      (section) => section.id === "providers",
    );
    expect(providersIndex).toBe(9);
    expect(providersIndex).toBeLessThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    expect(singleDigitLeaderDigitFor(providersIndex)).toBe("0");
  });

  it("leaves every section after Providers - Sessions included - without a leader digit", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const devicesIndex = sections.findIndex(
      (section) => section.id === "devices",
    );
    // Four Personal pages (MCP servers, Skills, Agent definitions, Machine
    // setup) and the two dev-only proof pages sit ahead of Sessions.
    expect(devicesIndex).toBe(21);
    for (const id of [
      "mcp-servers",
      "skills",
      "fallback",
      "shell",
      "agents",
      "browser-agent-access",
      "secrets",
      "agent-definitions",
      "machine-setup",
      "devices",
      "usage",
      "permissions",
      "notifications",
      "host",
      "worktrees",
      "diagnostics",
    ]) {
      const index = sections.findIndex((section) => section.id === id);
      expect(index, id).toBeGreaterThanOrEqual(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    }
  });

  it("lists the Personal pages in their order, with MCP servers, Skills, Agent definitions and Machine setup in place", () => {
    setMobileApp(false);
    const personal = visibleSettingsSections().filter(
      (section) => section.group === "personal",
    );
    expect(personal.map((section) => section.label)).toEqual([
      "Providers",
      "MCP servers",
      "Skills",
      "Model routing",
      "Variables and shells",
      "Agent selection",
      "Browser agent access",
      "Secrets",
      "Agent definitions",
      "Machine setup",
    ]);
  });

  it("pushes host (Overview) to index 26, past the single-digit leader limit", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const hostIndex = sections.findIndex((section) => section.id === "host");
    expect(hostIndex).toBe(26);
    expect(hostIndex).toBeGreaterThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    expect(hostIndex).toBeGreaterThanOrEqual(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
  });

  it("keeps the first ten sections within the single-digit range", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    // Getting started leads the list and owns digit 1.
    expect(sections[0]?.id).toBe("getting-started");
    expect(singleDigitLeaderDigitFor(0)).toBe("1");
    expect(sections[SINGLE_DIGIT_LEADER_INDEX_LIMIT - 1]?.id).toBe("providers");
    const hostIndex = sections.findIndex((section) => section.id === "host");
    expect(hostIndex).toBeGreaterThanOrEqual(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    for (let index = 0; index < SINGLE_DIGIT_LEADER_INDEX_LIMIT; index += 1) {
      expect(index).toBeLessThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
      // Every index in range resolves to a typable single digit ("1".."9", "0").
      expect(singleDigitLeaderDigitFor(index)).toMatch(/^[0-9]$/);
    }
  });
});
