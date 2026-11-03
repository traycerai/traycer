/**
 * The soundtrack's palette row and keybinding through the real command
 * registry, dispatch and settings store, behind a fake audio device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook } from "@testing-library/react";
import { SoundtrackShortcutBridge } from "@/components/layout/soundtrack/soundtrack-control";
import { actionsSource } from "@/lib/commands/sources/actions.source";
import { runCommandItem } from "@/lib/commands/dispatch";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { findActionMatchForChord } from "@/lib/keybindings/dispatch";
import {
  getDefaultBindings,
  isActionAvailable,
} from "@/lib/keybindings/actions";
import {
  openedFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
  return { openWebAudioPorts: openFakePorts };
});

function paletteContext(): CommandContext {
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

function soundtrackRow(): CommandItem | undefined {
  return renderHook(() =>
    actionsSource.useItems(paletteContext()),
  ).result.current.find((item) => item.actionId === "soundtrack.toggle");
}

function offer(): void {
  vi.stubEnv("MODE", "development");
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          trackNames: [],
          views: { home: [], task: [], bot: [], settings: [] },
          stems: { tracks: [] },
        }),
      ),
    ),
  );
}

beforeEach(() => {
  resetFakePorts();
  useSettingsStore.setState({ soundtrackEnabled: false });
  useKeybindingStore.setState({ bindings: getDefaultBindings() });
});

afterEach(() => {
  cleanup();
  useSoundtrackStore.getState().disable();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the soundtrack in the command palette", () => {
  it("has no row in a build with nothing to play", () => {
    expect(soundtrackRow()).toBeUndefined();
  });

  it("has a row when offered, and running it toggles the session through the real dispatch", async () => {
    offer();
    render(<SoundtrackShortcutBridge />);
    const row = soundtrackRow();
    expect(row).toBeDefined();
    if (row === undefined) return;
    const hooks = { recordUse: vi.fn(), close: vi.fn() };

    await runCommandItem(row, paletteContext(), hooks);
    await vi.waitFor(() => {
      expect(openedFakePorts).toHaveLength(1);
    });
    expect(useSettingsStore.getState().soundtrackEnabled).toBe(true);
    expect(useSoundtrackStore.getState().enabled).toBe(true);

    await runCommandItem(row, paletteContext(), hooks);
    expect(useSettingsStore.getState().soundtrackEnabled).toBe(false);
    expect(useSoundtrackStore.getState().enabled).toBe(false);
  });

  it("drops its keybinding from the matcher when not offered, and keeps it when offered", () => {
    useKeybindingStore
      .getState()
      .setBinding("soundtrack.toggle", "mod+shift+y");
    expect(isActionAvailable("soundtrack.toggle")).toBe(false);
    expect(findActionMatchForChord("mod+shift+y")).toBeNull();

    offer();
    expect(isActionAvailable("soundtrack.toggle")).toBe(true);
    expect(findActionMatchForChord("mod+shift+y")?.actionId).toBe(
      "soundtrack.toggle",
    );
  });
});
