import { describe, expect, it } from "vitest";
import { LAYOUT_LAUNCH_ENTRIES } from "@/components/layout-editor/layout-search.definitions";
import { LAYOUT_REGION_LIST } from "@/components/layout-editor/regions/region-facts";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { SETTINGS_SEARCH_ENTRIES } from "@/lib/settings-search/settings-search-entries";
import {
  searchSettings,
  settingsSearchResultKey,
} from "@/lib/settings-search/settings-search";

const CONTEXT: SettingsAvailabilityContext = {
  runnerHost: null,
  featureSettings: null,
  mobileApp: false,
};

/**
 * The Customize switch and its ON/OFF launch gating are gone: a launch entry
 * now exists for every region, generated straight off the registry, and is
 * always available - the Layout page renders every region in every shell.
 */
describe("Layout launch entries", () => {
  it("has one entry per region, each naming an existing region id and its name", () => {
    expect(LAYOUT_LAUNCH_ENTRIES.map((entry) => entry.launch)).toEqual(
      LAYOUT_REGION_LIST.map((region) => region.id),
    );
    LAYOUT_LAUNCH_ENTRIES.forEach((entry, index) => {
      expect(entry.label).toBe(LAYOUT_REGION_LIST[index].name);
    });
  });

  it("is part of the index, and is anchor-free so no anchor assertion sees it", () => {
    for (const entry of LAYOUT_LAUNCH_ENTRIES) {
      expect(SETTINGS_SEARCH_ENTRIES).toContain(entry);
      expect(entry.anchor).toBeNull();
      expect(entry.section).toBe("layout");
    }
  });

  it("gives every launch entry its own result key", () => {
    const keys = LAYOUT_LAUNCH_ENTRIES.map(settingsSearchResultKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is always available, with no switch left to gate it", () => {
    for (const entry of LAYOUT_LAUNCH_ENTRIES) {
      expect(entry.availableWhen(CONTEXT)).toBe(true);
    }
  });
});

describe("searching for a region by its keywords", () => {
  it("offers a launch result naming the region", () => {
    const results = searchSettings("microphone", CONTEXT);

    expect(results.some((result) => result.entry.launch === "mic")).toBe(true);
  });

  it("wears the Layout breadcrumb and the surface the region lives on", () => {
    const [result] = searchSettings("microphone", CONTEXT).filter(
      (candidate) => candidate.entry.launch === "mic",
    );

    expect(result.sectionLabel).toBe("Layout");
    expect(result.entry.group).toBe("Composer");
  });
});
