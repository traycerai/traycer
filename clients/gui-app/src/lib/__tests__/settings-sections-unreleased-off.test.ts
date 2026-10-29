/**
 * The build without environments, sandboxes and bots
 * (`unreleased-features.ts`): Settings reads as it did before them. No
 * Environment group; its pages and Notifications sit under the host picker,
 * Overview first; and the pages only those features have are not offered.
 */
import { describe, expect, it, vi } from "vitest";
import {
  SETTINGS_SECTION_GROUPS,
  SETTINGS_SECTIONS,
  UNRELEASED_SETTINGS_SECTION_IDS,
  isSettingsSectionVisible,
  visibleSettingsSections,
} from "@/lib/settings-sections";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

describe("Settings without the unreleased features", () => {
  it("has no Environment group", () => {
    expect(SETTINGS_SECTION_GROUPS.map((group) => group.id)).toEqual([
      "guide",
      "app",
      "account",
      "host",
    ]);
    expect(
      SETTINGS_SECTIONS.filter((section) => section.group === "personal"),
    ).toEqual([]);
  });

  it("puts the Environment pages and Notifications under the host picker, in the order and with the labels they had before", () => {
    const host = visibleSettingsSections().filter(
      (section) => section.group === "host",
    );
    expect(host.map((section) => [section.id, section.label])).toEqual([
      ["host", "Overview"],
      ["providers", "Providers"],
      ["worktrees", "Worktrees"],
      ["notifications", "Notifications"],
      ["permissions", "Permissions"],
      ["agents", "Agent selection"],
      ["fallback", "Model routing"],
      ["shell", "Shell"],
      ["diagnostics", "Diagnostics"],
    ]);
    const account = visibleSettingsSections()
      .filter((section) => section.group === "account")
      .map((section) => section.id);
    expect(account).toEqual(["devices", "link-phone", "usage"]);
  });

  it("offers none of the features' own pages, and still resolves their ids", () => {
    for (const id of UNRELEASED_SETTINGS_SECTION_IDS) {
      expect(isSettingsSectionVisible(id)).toBe(false);
      expect(SETTINGS_SECTIONS.some((section) => section.id === id)).toBe(true);
    }
    expect([...UNRELEASED_SETTINGS_SECTION_IDS].sort()).toEqual([
      "credits",
      "machine-setup",
      "mcp-servers",
      "members",
      "sandboxes",
      "secrets",
      "skills",
    ]);
  });
});
