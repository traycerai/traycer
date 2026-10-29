/**
 * The build without environments (`unreleased-features.ts`): MCP servers and
 * Skills have no page of their own, so searching for them lands on Providers,
 * where each provider's tabs for them are — as it did before those pages.
 */
import { describe, expect, it, vi } from "vitest";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { searchSettings } from "@/lib/settings-search/settings-search";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

const DESKTOP: SettingsAvailabilityContext = {
  runnerHost: createFakeRunnerHost({}),
  featureSettings: null,
  mobileApp: false,
  phoneLayout: false,
};

/** The page and label of each result, which is what a click would open. */
function hitsFor(query: string): ReadonlyArray<string> {
  return searchSettings(query, DESKTOP).map(
    (result) => `${result.entry.section}:${result.entry.label}`,
  );
}

describe("settings search without environments", () => {
  it("answers mcp with the Providers group", () => {
    expect(hitsFor("mcp")).toContain("providers:MCP servers");
  });

  it("answers skill with the Providers group", () => {
    expect(hitsFor("skill")).toContain("providers:Skills");
  });

  it("names the variables group as the page draws it", () => {
    expect(hitsFor("environment variables")).toContain(
      "providers:Environment variables",
    );
  });
});
