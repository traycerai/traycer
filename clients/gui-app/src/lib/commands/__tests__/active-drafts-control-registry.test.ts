import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerActiveDraftsControl,
  resetActiveDraftsControlForTests,
  openActiveDraftsControl,
} from "@/lib/commands/active-drafts-control-registry";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { ACTION_META, getDefaultBindings } from "@/lib/keybindings/actions";
import { isRepeatSensitiveAction } from "@/lib/keybindings/dispatch";

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

describe("active-drafts-control-registry", () => {
  beforeEach(() => resetActiveDraftsControlForTests());
  afterEach(() => resetActiveDraftsControlForTests());

  it("no-ops when no composer is registered", () => {
    expect(openActiveDraftsControl()).toBe(false);
    expect(dispatchAction("composer.drafts", noopRouter())).toBe(false);
  });

  it("dispatches the top-of-stack action", () => {
    const base = vi.fn();
    const overlay = vi.fn();
    registerActiveDraftsControl(base);
    registerActiveDraftsControl(overlay);

    expect(openActiveDraftsControl()).toBe(true);
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(base).not.toHaveBeenCalled();
  });

  it("hands Mod+S back to the underlying composer when the overlay disposes", () => {
    const base = vi.fn();
    const overlay = vi.fn();
    registerActiveDraftsControl(base);
    const disposeOverlay = registerActiveDraftsControl(overlay);

    expect(dispatchAction("composer.drafts", noopRouter())).toBe(true);
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(base).not.toHaveBeenCalled();

    disposeOverlay();
    expect(dispatchAction("composer.drafts", noopRouter())).toBe(true);
    expect(base).toHaveBeenCalledTimes(1);
    expect(overlay).toHaveBeenCalledTimes(1);
  });

  it("dispose is idempotent and order-independent", () => {
    const a = vi.fn();
    const b = vi.fn();
    const disposeA = registerActiveDraftsControl(a);
    registerActiveDraftsControl(b);

    disposeA();
    disposeA();
    expect(openActiveDraftsControl()).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

  it("resetActiveDraftsControlForTests isolates suites by clearing the stack", () => {
    const leaked = vi.fn();
    registerActiveDraftsControl(leaked);
    resetActiveDraftsControlForTests();
    expect(openActiveDraftsControl()).toBe(false);
    expect(leaked).not.toHaveBeenCalled();
  });
});

describe("composer.drafts action metadata + dispatch reservation", () => {
  it("defaults to mod+s, is repeat-sensitive, and is not externally handled", () => {
    expect(ACTION_META["composer.drafts"]).toMatchObject({
      id: "composer.drafts",
      kind: "chord",
      category: "app",
      defaultChord: "mod+s",
    });
    expect(getDefaultBindings()["composer.drafts"]).toBe("mod+s");
    expect(isRepeatSensitiveAction("composer.drafts")).toBe(true);
  });
});
