import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { themeSource } from "@/lib/commands/sources/theme.source";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { readSyncItems } from "./source-test-utils";

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

function captureSubpageItems(): ReadonlyArray<CommandItem> {
  const root = readSyncItems(themeSource.getItems(ctx()));
  const change = root[0];
  if (change.subpage === null) throw new Error("theme subpage missing");
  const subpage = change.subpage;
  let captured: ReadonlyArray<CommandItem> = [];
  function Probe() {
    captured = subpage.useItems(ctx());
    return null;
  }
  render(<Probe />);
  return captured;
}

describe("themeSource", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useSettingsStore.getState().setTheme("system");
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.getState().setTheme("system");
  });

  it("emits a single 'Change theme' root entry", () => {
    const root = readSyncItems(themeSource.getItems(ctx()));
    expect(root).toHaveLength(1);
    expect(root[0].id).toBe("theme:change");
    expect(root[0].subpage?.id).toBe("theme:pick");
  });

  it("sub-page emits Light / Dark / System items", () => {
    const ids = captureSubpageItems().map((i) => i.id);
    expect(ids).toEqual(["theme:light", "theme:dark", "theme:system"]);
  });

  it("running a theme item flips useSettingsStore.theme", () => {
    const item = captureSubpageItems().find((row) => row.id === "theme:dark");
    expect(item).toBeDefined();
    if (item === undefined) return;
    void item.run(ctx());
    expect(useSettingsStore.getState().theme).toBe("dark");
  });
});
