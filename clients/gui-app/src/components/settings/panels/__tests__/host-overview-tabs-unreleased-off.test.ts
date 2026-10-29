/**
 * The build without environments (`unreleased-features.ts`) draws the host
 * Overview as the release before them did: Access and setup, which came with
 * them, is not among its tabs, and nothing that names it (an open intent, a
 * search anchor) moves the page.
 */
import { describe, expect, it, vi } from "vitest";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import {
  DEFAULT_HOST_OVERVIEW_TAB,
  HOST_OVERVIEW,
  HOST_OVERVIEW_TABS,
  hostOverviewTabForAnchor,
  hostOverviewTabForIntent,
  isHostOverviewTab,
} from "@/components/settings/panels/host-overview.definitions";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

/** The desktop shell, where every one of the page's other tabs is offered. */
const AVAILABILITY_CONTEXT: SettingsAvailabilityContext = {
  runnerHost: null,
  featureSettings: null,
  mobileApp: false,
  phoneLayout: false,
};

describe("the host Overview's tabs without environments", () => {
  it("draws the tabs of the release before them, Access and setup left out", () => {
    expect(HOST_OVERVIEW_TABS).toEqual([
      "installation",
      "updates",
      "data",
      "ports",
      "simulators",
    ]);
    expect(DEFAULT_HOST_OVERVIEW_TAB).toBe("installation");
  });

  it("moves for no intent or anchor that names the missing tab", () => {
    expect(isHostOverviewTab("access")).toBe(false);
    expect(hostOverviewTabForIntent("access")).toBeNull();
    expect(hostOverviewTabForAnchor("host-overview-tab-access")).toBeNull();
    // The retired name still lands on its replacement.
    expect(hostOverviewTabForIntent("status")).toBe("updates");
    expect(hostOverviewTabForAnchor("host-overview-tab-ports")).toBe("ports");
  });

  it("offers the tab's groups to no search", () => {
    const { definitions } = HOST_OVERVIEW;
    for (const group of [
      definitions.accessTab,
      definitions.remoteAccess,
      definitions.hostSetup,
      definitions.terminalAccounts,
      definitions.localValues,
    ]) {
      expect(group.availableWhen(AVAILABILITY_CONTEXT)).toBe(false);
    }
    expect(definitions.portsTab.availableWhen(AVAILABILITY_CONTEXT)).toBe(true);
  });
});
