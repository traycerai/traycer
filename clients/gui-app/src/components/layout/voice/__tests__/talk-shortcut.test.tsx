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
import { actionsSource } from "@/lib/commands/sources/actions.source";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { routeTree } from "@/routeTree.gen";
import { useAuthStore } from "@/stores/auth/auth-store";
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
  return press({ code: "KeyT", key: "T", altKey: true, shiftKey: true, repeat });
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

describe("Talk in the command palette", () => {
  it("is offered only while this window can talk", () => {
    const talkRow = (): boolean =>
      renderHook(() => actionsSource.useItems()).result.current.some(
        (item) => item.actionId === "voice.talk.toggle",
      );
    expect(talkRow()).toBe(true);
    useVoiceSessionStore.setState({ availability: "dormant" });
    expect(talkRow()).toBe(false);
  });
});
