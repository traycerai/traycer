/**
 * Talk's shortcut (`voice.talk.toggle`) through the real keybinding provider,
 * beside dictation's own hotkey singleton: each chord drives only its own
 * action. The voice session's owner is a fake driver; everything between the
 * key event and the driver runs real.
 */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformMock } from "@/__tests__/create-platform-mock";
import { useDictationHotkey } from "@/hooks/composer/use-dictation-hotkey";
import { reservedBrowserChordsFor } from "@/lib/browser-view/reserved-chords-registration";
import { actionsSource } from "@/lib/commands/sources/actions.source";
import type { CommandContext } from "@/lib/commands/types";
import {
  effectiveBinding,
  getDefaultBindings,
} from "@/lib/keybindings/actions";
import { findActionMatchForChord } from "@/lib/keybindings/dispatch";
import { setMobileApp } from "@/lib/mobile-app";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { routeTree } from "@/routeTree.gen";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import {
  useVoiceSessionStore,
  type VoicePhase,
} from "@/stores/voice/voice-session-store";
import { TalkShortcutBridge } from "../talk-control";

const platformMock = vi.hoisted(() => ({ mac: false }));
vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));

const driver = {
  start: vi.fn<() => void>(),
  end: vi.fn<() => void>(),
  setMuted: vi.fn<(muted: boolean) => void>(),
};
const dictation = {
  start: vi.fn<() => void>(),
  stop: vi.fn<() => void>(),
  cancel: vi.fn<() => void>(),
};
const initialVoice = useVoiceSessionStore.getState();

function renderShell(): void {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: {
      queryClient: new QueryClient(),
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => null,
    },
  });
  render(
    <KeybindingProvider router={router}>
      <TalkShortcutBridge />
    </KeybindingProvider>,
  );
  renderHook(() =>
    useDictationHotkey({
      enabled: true,
      state: "idle",
      start: dictation.start,
      stop: dictation.stop,
      cancel: dictation.cancel,
    }),
  );
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

/** Talk's default off macOS: Alt+Shift+T. */
function pressTalk(repeat: boolean): KeyboardEvent {
  return press({
    code: "KeyT",
    key: "T",
    altKey: true,
    shiftKey: true,
    repeat,
  });
}

/** Dictation's default: Control+Shift+M. */
function pressDictation(): void {
  press({ code: "KeyM", key: "M", ctrlKey: true, shiftKey: true });
  // Released at once: a tap, so the hotkey's press state settles.
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keyup", { code: "KeyM", bubbles: true }),
    );
  });
}

function setPhase(phase: VoicePhase): void {
  useVoiceSessionStore.setState({ phase });
}

beforeEach(() => {
  platformMock.mac = false;
  useKeybindingStore.setState({ bindings: getDefaultBindings() });
  useVoiceSessionStore.setState(initialVoice, true);
  useVoiceSessionStore.setState({ availability: "live", driver });
  renderShell();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useVoiceSessionStore.setState(initialVoice, true);
});

describe("the Talk shortcut", () => {
  it("starts a session when none runs and ends a live or connecting one, without touching dictation", () => {
    const event = pressTalk(false);
    expect(event.defaultPrevented).toBe(true);
    expect(driver.start).toHaveBeenCalledTimes(1);

    setPhase("connecting");
    pressTalk(false);
    setPhase("live");
    pressTalk(false);
    expect(driver.end).toHaveBeenCalledTimes(2);
    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(dictation.start).not.toHaveBeenCalled();
    expect(dictation.stop).not.toHaveBeenCalled();
  });

  it("toggles once per press: a held chord's repeats do not flip the session", () => {
    pressTalk(false);
    pressTalk(true);
    pressTalk(true);
    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(driver.end).not.toHaveBeenCalled();
  });

  it("starts nothing while Talk could not: no voice offered, or no bot to talk to", () => {
    useVoiceSessionStore.setState({ availability: "dormant" });
    pressTalk(false);
    useVoiceSessionStore.setState({
      availability: "live",
      destinationKnown: false,
    });
    pressTalk(false);
    expect(driver.start).not.toHaveBeenCalled();
  });

  it("is not dictation's chord: dictation toggles dictation alone", () => {
    pressDictation();
    expect(dictation.start).toHaveBeenCalledTimes(1);
    expect(driver.start).not.toHaveBeenCalled();
    expect(driver.end).not.toHaveBeenCalled();
  });
});

