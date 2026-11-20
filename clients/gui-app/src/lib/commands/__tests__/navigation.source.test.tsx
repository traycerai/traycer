import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
const soundtrackOfferedMock = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => soundtrackOfferedMock.value,
}));

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

import type { CommandItem } from "@/lib/commands/types";
import {
  captureRoot,
  mountSettingsSubpage,
} from "@/lib/commands/__tests__/settings-subpage-fixture";
import {
  SETTINGS_SECTIONS,
  visibleSettingsSections,
} from "@/lib/settings-sections";
import { setMobileApp } from "@/lib/mobile-app";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  resetEnvironmentSectionReads,
  windowHostRunsPersonal,
} from "@/components/settings/__tests__/environment-section-reads-fixture";

// A team offers every Environment page, so the cases below that are about
// something else read the whole list.
const TEAM_PICK: EnvironmentPick = { kind: "team", environmentId: "env-team" };

function captureSettingsSubpage(pathname: string): ReadonlyArray<CommandItem> {
  return mountSettingsSubpage(pathname).latest();
}

describe("navigationSource", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    useSettingsEnvironmentPickStore.setState({ pick: TEAM_PICK });
  });

  afterEach(() => {
    cleanup();
    useSettingsEnvironmentPickStore.setState({ pick: null });
    resetNegotiatedManifests();
    resetEnvironmentSectionReads();
    soundtrackOfferedMock.value = false;
    setMobileApp(false);
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
  });

  it("root emits Open Tasks + Settings entry on an epic detail route", () => {
    const ids = captureRoot("/epics/abc").map((i) => i.id);
    expect(ids).toContain("nav:epics");
    expect(ids).toContain("nav:settings");
    for (const section of SETTINGS_SECTIONS) {
      expect(ids).not.toContain(`nav:settings/${section.id}`);
    }
  });

  it("root filters out Open Tasks when already at /epics", () => {
    const ids = captureRoot("/epics").map((i) => i.id);
    expect(ids).not.toContain("nav:epics");
    expect(ids).toContain("nav:settings");
  });

  it("Open Settings row renders the live app.settings.open chord", () => {
    useKeybindingStore.getState().setBinding("app.settings.open", "mod+alt+s");
    const entry = captureRoot("/").find((i) => i.id === "nav:settings");
    expect(entry?.shortcut).toBe("mod+alt+s");
  });

  it("Open Settings shortcut is null when the action is unbound", () => {
    useKeybindingStore.getState().clearBinding("app.settings.open");
    const entry = captureRoot("/").find((i) => i.id === "nav:settings");
    expect(entry?.shortcut).toBeNull();
  });

  // The OFFERED list, not the whole table: the palette presents a choice, so
  // it must list exactly what this build's sidebar lists. Sweeping
  // `SETTINGS_SECTIONS` here would demand a row for a section the build does
  // not offer, whose destination redirects away.
  it("settings sub-page lists every offered section", () => {
    const ids = captureSettingsSubpage("/").map((i) => i.id);
    for (const section of visibleSettingsSections()) {
      expect(ids).toContain(`nav:settings/${section.id}`);
    }
  });

  it("offers no route into a section this build does not have", () => {
    // Desktop: Delete account exists in the table (its id has to resolve) but
    // is offered only by the installed mobile app.
    const desktopIds = captureSettingsSubpage("/").map((i) => i.id);
    expect(desktopIds).not.toContain("nav:settings/delete-account");
    expect(desktopIds).toContain("nav:settings/app-diagnostics");

    setMobileApp(true);
    const mobileIds = captureSettingsSubpage("/").map((i) => i.id);
    expect(mobileIds).toContain("nav:settings/delete-account");
    // ...and the sections the mobile app drops stay dropped. Application
    // Diagnostics joins Keybindings and Link mobile app.
    expect(mobileIds).not.toContain("nav:settings/keybindings");
    expect(mobileIds).not.toContain("nav:settings/link-phone");
    expect(mobileIds).not.toContain("nav:settings/app-diagnostics");
  });

  it("settings sub-page filters out the current section", () => {
    const ids = captureSettingsSubpage("/settings/appearance").map((i) => i.id);
    expect(ids).not.toContain("nav:settings/appearance");
    expect(ids).toContain("nav:settings/general");
  });

  it("lists application Sounds and Alerts, and no retired Notifications row", () => {
    soundtrackOfferedMock.value = true;
    const items = captureSettingsSubpage("/");
    const app = items.find((i) => i.id === "nav:settings/app-notifications");
    const alerts = items.find((i) => i.id === "nav:settings/alerts");
    expect(app?.label).toBe("Sounds");
    expect(app?.statusBadge).toBe("Application");
    expect(alerts?.label).toBe("Alerts");
    expect(alerts?.statusBadge).toBe("Application");
    expect(items.map((i) => i.id)).not.toContain("nav:settings/notifications");
  });

  it("lists Sounds only where a soundtrack is offered, and Alerts either way", () => {
    soundtrackOfferedMock.value = false;
    const without = captureSettingsSubpage("/").map((i) => i.id);
    expect(without).not.toContain("nav:settings/app-notifications");
    expect(without).toContain("nav:settings/alerts");
  });

  it("lists the Secrets page, and none of the retired pages, in the settings sub-page", () => {
    const items = captureSettingsSubpage("/");
    const ids = items.map((i) => i.id);
    const secrets = items.find((i) => i.id === "nav:settings/secrets");
    expect(secrets?.label).toBe("Secrets");
    expect(secrets?.statusBadge).toBe("Environment");
    for (const retired of [
      "browser-agent-access",
      "agent-definitions",
      "machine-setup",
    ]) {
      expect(ids, retired).not.toContain(`nav:settings/${retired}`);
    }
  });

  it("lists the MCP servers, Skills and Agents pages in the settings sub-page", () => {
    const items = captureSettingsSubpage("/");
    for (const [id, label] of [
      ["mcp-servers", "MCP servers"],
      ["skills", "Skills"],
      ["agents", "Agents"],
    ] as const) {
      const item = items.find((i) => i.id === `nav:settings/${id}`);
      expect(item?.label, id).toBe(label);
      expect(item?.statusBadge, id).toBe("Environment");
    }
  });

  it("badges the regrouped pages with the scope the sidebar now files them under", () => {
    const items = captureSettingsSubpage("/");
    const badgeOf = (id: string): string | undefined =>
      items.find((i) => i.id === `nav:settings/${id}`)?.statusBadge;
    expect(badgeOf("fallback")).toBe("Environment");
    expect(badgeOf("permissions")).toBe("Environment");
    expect(badgeOf("providers")).toBe("Environment");
    expect(badgeOf("shell")).toBe("Environment");
    expect(badgeOf("agents")).toBe("Environment");
    expect(badgeOf("devices")).toBe("Account");
    expect(badgeOf("worktrees")).toBe("Host");
  });
});

