import { describe, expect, it } from "vitest";
import { openSource } from "@/lib/commands/sources/open.source";
import { readSyncItems } from "./source-test-utils";
import type { CommandContext } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

function noopRouter(): KeybindingRouter {
  return {
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
  };
}

function ctx(targetGroupId: string | null): CommandContext {
  return {
    pathname: "/",
    router: noopRouter(),
    activeTabId: "tab-1",
    activeEpicId: "epic-1",
    focusedComposerKind: null,
    targetGroupId,
  };
}

describe("openSource", () => {
  it("emits nothing for the global palette (no bound target)", () => {
    expect(readSyncItems(openSource.getItems(ctx(null)))).toEqual([]);
  });

  it("emits the opener categories when bound to a target group", () => {
    const items = readSyncItems(openSource.getItems(ctx("group-1")));
    expect(items.map((item) => item.label)).toEqual([
      "Chats",
      "TUI agents",
      "Terminals",
      "Artifacts",
      "Files",
      "Diff",
    ]);
    for (const item of items) {
      expect(item.group).toBe("open");
      expect(item.subpage).not.toBeNull();
    }
  });

  it("every category entry carries a pushable sub-page", () => {
    const items = readSyncItems(openSource.getItems(ctx("group-1")));
    // Sub-page item lists are hooks (live records / file trees), exercised in
    // the per-sub-page renderHook tests; here we only assert the wiring.
    for (const item of items) {
      expect(item.subpage).not.toBeNull();
      expect(item.subpage?.id).toBe(item.id.replace("open:category:", "open:"));
    }
  });
});
