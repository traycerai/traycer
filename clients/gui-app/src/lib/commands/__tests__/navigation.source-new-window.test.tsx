import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// A window where Settings has not opened: the store holds no pick and no
// resolved default, so the palette's settings rows resolve the pick
// themselves. The picker model's `defaultPick` is what the real
// `useEnvironmentPickerModel` effect writes into the store.
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

import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  personalHostScopeOverrides,
  pickerDefaultPick,
  resetEnvironmentSectionReads,
} from "@/components/settings/__tests__/environment-section-reads-fixture";
import {
  captureRoot,
  mountSettingsSubpage,
} from "@/lib/commands/__tests__/settings-subpage-fixture";
import {
  PERSONAL_PICK,
  UNRESOLVED_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const SECRETS_ROW = "nav:settings/secrets";
const TEAM_PICK: EnvironmentPick = { kind: "team", environmentId: "env-team" };

/** Whether the sub-page offered Secrets at each render, as `mountSettingsSubpage` records. */
function secretsOffered(): ReadonlyArray<boolean> {
  return mountSettingsSubpage("/").offered(SECRETS_ROW);
}

/** Offered by the last render, and never offered and then withdrawn. */
function expectOfferedWithoutFlash(history: ReadonlyArray<boolean>): void {
  expect(history.at(-1)).toBe(true);
  expect(history.indexOf(true)).toBeGreaterThan(history.lastIndexOf(false));
}

describe("navigationSource, in a window Settings has not opened", () => {
  beforeEach(() => {
    useSelectionAuthorityStore.setState({ effectiveHostId: "host-a" });
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

  it("keywords the Open App Settings row with Secrets before any pick resolves", () => {
    const entry = captureRoot("/").find((i) => i.id === "nav:settings");

    expect(entry?.keywords).toContain("secrets");
  });

  it("lists Secrets on the cloud road once the sub-page has resolved the default pick", () => {
    pickerDefaultPick.current = PERSONAL_PICK;

    expectOfferedWithoutFlash(secretsOffered());
    expect(useSettingsEnvironmentPickStore.getState().defaultPick).toEqual(
      PERSONAL_PICK,
    );
  });

  it("lists Secrets for a team whose default resolves in the sub-page", () => {
    pickerDefaultPick.current = TEAM_PICK;

    expectOfferedWithoutFlash(secretsOffered());
  });

  it("re-resolves the default for a new window host and lists Secrets", () => {
    useSettingsEnvironmentPickStore.setState({
      defaultPick: { kind: "local", hostId: "host-a", hostName: "Old laptop" },
      defaultHostId: "host-a",
    });
    useSelectionAuthorityStore.setState({ effectiveHostId: "host-b" });
    personalHostScopeOverrides.current = {
      host: hostScopeOptionFixture({ hostId: "host-b" }),
    };
    pickerDefaultPick.current = PERSONAL_PICK;

    expectOfferedWithoutFlash(secretsOffered());
    expect(useSettingsEnvironmentPickStore.getState().defaultHostId).toBe(
      "host-b",
    );
  });
});
