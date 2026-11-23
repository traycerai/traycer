import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
const soundtrackOfferedMock = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => soundtrackOfferedMock.value,
}));

import { navigationSource } from "@/lib/commands/sources/navigation.source";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import {
  SETTINGS_SECTIONS,
  visibleSettingsSections,
} from "@/lib/settings-sections";
import { setMobileApp } from "@/lib/mobile-app";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

function ctx(pathname: string): CommandContext {
  return {
    pathname,
    router: {
      getPathname: () => pathname,
      navigateHome: () => undefined,
      navigateSettings: () => undefined,
      navigateToEpic: () => undefined,
      navigateToEpicTab: () => undefined,
      navigateToEpicList: () => undefined,
      navigateSettingsSection: () => undefined,
      navigateToTabIntent: () => undefined,
      goBack: () => undefined,
      goForward: () => undefined,
      isHistoryNavAvailable: () => false,
      canGoBack: () => false,
      canGoForward: () => false,
    },
    activeTabId: null,
    activeEpicId: null,
    focusedComposerKind: null,
    targetGroupId: null,
  };
}

function captureRoot(pathname: string): ReadonlyArray<CommandItem> {
  let captured: ReadonlyArray<CommandItem> = [];
  function Probe() {
    captured = navigationSource.useItems(ctx(pathname));
    return null;
  }
  render(<Probe />);
  return captured;
}

function captureSettingsSubpage(pathname: string): ReadonlyArray<CommandItem> {
  const root = captureRoot(pathname);
  const entry = root.find((i) => i.id === "nav:settings");
  if (entry === undefined || entry.subpage === null) {
    throw new Error("settings sub-page entry missing");
  }
  const subpage = entry.subpage;
  let captured: ReadonlyArray<CommandItem> = [];
  function Probe() {
    captured = subpage.useItems(ctx(pathname));
    return null;
  }
  render(<Probe />);
  return captured;
}

describe("navigationSource", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
  });

  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: { kind: "unresolved" },
      defaultHostId: null,
    });
    useSelectionAuthorityStore.setState({ effectiveHostId: null });
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

  it("lists no row for a page a Local pick on an old host lacks, and still lists the pages it has", () => {
    recordNegotiatedHostMethods("host-old", ["host.status"]);
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-old", hostName: "Old laptop" },
    });

    const ids = captureSettingsSubpage("/").map((i) => i.id);

    for (const hidden of [
      "mcp-servers",
      "skills",
      "secrets",
      "agent-memories",
      "sandboxes",
      "storage",
    ]) {
      expect(ids, hidden).not.toContain(`nav:settings/${hidden}`);
    }
    for (const kept of ["providers", "permissions", "agents", "shell"]) {
      expect(ids, kept).toContain(`nav:settings/${kept}`);
    }
  });

  it("lists no hidden page in a window whose host is old before Settings has stored a default or a pick", () => {
    recordNegotiatedHostMethods("host-old", ["host.status"]);
    useSelectionAuthorityStore.setState({ effectiveHostId: "host-old" });

    const ids = captureSettingsSubpage("/").map((i) => i.id);

    expect(ids).not.toContain("nav:settings/secrets");
    expect(ids).not.toContain("nav:settings/skills");
    expect(ids).toContain("nav:settings/providers");
  });

  it("lists the hidden pages again once the window's host moves to one that advertises environment.status", () => {
    recordNegotiatedHostMethods("host-old", ["host.status"]);
    recordNegotiatedHostManifest("host-new", {
      "environment.status": { major: 1, minor: 3 },
    });
    useSelectionAuthorityStore.setState({ effectiveHostId: "host-old" });
    useSettingsEnvironmentPickStore.setState({
      defaultPick: { kind: "personal" },
      defaultHostId: "host-new",
    });
    const pathname = "/";
    let captured: ReadonlyArray<CommandItem> = [];
    const subpage = captureRoot(pathname).find(
      (i) => i.id === "nav:settings",
    )?.subpage;
    if (subpage === null || subpage === undefined)
      throw new Error("no subpage");
    function Probe() {
      captured = subpage?.useItems(ctx(pathname)) ?? [];
      return null;
    }
    render(<Probe />);
    expect(captured.map((i) => i.id)).not.toContain("nav:settings/secrets");

    act(() => {
      useSelectionAuthorityStore.setState({ effectiveHostId: "host-new" });
    });
    expect(captured.map((i) => i.id)).toContain("nav:settings/secrets");
  });

  it("offers the page on screen when a hidden path is drawn as another page's", () => {
    recordNegotiatedHostMethods("host-old", ["host.status"]);
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-old", hostName: "Old laptop" },
    });

    const ids = captureSettingsSubpage("/settings/secrets").map((i) => i.id);

    expect(ids).not.toContain("nav:settings/providers");
    expect(ids).toContain("nav:settings/permissions");
  });

  it("lists every page for a Local pick on a host that advertises environment.status", () => {
    recordNegotiatedHostManifest("host-old", {
      "environment.status": { major: 1, minor: 3 },
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-old", hostName: "Old laptop" },
    });

    const ids = captureSettingsSubpage("/").map((i) => i.id);

    expect(ids).toContain("nav:settings/skills");
    expect(ids).toContain("nav:settings/secrets");
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
