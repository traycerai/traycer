import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { navigationSource } from "@/lib/commands/sources/navigation.source";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import {
  SETTINGS_SECTIONS,
  visibleSettingsSections,
} from "@/lib/settings-sections";
import { setMobileApp } from "@/lib/mobile-app";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";

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
    expect(captureSettingsSubpage("/").map((i) => i.id)).not.toContain(
      "nav:settings/delete-account",
    );

    setMobileApp(true);
    const mobileIds = captureSettingsSubpage("/").map((i) => i.id);
    expect(mobileIds).toContain("nav:settings/delete-account");
    // ...and the two the mobile app drops stay dropped.
    expect(mobileIds).not.toContain("nav:settings/keybindings");
    expect(mobileIds).not.toContain("nav:settings/link-phone");
  });

  it("settings sub-page filters out the current section", () => {
    const ids = captureSettingsSubpage("/settings/appearance").map((i) => i.id);
    expect(ids).not.toContain("nav:settings/appearance");
    expect(ids).toContain("nav:settings/general");
  });

  it("distinguishes application Sounds from host Notifications", () => {
    const items = captureSettingsSubpage("/");
    const app = items.find((i) => i.id === "nav:settings/app-notifications");
    const host = items.find((i) => i.id === "nav:settings/notifications");
    expect(app?.label).toBe("Sounds");
    expect(app?.statusBadge).toBe("Application");
    expect(app?.keywords).toContain("notifications");
    expect(host?.label).toBe("Notifications");
    expect(host?.statusBadge).toBe("Host");
  });
});
