import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { navigationSource } from "@/lib/commands/sources/navigation.source";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
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

  it("settings sub-page lists every SETTINGS_SECTIONS entry", () => {
    const ids = captureSettingsSubpage("/").map((i) => i.id);
    for (const section of SETTINGS_SECTIONS) {
      expect(ids).toContain(`nav:settings/${section.id}`);
    }
  });

  it("settings sub-page filters out the current section", () => {
    const ids = captureSettingsSubpage("/settings/appearance").map((i) => i.id);
    expect(ids).not.toContain("nav:settings/appearance");
    expect(ids).toContain("nav:settings/general");
  });
});
