import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { actionsSource } from "@/lib/commands/sources/actions.source";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { ACTION_META, getDefaultBindings } from "@/lib/keybindings/actions";
import { setMobileApp } from "@/lib/mobile-app";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

function ctx(): CommandContext {
  return {
    pathname: "/",
    router: {
      getPathname: () => "/",
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

function captureItems(): ReadonlyArray<CommandItem> {
  let captured: ReadonlyArray<CommandItem> = [];
  function Probe() {
    captured = actionsSource.useItems(ctx());
    return null;
  }
  render(<Probe />);
  return captured;
}

describe("actionsSource", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    useSettingsStore.setState({ homeTabEnabled: false });
  });

  afterEach(() => {
    cleanup();
    setMobileApp(false);
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    useSettingsStore.setState({ homeTabEnabled: false });
  });

  it("emits one item per chord-kind action and skips digit-kind ones", () => {
    const items = captureItems();
    for (const item of items) {
      expect(item.actionId).not.toBeNull();
      if (item.actionId !== null) {
        expect(ACTION_META[item.actionId].kind).toBe("chord");
      }
    }
    const ids = items.map((item) => item.id);
    expect(ids).not.toContain("action:epic.switch.byDigit");
    expect(ids).not.toContain("action:tab.switch.byDigit");
    expect(ids).not.toContain("action:app.settings.section.byDigit");
  });

  it("skips the app.palette.open action (loop prevention)", () => {
    const ids = captureItems().map((item) => item.id);
    expect(ids).not.toContain("action:app.palette.open");
  });

  it("skips composer.stash (owned by the context-gated composer source)", () => {
    const ids = captureItems().map((item) => item.id);
    expect(ids).not.toContain("action:composer.stash");
  });

  it("lists the desktop-only status-bar toggle on desktop", () => {
    const ids = captureItems().map((item) => item.id);
    expect(ids).toContain("action:app.status-bar.toggle");
  });

  it("omits desktop-only actions in the installed mobile app", () => {
    setMobileApp(true);

    const items = captureItems();
    const ids = items.map((item) => item.id);

    // The footer the toggle moves the usage controls into is never drawn on
    // the phone, and `AppShell` registers no handler there - so the row would
    // offer a command that cannot run.
    expect(ids).not.toContain("action:app.status-bar.toggle");
    for (const item of items) {
      if (item.actionId === null) continue;
      expect(ACTION_META[item.actionId].desktopOnly).toBe(false);
    }
    // The flag drops the desktop-only rows, not the source: everything else
    // still lists.
    expect(ids).toContain("action:app.settings.open");
  });

  it("reads the live shortcut from the keybinding store", () => {
    useKeybindingStore.getState().setBinding("app.settings.open", "mod+alt+s");
    const item = captureItems().find(
      (row) => row.id === "action:app.settings.open",
    );
    expect(item).toBeDefined();
    expect(item?.shortcut).toBe("mod+alt+s");
  });

  it("reflects an unbound action with a null shortcut", () => {
    useKeybindingStore.getState().clearBinding("app.settings.open");
    const item = captureItems().find(
      (row) => row.id === "action:app.settings.open",
    );
    expect(item?.shortcut).toBeNull();
  });

  // `isPaletteEligible` (actions.source.ts) special-cases app.home.open: its
  // dispatch handler no-ops while the Home tab is off, so a palette row that
  // does nothing would be worse than no row. Locks down both sides of that
  // gate so the row can't reappear stale while the setting is off, or stay
  // missing once it's on.
  describe("app.home.open row (gated on the homeTabEnabled setting)", () => {
    it("omits the row while the Home tab is off", () => {
      useSettingsStore.setState({ homeTabEnabled: false });
      const ids = captureItems().map((item) => item.id);
      expect(ids).not.toContain("action:app.home.open");
    });

    it("includes the row, with its live shortcut, once the Home tab is on", () => {
      useSettingsStore.setState({ homeTabEnabled: true });
      const item = captureItems().find(
        (row) => row.id === "action:app.home.open",
      );
      expect(item).toBeDefined();
      expect(item?.label).toBe("Go to Home");
      expect(item?.shortcut).toBe("mod+shift+h");
    });
  });
});
