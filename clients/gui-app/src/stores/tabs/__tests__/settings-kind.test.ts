/**
 * Locks down the settings tab kind helpers around the host section.
 * The Settings sidebar's primary entry routes through these helpers, so
 * the host section needs to resolve consistently from path → section
 * id → route options. The legacy `/settings/service` path is preserved
 * as a section-level alias to the Host section so a remembered tab
 * path from before the rename still lands on the current native-
 * packaging surface (the route itself redirects).
 */
import { describe, expect, it } from "vitest";
import {
  settingsDefaultPath,
  settingsSectionFromPath,
  settingsSectionPath,
  settingsTabDescriptor,
} from "@/stores/tabs/kinds/settings";
import { settingsTabIntent } from "@/lib/tab-navigation/intents";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { migrateTabsPersistedState } from "@/stores/tabs/store";

describe("settings tab kind - host section", () => {
  it("settingsSectionFromPath maps /settings/host to the host section", () => {
    expect(settingsSectionFromPath("/settings/host")).toBe("host");
  });

  it("settingsSectionFromPath aliases the legacy /settings/service path to the Host section", () => {
    expect(settingsSectionFromPath("/settings/service")).toBe("host");
  });

  it("settingsSectionFromPath maps the /settings/agents path to the Agents section", () => {
    expect(settingsSectionFromPath("/settings/agents")).toBe("agents");
  });

  it("settingsSectionFromPath maps /settings/devices to the devices section", () => {
    expect(settingsSectionFromPath("/settings/devices")).toBe("devices");
  });

  it("settingsSectionPath builds /settings/host for the host section", () => {
    expect(settingsSectionPath("host")).toBe("/settings/host");
  });

  it("settingsSectionPath builds /settings/devices for the devices section", () => {
    expect(settingsSectionPath("devices")).toBe("/settings/devices");
  });

  it("routes app-wide notifications to their application settings page", () => {
    expect(settingsSectionFromPath("/settings/app-notifications")).toBe(
      "app-notifications",
    );
    expect(settingsSectionPath("app-notifications")).toBe(
      "/settings/app-notifications",
    );
    expect(
      settingsTabDescriptor.routeOptions(
        settingsTabIntent("app-notifications"),
      ),
    ).toEqual({ to: "/settings/app-notifications" });
  });

  it("settingsTabDescriptor.routeOptions for the host intent navigates to /settings/host", () => {
    const intent = settingsTabIntent("host");
    const options = settingsTabDescriptor.routeOptions(intent);
    expect(options).toEqual({ to: "/settings/host" });
  });

  it("settingsTabDescriptor.routeOptions for the providers intent navigates to /settings/providers", () => {
    const intent = settingsTabIntent("providers");
    const options = settingsTabDescriptor.routeOptions(intent);
    expect(options).toEqual({ to: "/settings/providers" });
  });

  it("settingsTabDescriptor.routeOptions for the devices intent navigates to /settings/devices", () => {
    const intent = settingsTabIntent("devices");
    const options = settingsTabDescriptor.routeOptions(intent);
    expect(options).toEqual({ to: "/settings/devices" });
  });

  it("settingsTabDescriptor.resolveIntent returns the Host intent for a remembered legacy /settings/service path", () => {
    const intent = settingsTabDescriptor.resolveIntent({
      kind: "settings",
      id: "settings",
      name: "Settings",
      lastPath: "/settings/service",
      route: "/settings/service",
      icon: null,
      canDuplicate: false,
      canOpenInNewWindow: false,
    });
    expect(intent).toEqual(settingsTabIntent("host"));
  });

  it("settings default path is unchanged", () => {
    expect(settingsDefaultPath()).toBe("/settings/general");
  });
});

/**
 * RG6: `store.ts`'s own `SETTINGS_PATHS` allowlist is hand-maintained and
 * deliberately NOT derived from `SETTINGS_SECTIONS` (see that file's own
 * comment - sharing removes the repeated-omission mechanism the comment
 * records: `devices`, then `app-notifications`/`link-phone`, each silently
 * unrecognised as a settings route until a later addition happened to sit
 * next to the gap). This sweep is what turns "silently dropped" into a red
 * test: it derives its EXPECTATION from `SETTINGS_SECTIONS`, but the
 * production allowlist stays hand-maintained.
 */
function persistedSettingsTab(sectionId: string): unknown {
  return {
    items: [],
    systemTabs: {
      settings: {
        kind: "settings",
        name: "Settings",
        lastPath: `/settings/${sectionId}`,
      },
    },
  };
}

describe("RG6: store.ts's migrateTabsPersistedState keeps every registered settings route", () => {
  it.each(SETTINGS_SECTIONS.map((section) => section.id))(
    "a persisted settings tab at /settings/%s survives migration",
    (sectionId) => {
      const migrated = migrateTabsPersistedState(
        persistedSettingsTab(sectionId),
      );
      // Falsification: remove any one id from `SETTINGS_PATHS` in `store.ts` -
      // exactly that section's case reddens here, and ONLY here (the sibling
      // sweep in `desktop-tabs-persistence.test.ts` reads a SEPARATE
      // hand-maintained copy of the same list and stays green).
      expect(migrated.systemTabs.settings?.lastPath).toBe(
        `/settings/${sectionId}`,
      );
    },
  );

  it("explicitly covers the three ids the audit found omitted: fallback, app-notifications, link-phone", () => {
    for (const id of ["fallback", "app-notifications", "link-phone"]) {
      const migrated = migrateTabsPersistedState(persistedSettingsTab(id));
      expect(migrated.systemTabs.settings?.lastPath).toBe(`/settings/${id}`);
    }
  });

  it("an unknown settings path falls back rather than being accepted", () => {
    const migrated = migrateTabsPersistedState(
      persistedSettingsTab("not-a-section"),
    );
    expect(migrated.systemTabs.settings).toBeNull();
  });

  it("the retired 'service' id is still ACCEPTED - a persisted old path must still hydrate", () => {
    const migrated = migrateTabsPersistedState(persistedSettingsTab("service"));
    expect(migrated.systemTabs.settings?.lastPath).toBe("/settings/service");
  });
});
