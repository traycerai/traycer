import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerActiveDraftsControl,
  resetActiveDraftsControlForTests,
  openActiveDraftsControl,
  hasActiveDraftsControl,
  subscribeActiveDraftsControl,
  type DraftsControlEntryPoint,
} from "@/lib/commands/active-drafts-control-registry";
import {
  dispatchAction,
  openDrafts,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { ACTION_META, getDefaultBindings } from "@/lib/keybindings/actions";
import { isRepeatSensitiveAction } from "@/lib/keybindings/dispatch";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

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
  beforeEach(() => {
    resetActiveDraftsControlForTests();
    useDesktopDialogStore.getState().close();
  });
  afterEach(() => {
    resetActiveDraftsControlForTests();
    useDesktopDialogStore.getState().close();
    vi.restoreAllMocks();
  });

  it("no-ops when no composer is registered", () => {
    expect(openActiveDraftsControl("shortcut")).toBe(false);
    expect(hasActiveDraftsControl()).toBe(false);
  });

  it("notifies subscribers when the stack becomes empty or non-empty", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveDraftsControl(listener);
    const dispose = registerActiveDraftsControl(() => undefined);
    expect(hasActiveDraftsControl()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    expect(hasActiveDraftsControl()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    registerActiveDraftsControl(() => undefined);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("dispatches the top-of-stack action, passing its entry point through", () => {
    const base = vi.fn<(entryPoint: DraftsControlEntryPoint) => void>();
    const overlay = vi.fn<(entryPoint: DraftsControlEntryPoint) => void>();
    registerActiveDraftsControl(base);
    registerActiveDraftsControl(overlay);

    expect(openActiveDraftsControl("palette")).toBe(true);
    expect(overlay).toHaveBeenCalledWith("palette");
    expect(base).not.toHaveBeenCalled();
  });

  it("hands Mod+S back to the underlying composer when the overlay disposes", () => {
    const base = vi.fn<(entryPoint: DraftsControlEntryPoint) => void>();
    const overlay = vi.fn<(entryPoint: DraftsControlEntryPoint) => void>();
    registerActiveDraftsControl(base);
    const disposeOverlay = registerActiveDraftsControl(overlay);

    expect(dispatchAction("composer.drafts", noopRouter())).toBe(true);
    expect(overlay).toHaveBeenCalledWith("shortcut");
    expect(base).not.toHaveBeenCalled();

    disposeOverlay();
    expect(dispatchAction("composer.drafts", noopRouter())).toBe(true);
    expect(base).toHaveBeenCalledWith("shortcut");
    expect(overlay).toHaveBeenCalledTimes(1);
  });

  it("dispose is idempotent and order-independent", () => {
    const a = vi.fn();
    const b = vi.fn();
    const disposeA = registerActiveDraftsControl(a);
    registerActiveDraftsControl(b);

    disposeA();
    disposeA();
    expect(openActiveDraftsControl("shortcut")).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

  it("resetActiveDraftsControlForTests isolates suites by clearing the stack", () => {
    const leaked = vi.fn();
    registerActiveDraftsControl(leaked);
    resetActiveDraftsControlForTests();
    expect(openActiveDraftsControl("shortcut")).toBe(false);
    expect(leaked).not.toHaveBeenCalled();
  });
});

// H13: `Cmd+S` opens the start-page control when one is active and does
// nothing anywhere else. The palette still uses `openDrafts`, which prefers
// the control and otherwise opens the avatar Drafts dialog.
describe("composer.drafts / openDrafts", () => {
  beforeEach(() => {
    resetActiveDraftsControlForTests();
    useDesktopDialogStore.getState().close();
  });
  afterEach(() => {
    resetActiveDraftsControlForTests();
    useDesktopDialogStore.getState().close();
    vi.restoreAllMocks();
  });

  it("does not open the dialog or swallow Cmd+S when no start-page control is active", () => {
    expect(dispatchAction("composer.drafts", noopRouter())).toBe(false);
    expect(useDesktopDialogStore.getState().activeDialog).toBe(null);
  });

  it("opens the registered start-page control and never the dialog", () => {
    const composer = vi.fn<(entryPoint: DraftsControlEntryPoint) => void>();
    registerActiveDraftsControl(composer);

    expect(dispatchAction("composer.drafts", noopRouter())).toBe(true);

    expect(composer).toHaveBeenCalledWith("shortcut");
    expect(useDesktopDialogStore.getState().activeDialog).toBe(null);
  });

  it("routes the palette's own openDrafts to the dialog when no control is active", () => {
    expect(openDrafts("palette")).toBe(true);

    expect(useDesktopDialogStore.getState().activeDialog).toBe("drafts");
    expect(useDesktopDialogStore.getState().draftsEntryPoint).toBe("palette");
  });

  it("routes the palette to the real registry over the dialog when a composer is active", () => {
    const composer = vi.fn<(entryPoint: DraftsControlEntryPoint) => void>();
    registerActiveDraftsControl(composer);

    expect(openDrafts("palette")).toBe(true);

    expect(composer).toHaveBeenCalledWith("palette");
    expect(useDesktopDialogStore.getState().activeDialog).toBe(null);
  });
});

describe("composer.drafts action metadata + dispatch reservation", () => {
  it("defaults to mod+s, is repeat-sensitive, and is not externally handled", () => {
    expect(ACTION_META["composer.drafts"]).toMatchObject({
      id: "composer.drafts",
      kind: "chord",
      category: "app",
      defaultChord: "mod+s",
      description: "Open the start-page drafts list.",
    });
    expect(getDefaultBindings()["composer.drafts"]).toBe("mod+s");
    expect(isRepeatSensitiveAction("composer.drafts")).toBe(true);
  });
});
