import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerActivePromptStash,
  resetActivePromptStashForTests,
  stashActivePrompt,
} from "@/lib/commands/active-prompt-stash-registry";
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

describe("active-prompt-stash-registry", () => {
  beforeEach(() => resetActivePromptStashForTests());
  afterEach(() => resetActivePromptStashForTests());

  it("no-ops when no composer is registered", () => {
    expect(stashActivePrompt()).toBe(false);
    expect(dispatchAction("composer.stash", noopRouter())).toBe(false);
  });

  it("dispatches the top-of-stack action", () => {
    const base = vi.fn();
    const overlay = vi.fn();
    registerActivePromptStash(base);
    registerActivePromptStash(overlay);

    expect(stashActivePrompt()).toBe(true);
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(base).not.toHaveBeenCalled();
  });

  it("hands Mod+S back to the underlying composer when the overlay disposes", () => {
    const base = vi.fn();
    const overlay = vi.fn();
    registerActivePromptStash(base);
    const disposeOverlay = registerActivePromptStash(overlay);

    expect(dispatchAction("composer.stash", noopRouter())).toBe(true);
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(base).not.toHaveBeenCalled();

    disposeOverlay();
    expect(dispatchAction("composer.stash", noopRouter())).toBe(true);
    expect(base).toHaveBeenCalledTimes(1);
    expect(overlay).toHaveBeenCalledTimes(1);
  });

  it("dispose is idempotent and order-independent", () => {
    const a = vi.fn();
    const b = vi.fn();
    const disposeA = registerActivePromptStash(a);
    registerActivePromptStash(b);

    disposeA();
    disposeA();
    expect(stashActivePrompt()).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

  it("resetActivePromptStashForTests isolates suites by clearing the stack", () => {
    const leaked = vi.fn();
    registerActivePromptStash(leaked);
    resetActivePromptStashForTests();
    expect(stashActivePrompt()).toBe(false);
    expect(leaked).not.toHaveBeenCalled();
  });
});

describe("composer.stash action metadata + dispatch reservation", () => {
  it("defaults to mod+s, is repeat-sensitive, and is not externally handled", () => {
    expect(ACTION_META["composer.stash"]).toMatchObject({
      id: "composer.stash",
      kind: "chord",
      category: "app",
      defaultChord: "mod+s",
    });
    expect(getDefaultBindings()["composer.stash"]).toBe("mod+s");
    expect(isRepeatSensitiveAction("composer.stash")).toBe(true);
  });
});
