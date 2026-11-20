import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The settings sub-page draws by the Environment pick's source: the window's
// host, through the scope, and whether it runs Personal.
vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).personalHostScopeModule,
);
vi.mock(
  "@/components/settings/personal/use-window-host-runs-personal",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).windowHostRunsPersonalModule,
);

import type { CommandItem } from "@/lib/commands/types";
import { mountSettingsSubpage } from "@/lib/commands/__tests__/settings-subpage-fixture";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  resetEnvironmentSectionReads,
  windowHostRunsPersonal,
} from "@/components/settings/__tests__/environment-section-reads-fixture";

/** The settings sub-page's rows under `pick`. */
function settingsRows(pick: EnvironmentPick): ReadonlyArray<CommandItem> {
  useSettingsEnvironmentPickStore.setState({ pick });
  return mountSettingsSubpage("/").latest();
}

const offersMembers = (pick: EnvironmentPick): boolean =>
  settingsRows(pick).some((item) => item.id === "nav:settings/members");

// Members is a team's page: the rail already leaves it off any other pick, and
// the palette says the same.
describe("navigationSource, Members by the pick", () => {
  afterEach(() => {
    cleanup();
    useSettingsEnvironmentPickStore.setState({ pick: null });
    resetNegotiatedManifests();
    resetEnvironmentSectionReads();
  });

  it("offers a team the Members page", () => {
    expect(offersMembers({ kind: "team", environmentId: "env-team" })).toBe(
      true,
    );
  });

  it("offers Personal no Members page", () => {
    windowHostRunsPersonal.current = true;
    act(() => {
      recordNegotiatedHostMethods("host-a", ["environment.secrets.list"]);
    });

    expect(offersMembers({ kind: "personal" })).toBe(false);
  });

  it("offers a Local pick no Members page", () => {
    act(() => {
      recordNegotiatedHostMethods("host-a", ["environment.secrets.list"]);
    });

    expect(
      offersMembers({
        kind: "local",
        hostId: "host-a",
        hostName: "Old laptop",
      }),
    ).toBe(false);
  });
});
