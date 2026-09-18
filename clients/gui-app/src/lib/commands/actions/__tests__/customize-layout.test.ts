import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  customizeLayoutAction,
  openSampleWorkspaceAction,
} from "@/lib/commands/actions/customize-layout";
import { exitCustomize } from "@/lib/customize/enter-exit";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
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
});

afterEach(() => {
  if (useCustomizeStore.getState().session) exitCustomize("done");
  setViewportWidth(1280);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("customizeLayoutAction", () => {
  it("enters the editor when the switch is on at desktop width", () => {
    customizeLayoutAction();

    expect(useCustomizeStore.getState().session).not.toBeNull();
  });

  it("does nothing when the switch is off", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });

    customizeLayoutAction();

    expect(useCustomizeStore.getState().session).toBeNull();
  });

  it("does nothing at a mobile viewport width", () => {
    setViewportWidth(500);

    customizeLayoutAction();

    expect(useCustomizeStore.getState().session).toBeNull();
  });
});

describe("openSampleWorkspaceAction", () => {
  it("shows the arriving stub when the switch is on at desktop width", () => {
    const info = vi.spyOn(toast, "info");

    openSampleWorkspaceAction();

    expect(info).toHaveBeenCalledWith("Sample workspace is arriving");
  });

  it("is gated off when the switch is off", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });
    const info = vi.spyOn(toast, "info");

    openSampleWorkspaceAction();

    expect(info).not.toHaveBeenCalled();
  });

  it("is gated off at a mobile viewport width", () => {
    setViewportWidth(500);
    const info = vi.spyOn(toast, "info");

    openSampleWorkspaceAction();

    expect(info).not.toHaveBeenCalled();
  });
});