describe("the Talk shortcut in the installed mobile app", () => {
  it("takes no key: Talk is desktop-only, so nothing there would run it", () => {
    cleanup();
    setMobileApp(true);
    try {
      renderShell();
      const event = pressTalk(false);
      expect(event.defaultPrevented).toBe(false);
      expect(driver.start).not.toHaveBeenCalled();
    } finally {
      setMobileApp(false);
    }
  });

  it("leaves the vertical-tabs collapse chord unmatched too: every desktop-only action is", () => {
    const bindings = useKeybindingStore.getState().bindings;
    const chord = bindings["app.tabs.vertical.collapse"];
    expect(chord).toBe("shift+alt+s");
    if (chord === null) return;
    setMobileApp(true);
    try {
      expect(effectiveBinding(bindings, "app.tabs.vertical.collapse")).toBe(
        null,
      );
      expect(findActionMatchForChord(chord)).toBeNull();
    } finally {
      setMobileApp(false);
    }
  });
});

describe("the Talk shortcut while a browser tile has the keyboard", () => {
  it("starts and ends the session from a streamed tile, default chord and a rebind alike", () => {
    useScreencastArmedStore.getState().claim("streamed-tile", vi.fn());
    try {
      const first = pressTalk(false);
      expect(first.defaultPrevented).toBe(true);
      expect(driver.start).toHaveBeenCalledTimes(1);
      setPhase("live");
      pressTalk(false);
      expect(driver.end).toHaveBeenCalledTimes(1);

      setPhase("idle");
      useKeybindingStore
        .getState()
        .setBinding("voice.talk.toggle", "mod+shift+y");
      press({ code: "KeyY", key: "Y", ctrlKey: true, shiftKey: true });
      expect(driver.start).toHaveBeenCalledTimes(2);
      expect(dictation.start).not.toHaveBeenCalled();
    } finally {
      useScreencastArmedStore.getState().release("streamed-tile");
    }
  });

  it("is forwarded from a focused native tile by its live binding, and its old chord goes back to the page", () => {
    const talkTokens = (): ReadonlyArray<string> =>
      reservedBrowserChordsFor(useKeybindingStore.getState().bindings, {
        landingSurfaceActive: false,
      })
        .filter((row) => row.command === null)
        .map((row) => row.token);
    expect(talkTokens()).toContain("shift+alt+t");
    useKeybindingStore
      .getState()
      .setBinding("voice.talk.toggle", "mod+shift+y");
    expect(talkTokens()).toContain("mod+shift+y");
    expect(talkTokens()).not.toContain("shift+alt+t");
  });
});

/** The palette's context: nothing open, at the root. */
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

describe("Talk in the command palette", () => {
  it("is offered exactly while Talk would start or end a session", () => {
    const talkRow = (): boolean =>
      renderHook(() =>
        actionsSource.useItems(paletteContext()),
      ).result.current.some((item) => item.actionId === "voice.talk.toggle");
    expect(talkRow()).toBe(true);
    useVoiceSessionStore.setState({ availability: "dormant" });
    expect(talkRow()).toBe(false);
    useVoiceSessionStore.setState({
      availability: "live",
      destinationKnown: false,
    });
    expect(talkRow()).toBe(false);
    // A running session can always be ended, bot or none.
    setPhase("live");
    expect(talkRow()).toBe(true);
    setPhase("ending");
    expect(talkRow()).toBe(false);
  });
});
