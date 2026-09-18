import type { NavigateFn } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  customizeLayoutAction,
  openSampleWorkspaceAction,
} from "@/lib/commands/actions/customize-layout";
import { activateTabIntent } from "@/lib/tab-navigation";
import {
  exitCustomize,
  getSampleWorkspaceOpener,
} from "@/lib/customize/enter-exit";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";

// Only the navigation entry point is replaced; every other export of the
// module stays real so `enter-exit` and the stores keep working.
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: vi.fn(() => true),
}));

const navigate: NavigateFn = vi.fn();

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

function sampleItemCount(): number {
  return useTabsStore
    .getState()
    .items.filter(
      (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
    ).length;
}

beforeEach(() => {
  localStorage.clear();
  setViewportWidth(1280);
  useSettingsStore.setState({ visualLayoutEditorEnabled: true });
  useCustomizeStore.setState({
    session: null,
    instances: new Map(),
    history: { past: [], future: [] },
  });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  vi.mocked(activateTabIntent).mockClear();
});

afterEach(() => {
  if (useCustomizeStore.getState().session) exitCustomize("done");
  setSystemTabModalApi(null);
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  setViewportWidth(1280);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("customizeLayoutAction", () => {
  it("enters the editor when the switch is on at desktop width", () => {
    customizeLayoutAction("command_palette");

    expect(useCustomizeStore.getState().session).not.toBeNull();
  });

  it("does nothing when the switch is off", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });

    customizeLayoutAction("command_palette");

    expect(useCustomizeStore.getState().session).toBeNull();
  });

  it("does nothing at a mobile viewport width", () => {
    setViewportWidth(500);

    customizeLayoutAction("command_palette");

    expect(useCustomizeStore.getState().session).toBeNull();
  });
});

describe("openSampleWorkspaceAction", () => {
  it("opens the sample tab and activates its intent when the switch is on at desktop width", () => {
    openSampleWorkspaceAction(navigate);

    expect(sampleItemCount()).toBe(1);
    expect(activateTabIntent).toHaveBeenCalledTimes(1);
    expect(activateTabIntent).toHaveBeenCalledWith(
      navigate,
      { kind: "sample-workspace" },
      undefined,
    );
  });

  it("hands the captured opener to the sample workspace", () => {
    setSystemTabModalApi({
      active: { kind: "settings", section: "layout" },
      openSettings: vi.fn(),
      openHistory: vi.fn(),
      close: vi.fn(),
      setSection: vi.fn(),
      promoteToTab: vi.fn(),
      isOverlayActive: () => false,
    });

    openSampleWorkspaceAction(navigate);

    expect(getSampleWorkspaceOpener()).toMatchObject({
      kind: "settings-modal",
      section: "layout",
    });
  });

  it("opening twice still yields one tab", () => {
    openSampleWorkspaceAction(navigate);
    openSampleWorkspaceAction(navigate);

    expect(sampleItemCount()).toBe(1);
    expect(activateTabIntent).toHaveBeenCalledTimes(2);
  });

  it("is gated off when the switch is off", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });

    openSampleWorkspaceAction(navigate);

    expect(sampleItemCount()).toBe(0);
    expect(activateTabIntent).not.toHaveBeenCalled();
  });

  it("is gated off at a mobile viewport width", () => {
    setViewportWidth(500);

    openSampleWorkspaceAction(navigate);

    expect(sampleItemCount()).toBe(0);
    expect(activateTabIntent).not.toHaveBeenCalled();
  });
});
