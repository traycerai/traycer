import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  matchDigitAction,
  registerBaseLeaderScope,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useTabsStore } from "@/stores/tabs/store";
import { resetTabsStoreForTest } from "@/stores/tabs/test-support/tabs-store-fixtures";
import type { SettingsSectionId } from "@/lib/settings-sections";
import {
  __resetThanosFlagsForTesting,
  __setThanosSingleUserChromeForTests,
} from "@/lib/thanos-flags";

function buildRouter(initialPath: string): {
  readonly router: KeybindingRouter;
  readonly sections: Array<SettingsSectionId>;
} {
  const sections: Array<SettingsSectionId> = [];
  let pathname = initialPath;
  const router: KeybindingRouter = {
    getPathname: () => pathname,
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: (sectionId) => {
      sections.push(sectionId);
      pathname = `/settings/${sectionId}`;
    },
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
  return { router, sections };
}

function fireSettingsDigit(router: KeybindingRouter, digit: number): boolean {
  const unregister = registerBaseLeaderScope(router);
  try {
    const match = matchDigitAction(
      new KeyboardEvent("keydown", {
        code: `Digit${digit}`,
        altKey: true,
      }),
    );
    return match === null ? false : match.run();
  } finally {
    unregister();
  }
}

describe("settings section leader digits", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    resetTabsStoreForTest();
    useTabsStore.getState().openSystemTab({
      kind: "settings",
      name: "Settings",
      lastPath: "/settings/general",
    });
  });

  afterEach(() => {
    __resetThanosFlagsForTesting();
  });

  it("navigates to devices and usage while account chrome is visible", () => {
    const { router, sections } = buildRouter("/settings/general");
    expect(fireSettingsDigit(router, 4)).toBe(true);
    expect(fireSettingsDigit(router, 5)).toBe(true);
    expect(sections).toEqual(["devices", "usage"]);
  });

  it("no-ops on devices and usage digits when Thanos single-user chrome is on", () => {
    __setThanosSingleUserChromeForTests(true);
    const { router, sections } = buildRouter("/settings/general");
    expect(fireSettingsDigit(router, 4)).toBe(false);
    expect(fireSettingsDigit(router, 5)).toBe(false);
    expect(sections).toEqual([]);
  });

  it("keeps visible-section digit indices when Thanos single-user chrome is on", () => {
    __setThanosSingleUserChromeForTests(true);
    const { router, sections } = buildRouter("/settings/general");
    expect(fireSettingsDigit(router, 1)).toBe(true);
    expect(fireSettingsDigit(router, 2)).toBe(true);
    expect(fireSettingsDigit(router, 3)).toBe(true);
    expect(sections).toEqual(["general", "appearance", "keybindings"]);
  });
});
