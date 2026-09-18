import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import {
  captureSettingsOpener,
  enterCustomize,
  exitCustomize,
} from "@/lib/customize/enter-exit";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type { SystemModalActive } from "@/stores/tabs/use-system-tab-modal";
import { settingsSectionPath } from "@/stores/tabs/kinds/settings";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";

// Left untyped against `SystemTabModalApi` on purpose: an explicit return-type
// annotation would erase the `vi.fn()` mocks back down to plain `() => void`,
// and the tests below need `.toHaveBeenCalledWith` / `.mockClear()` on them.
function fakeModalApi(active: SystemModalActive | null) {
  return {
    active,
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
    promoteToTab: vi.fn(),
    isOverlayActive: () => false,
  };
}

function settingsPane(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(
    "[data-settings-panel-pane]",
  );
  if (existing) return existing;
  const pane = document.createElement("div");
  pane.setAttribute("data-settings-panel-pane", "");
  document.body.appendChild(pane);
  return pane;
}

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ visualLayoutEditorEnabled: true });
  useCustomizeStore.setState({
    session: null,
    instances: new Map(),
    history: { past: [], future: [] },
  });
});

afterEach(() => {
  // Leave no live session, lease heartbeat, or subscription behind.
  if (useCustomizeStore.getState().session) exitCustomize("done");
  setSystemTabModalApi(null);
  document
    .querySelectorAll("[data-settings-panel-pane]")
    .forEach((node) => node.remove());
  localStorage.clear();
});

describe("captureSettingsOpener + modal bridge restoration", () => {
  it("captures the open Settings modal's section and scroll offset", () => {
    const pane = settingsPane();
    pane.scrollTop = 240;
    setSystemTabModalApi(fakeModalApi({ kind: "settings", section: "layout" }));

    const opener = captureSettingsOpener();

    expect(opener).toEqual({
      kind: "settings-modal",
      section: "layout",
      scrollTop: 240,
    });
  });

  it("closes the modal on entry and reopens it at the same section + scroll on done", async () => {
    const pane = settingsPane();
    pane.scrollTop = 240;
    const modal = fakeModalApi({ kind: "settings", section: "layout" });
    setSystemTabModalApi(modal);
    const opener = captureSettingsOpener();

    const entered = enterCustomize({ scene: "in-place", opener, target: null });

    expect(entered).toBe(true);
    expect(modal.close).toHaveBeenCalledTimes(1);

    // Something else changed the pane's scroll while the session was live.
    pane.scrollTop = 999;

    exitCustomize("done");

    expect(modal.openSettings).toHaveBeenCalledWith({
      section: "layout",
      resetToGeneral: false,
    });
    await waitFor(() => expect(pane.scrollTop).toBe(240));
  });

  it("does not reopen the modal on escape's sibling reason: tab-switch", () => {
    const pane = settingsPane();
    pane.scrollTop = 240;
    const modal = fakeModalApi({ kind: "settings", section: "layout" });
    setSystemTabModalApi(modal);
    const opener = captureSettingsOpener();
    enterCustomize({ scene: "in-place", opener, target: null });
    modal.close.mockClear();

    // The tab-switch subscription set up by `enterCustomize` fires this itself
    // once `activeItemId` changes - no manual `exitCustomize` call needed.
    useTabsStore.setState({ activeItemId: "some-other-tab" });

    expect(useCustomizeStore.getState().session).toBeNull();
    expect(modal.openSettings).not.toHaveBeenCalled();
  });

  it("escape also restores the opener (same restoration path as done)", () => {
    const pane = settingsPane();
    pane.scrollTop = 100;
    const modal = fakeModalApi({ kind: "settings", section: "layout" });
    setSystemTabModalApi(modal);
    enterCustomize({
      scene: "in-place",
      opener: captureSettingsOpener(),
      target: null,
    });

    exitCustomize("escape");

    expect(modal.openSettings).toHaveBeenCalledWith({
      section: "layout",
      resetToGeneral: false,
    });
  });
});

describe("captureSettingsOpener + restoration: the settings-TAB path", () => {
  it("captures the active settings tab's section, and done restores it through the same modal bridge call", () => {
    useTabsStore.getState().openSystemTab({
      kind: "settings",
      name: "Settings",
      lastPath: settingsSectionPath("layout"),
    });
    const modal = fakeModalApi(null); // no modal open; the opener is a tab, not the modal
    setSystemTabModalApi(modal);

    const opener = captureSettingsOpener();
    expect(opener).toEqual({
      kind: "settings-tab",
      tabId: "settings",
      section: "layout",
      scrollTop: 0,
    });

    enterCustomize({ scene: "in-place", opener, target: null });
    exitCustomize("done");

    // `restoreOpener` also reactivates an already-open Settings tab through
    // this same bridge call - see its comment in `enter-exit.ts`.
    expect(modal.openSettings).toHaveBeenCalledWith({
      section: "layout",
      resetToGeneral: false,
    });
  });

  it("skips restoration when the settings tab was closed while the session was live", () => {
    useTabsStore.getState().openSystemTab({
      kind: "settings",
      name: "Settings",
      lastPath: settingsSectionPath("layout"),
    });
    const modal = fakeModalApi(null);
    setSystemTabModalApi(modal);
    const opener = captureSettingsOpener();
    enterCustomize({ scene: "in-place", opener, target: null });

    useTabsStore.getState().closeSystemTab("settings");

    exitCustomize("done");

    expect(modal.openSettings).not.toHaveBeenCalled();
  });
});
