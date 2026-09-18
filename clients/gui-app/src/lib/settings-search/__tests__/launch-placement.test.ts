import { describe, expect, it } from "vitest";
import {
  CUSTOMIZE_CATALOG,
  getCustomizeSetting,
} from "@/lib/customize/catalog";
import { CUSTOMIZE_LAUNCH_ENTRIES } from "@/lib/customize/customize-search.definitions";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { SETTINGS_SEARCH_ENTRIES } from "@/lib/settings-search/settings-search-entries";
import {
  searchSettings,
  settingsSearchResultKey,
} from "@/lib/settings-search/settings-search";

const OFF: SettingsAvailabilityContext = {
  runnerHost: null,
  featureSettings: null,
  mobileApp: false,
  mobileFooter: false,
  customizeEditor: false,
};
const ON: SettingsAvailabilityContext = { ...OFF, customizeEditor: true };

describe("Customize launch entries", () => {
  it("has one entry per catalog setting, each naming an existing id", () => {
    expect(CUSTOMIZE_LAUNCH_ENTRIES.map((entry) => entry.launch)).toEqual(
      CUSTOMIZE_CATALOG.map((setting) => setting.id),
    );
    for (const entry of CUSTOMIZE_LAUNCH_ENTRIES) {
      if (entry.launch === null) throw new Error("a launch entry launches");
      expect(getCustomizeSetting(entry.launch).label).toBe(entry.label);
    }
  });

  it("is part of the index, and is anchor-free so no anchor assertion sees it", () => {
    for (const entry of CUSTOMIZE_LAUNCH_ENTRIES) {
      expect(SETTINGS_SEARCH_ENTRIES).toContain(entry);
      expect(entry.anchor).toBeNull();
      expect(entry.section).toBe("appearance");
    }
    // Only launch entries carry a launch: every anchored entry is an ordinary
    // navigate-and-reveal result.
    expect(
      SETTINGS_SEARCH_ENTRIES.filter(
        (entry) => entry.anchor !== null && entry.launch !== null,
      ),
    ).toEqual([]);
  });

  it("gives every launch entry its own result key, same-named ones included", () => {
    const keys = CUSTOMIZE_LAUNCH_ENTRIES.map(settingsSearchResultKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Usage limits live in the status bar AND the header: one label, two keys.
    const usage = CUSTOMIZE_LAUNCH_ENTRIES.filter(
      (entry) => entry.label === "Usage limits",
    );
    expect(usage).toHaveLength(2);
    expect(new Set(usage.map((entry) => entry.group)).size).toBe(2);
  });

  it("is unavailable exactly where the editor is not", () => {
    for (const entry of CUSTOMIZE_LAUNCH_ENTRIES) {
      expect(entry.availableWhen(OFF)).toBe(false);
      expect(entry.availableWhen(ON)).toBe(true);
    }
  });
});

describe("searching for a control the Layout page used to hold", () => {
  it("offers the Layout row, and no launch result, with the editor off", () => {
    const results = searchSettings("microphone", OFF);

    expect(results.some((result) => result.entry.launch !== null)).toBe(false);
    expect(
      results.some((result) => result.entry.anchor === "layout-composer-mic"),
    ).toBe(true);
  });

  it("offers a launch result, and not the retired row, with the editor on", () => {
    const results = searchSettings("microphone", ON);

    expect(
      results.some((result) => result.entry.launch === "composer.mic"),
    ).toBe(true);
    expect(
      results.some((result) => result.entry.anchor === "layout-composer-mic"),
    ).toBe(false);
  });

  it("withholds the Layout page itself, and every row on it, with the editor on", () => {
    const layoutOn = SETTINGS_SEARCH_ENTRIES.filter(
      (entry) => entry.section === "layout" && entry.availableWhen(ON),
    );
    const layoutOff = SETTINGS_SEARCH_ENTRIES.filter(
      (entry) => entry.section === "layout" && entry.availableWhen(OFF),
    );

    expect(layoutOn).toEqual([]);
    expect(layoutOff.length).toBeGreaterThan(1);
  });

  it("wears the Appearance breadcrumb and the surface the control lives on", () => {
    const [result] = searchSettings("microphone", ON).filter(
      (candidate) => candidate.entry.launch === "composer.mic",
    );

    expect(result.sectionLabel).toBe("Appearance");
    expect(result.entry.group).toBe("Composer · toolbar");
  });
});
