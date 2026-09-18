import type { CommandContext } from "@/lib/commands/types";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { customizeSource } from "@/lib/commands/sources/customize.source";
import { useCustomizeStore } from "@/stores/customize/customize-store";
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

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  setViewportWidth(1280);
  useSettingsStore.setState({ visualLayoutEditorEnabled: true });
  useCustomizeStore.setState({ lockedBy: "none" });
});

afterEach(() => {
  setViewportWidth(1280);
});

describe("customizeSource", () => {
  it("resolves the two layout commands when the switch is on, at desktop width, and unlocked", () => {
    const { result } = renderHook(() => customizeSource.useItems(ctx()));

    const ids = result.current.map((item) => item.id);
    expect(ids).toEqual(["customize:layout", "customize:sample"]);
    expect(result.current.every((item) => typeof item.run === "function")).toBe(
      true,
    );
  });

  it("resolves nothing when the switch is off", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });

    const { result } = renderHook(() => customizeSource.useItems(ctx()));

    expect(result.current).toEqual([]);
  });

  it("resolves nothing at a mobile viewport width", () => {
    setViewportWidth(500);

    const { result } = renderHook(() => customizeSource.useItems(ctx()));

    expect(result.current).toEqual([]);
  });

  it("resolves a single disabled row naming the lock when another window holds the lease", () => {
    useCustomizeStore.setState({ lockedBy: "other-window" });

    const { result } = renderHook(() => customizeSource.useItems(ctx()));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      id: "customize:locked",
      disabled: true,
      label: "Finish customizing in the other window",
    });
  });

  it("re-resolves live when the lock is released", () => {
    useCustomizeStore.setState({ lockedBy: "other-window" });
    const { result } = renderHook(() => customizeSource.useItems(ctx()));
    expect(result.current[0]?.id).toBe("customize:locked");

    act(() => {
      useCustomizeStore.setState({ lockedBy: "none" });
    });

    expect(result.current.map((item) => item.id)).toEqual([
      "customize:layout",
      "customize:sample",
    ]);
  });
});
