import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerActiveDraftsControl,
  resetActiveDraftsControlForTests,
  openActiveDraftsControl,
  type DraftsControlEntryPoint,
} from "@/lib/commands/active-drafts-control-registry";
import {
  dispatchAction,
  openDrafts,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { ACTION_META, getDefaultBindings } from "@/lib/keybindings/actions";
import { isRepeatSensitiveAction } from "@/lib/keybindings/dispatch";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
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

// H12: `Cmd+S` opens the start-page control when one is active; anywhere else
// it opens the avatar menu's Drafts dialog, remembering which entry point
// asked (`draftsEntryPoint`). `openDrafts` is the shared seam the shortcut's
// static handler and the palette's own row both call - only the SHORTCUT arm
// fires `drafts_shortcut_redirected` (the ticket restricts the event to that
// one entry point).
describe("composer.drafts / openDrafts falling back to the avatar Drafts dialog", () => {
  beforeEach(() => {
    resetActiveDraftsControlForTests();
    useDesktopDialogStore.getState().close();
  });
  afterEach(() => {
    resetActiveDraftsControlForTests();
    useDesktopDialogStore.getState().close();
    vi.restoreAllMocks();
  });

  it("opens the dialog and fires drafts_shortcut_redirected for the shortcut fallback", () => {
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);

    expect(dispatchAction("composer.drafts", noopRouter())).toBe(true);

    expect(useDesktopDialogStore.getState().activeDialog).toBe("drafts");
    expect(useDesktopDialogStore.getState().draftsEntryPoint).toBe("shortcut");
    expect(trackSpy).toHaveBeenCalledWith(
      AnalyticsEvent.DraftsShortcutRedirected,
      null,
    );
  });

  it("prefers the real registry over the dialog when a composer is active, firing no redirect event", () => {
    const composer = vi.fn<(entryPoint: DraftsControlEntryPoint) => void>();
    registerActiveDraftsControl(composer);
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);

    expect(dispatchAction("composer.drafts", noopRouter())).toBe(true);

    expect(composer).toHaveBeenCalledWith("shortcut");
    expect(useDesktopDialogStore.getState().activeDialog).toBe(null);
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it("routes the palette's own openDrafts to the dialog too, but never fires the shortcut-redirect event", () => {
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);

    expect(openDrafts("palette")).toBe(true);

    expect(useDesktopDialogStore.getState().activeDialog).toBe("drafts");
    expect(useDesktopDialogStore.getState().draftsEntryPoint).toBe("palette");
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.DraftsShortcutRedirected,
      expect.anything(),
    );
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
    });
    expect(getDefaultBindings()["composer.drafts"]).toBe("mod+s");
    expect(isRepeatSensitiveAction("composer.drafts")).toBe(true);
  });
});
