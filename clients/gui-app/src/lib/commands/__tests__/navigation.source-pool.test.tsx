import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// A build with a server pool answers `environment.secrets.list` from the
// pool's manifest, whichever host the page is read from. The tier plan settles
// once per process, so this build gets a file of its own.
vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).personalHostScopeModule,
);
vi.mock(
  "@/components/settings/personal/use-window-host-personal",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).windowHostPersonalModule,
);
vi.mock(
  "@/components/settings/environment/use-environment-status-model",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).environmentStatusModelModule,
);

import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  PERSONAL_PICK,
  UNRESOLVED_PICK,
} from "@/lib/settings-environment-pages";
import { mountSettingsSubpage } from "@/lib/commands/__tests__/settings-subpage-fixture";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  pickerDefaultPick,
  resetEnvironmentSectionReads,
  windowHostRunsPersonal,
} from "@/components/settings/__tests__/environment-section-reads-fixture";

beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

afterEach(() => {
  cleanup();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: UNRESOLVED_PICK,
    defaultHostId: null,
  });
  useSelectionAuthorityStore.getState().reset();
  resetNegotiatedManifests();
  resetEnvironmentSectionReads();
});

describe("navigationSource on a build with a server pool", () => {
  it.each([
    {
      name: "Personal on a host that runs it",
      pick: { kind: "personal" },
      runs: true,
    },
    {
      name: "Local",
      pick: { kind: "local", hostId: "host-a", hostName: "Old laptop" },
      runs: false,
    },
  ] as const)(
    "$name: offers Secrets once the pool serves the list, though the host does not",
    ({ pick, runs }) => {
      windowHostRunsPersonal.current = runs;
      recordNegotiatedHostMethods("host-a", ["environment.status"]);
      useSettingsEnvironmentPickStore.setState({ pick });
      const subpage = mountSettingsSubpage("/");
      const offered = () =>
        subpage.latest().some((item) => item.id === "nav:settings/secrets");

      expect(offered()).toBe(false);

      act(() => {
        recordNegotiatedHostMethods(POOL_HOST_ID, ["environment.secrets.list"]);
      });

      expect(offered()).toBe(true);
    },
  );
});

describe("navigationSource on a build with a server pool, in a window Settings has not opened", () => {
  it("lists Secrets for Personal on a host that runs it, once the pool serves the list", () => {
    useSelectionAuthorityStore.setState({ effectiveHostId: "host-a" });
    windowHostRunsPersonal.current = true;
    pickerDefaultPick.current = PERSONAL_PICK;
    recordNegotiatedHostMethods("host-a", ["environment.status"]);
    recordNegotiatedHostMethods(POOL_HOST_ID, ["environment.secrets.list"]);

    const history = mountSettingsSubpage("/").offered("nav:settings/secrets");

    expect(history.at(-1)).toBe(true);
    expect(history.indexOf(true)).toBeGreaterThan(history.lastIndexOf(false));
  });
});
