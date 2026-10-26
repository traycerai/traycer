/**
 * Getting started leads the whole list, Browser is the third Application-group
 * entry, Alerts follows Sounds, and the Application group ends with Layout,
 * then Diagnostics - the tenth desktop entry, which takes leader digit 0.
 * Account follows it, so Sessions - the first Account entry - and everything
 * after it (the rest of Account, all of Environment, the host group) has no
 * digit, Providers included. Desktop's Host ("Overview") is the twenty-eighth
 * entry. Mobile omits
 * Keybindings and Link mobile app. This suite pins the positions against
 * `visibleSettingsSections()`, the same list the leader-digit dispatcher walks.
 * Vitest runs as a dev build, so that list includes the two dev-only proof
 * pages, which sit after Environment and ahead of the host group.
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
  it("offers layout on desktop at index 8 (leader digit 9), with Diagnostics after it on 0", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const layoutIndex = sections.findIndex(
      (section) => section.id === "layout",
    );
    expect(layoutIndex).toBe(8);
    expect(singleDigitLeaderDigitFor(layoutIndex)).toBe("9");
    const diagnosticsIndex = sections.findIndex(
      (section) => section.id === "app-diagnostics",
    );
    expect(diagnosticsIndex).toBe(9);
    expect(singleDigitLeaderDigitFor(diagnosticsIndex)).toBe("0");
  });

  it("files Alerts straight after Sounds in the Application group", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const ids = sections.map((section) => section.id);
    expect(ids.indexOf("alerts")).toBe(ids.indexOf("app-notifications") + 1);
    expect(sections.find((section) => section.id === "alerts")?.group).toBe(
      "app",
    );
  });

  it("offers layout in the installed mobile app too", () => {
    setMobileApp(true);
    const ids = visibleSettingsSections().map((section) => section.id);
    expect(ids).toContain("layout");
    // One slot earlier than on desktop: "keybindings" is omitted in the
    // installed mobile app and sits ahead of layout.
    expect(ids.indexOf("layout")).toBe(7);
  });

  it("leaves Sessions, the first Account entry, and every section after it - Providers included - without a leader digit", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const devicesIndex = sections.findIndex(
      (section) => section.id === "devices",
    );
    expect(devicesIndex).toBe(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    const providersIndex = sections.findIndex(
      (section) => section.id === "providers",
    );
    // The five desktop Account pages sit ahead of Providers.
    expect(providersIndex).toBe(15);
    for (const id of [
      "devices",
      "link-phone",
      "providers",
      "mcp-servers",
      "skills",
      "fallback",
      "shell",
      "agents",
      "secrets",
      "usage",
      "credits",
      "permissions",
      "sandboxes",
      "members",
      "notifications",
      "host",
      "worktrees",
      "diagnostics",
    ]) {
      const index = sections.findIndex((section) => section.id === id);
      expect(index, id).toBeGreaterThanOrEqual(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    }
  });

  it("lists the Environment pages in their order, with the retired pages gone", () => {
    setMobileApp(false);
    const environment = visibleSettingsSections().filter(
      (section) => section.group === "personal",
    );
    expect(environment.map((section) => section.label)).toEqual([
      "Providers",
      "MCP servers",
      "Skills",
      "Permissions",
      "Agents",
      "Model routing",
      "Variables & shells",
      "Secrets",
      "Sandboxes",
      "Members",
    ]);
  });

  it("keeps each group contiguous, so the sidebar draws one heading per group", () => {
    setMobileApp(false);
    // The dev-only proof pages are Application-group entries filed after
    // Environment; the production list never has them.
    const production = visibleSettingsSections()
      .filter((section) => !section.id.startsWith("dev-"))
      .map((section) => section.group);
    const runs = production.filter((group, i) => group !== production[i - 1]);
    expect(new Set(runs).size).toBe(runs.length);
  });

  it("places Credits straight after Usage in Account", () => {
    setMobileApp(false);
    const ids = visibleSettingsSections().map((section) => section.id);
    expect(ids.indexOf("credits")).toBe(ids.indexOf("usage") + 1);
    expect(
      visibleSettingsSections().find((section) => section.id === "permissions")
        ?.group,
    ).toBe("personal");
  });

  it("pushes host (Overview) to index 27, past the single-digit leader limit", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    const hostIndex = sections.findIndex((section) => section.id === "host");
    expect(hostIndex).toBe(27);
    expect(hostIndex).toBeGreaterThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    expect(hostIndex).toBeGreaterThanOrEqual(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
  });

  it("keeps the first ten sections within the single-digit range", () => {
    setMobileApp(false);
    const sections = visibleSettingsSections();
    // Getting started leads the list and owns digit 1.
    expect(sections[0]?.id).toBe("getting-started");
    expect(singleDigitLeaderDigitFor(0)).toBe("1");
    expect(sections[SINGLE_DIGIT_LEADER_INDEX_LIMIT - 1]?.id).toBe(
      "app-diagnostics",
    );
    const hostIndex = sections.findIndex((section) => section.id === "host");
    expect(hostIndex).toBeGreaterThanOrEqual(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
    for (let index = 0; index < SINGLE_DIGIT_LEADER_INDEX_LIMIT; index += 1) {
      expect(index).toBeLessThan(SINGLE_DIGIT_LEADER_INDEX_LIMIT);
      // Every index in range resolves to a typable single digit ("1".."9", "0").
      expect(singleDigitLeaderDigitFor(index)).toMatch(/^[0-9]$/);
    }
  });
});