describe("navigationSource, the Secrets row by the pick's source", () => {
  const SECRETS_ROW = "nav:settings/secrets";
  const SECRETS_LIST = "environment.secrets.list";
  const LOCAL_PICK: EnvironmentPick = {
    kind: "local",
    hostId: "host-a",
    hostName: "Old laptop",
  };

  afterEach(() => {
    cleanup();
    useSettingsEnvironmentPickStore.setState({ pick: null });
    resetNegotiatedManifests();
    resetEnvironmentSectionReads();
  });

  /** Whether the settings sub-page offers Secrets, at each render so far. */
  function mountSecretsRow(
    pick: EnvironmentPick,
  ): () => ReadonlyArray<boolean> {
    useSettingsEnvironmentPickStore.setState({ pick });
    const subpage = mountSettingsSubpage("/");
    return () => subpage.offered(SECRETS_ROW);
  }

  it.each([
    {
      name: "Personal on a host that runs it",
      pick: { kind: "personal" },
      runs: true,
    },
    { name: "Local", pick: LOCAL_PICK, runs: false },
  ] as const)(
    "$name: offers Secrets once the host serves the list, never before, and never withdraws it",
    ({ pick, runs }) => {
      windowHostRunsPersonal.current = runs;
      const offered = mountSecretsRow(pick);

      expect(offered().at(-1)).toBe(false);

      act(() => {
        recordNegotiatedHostMethods("host-a", ["environment.status"]);
      });

      expect(offered().at(-1)).toBe(false);

      act(() => {
        recordNegotiatedHostMethods("host-a", [
          "environment.status",
          SECRETS_LIST,
        ]);
      });

      const history = offered();
      expect(history.at(-1)).toBe(true);
      expect(history.indexOf(true)).toBeGreaterThan(history.lastIndexOf(false));
    },
  );

  it("offers Personal's Secrets only after the window host's Personal read has answered", () => {
    windowHostRunsPersonal.current = null;
    recordNegotiatedHostMethods("host-a", [SECRETS_LIST]);
    const offered = mountSecretsRow({ kind: "personal" });

    expect(offered().at(-1)).toBe(false);
  });

  it("offers Secrets on the cloud road, whatever the window's host serves", () => {
    windowHostRunsPersonal.current = false;
    recordNegotiatedHostMethods("host-a", ["environment.status"]);

    expect(mountSecretsRow({ kind: "personal" })().at(-1)).toBe(true);
    cleanup();
    expect(mountSecretsRow(TEAM_PICK)().at(-1)).toBe(true);
  });
});
