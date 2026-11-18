/**
 * Product-policy contract: the installed mobile app dictates only through the
 * phone's own recognizer.
 *
 * Host dictation streams the mic audio to the app-wide host, which transcribes
 * it. Desktop's app-wide host is the local machine, so "audio never leaves
 * your machine" holds; the mobile app has no local host, so it cannot hold.
 * The gate therefore keys on the BUILD: a mobile app with no recognizer of its
 * own offers nothing about dictation (mic button, preparing indicator, hotkey,
 * or even the host RPC), a mobile app with one offers the mic once the device
 * can transcribe the language - still without touching the host - and the
 * desktop build is untouched.
 *
 * Everything below the composer hook runs real - the availability hook, the
 * hotkey singleton and the keybinding store included. Only the recorder (mic +
 * host stream) and the host RPC transport are faked.
 */
import type { RefObject } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setMobileApp } from "@/lib/mobile-app";
import { createAppQueryClient } from "@/lib/query-client";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type { IDeviceDictationHost } from "@traycer-clients/shared/platform/runner-host";

const recorder = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  toggle: vi.fn(),
  cancel: vi.fn(),
}));

const host = vi.hoisted(() => ({
  ensureModel: vi.fn(),
  // Every observed `enabled` the status query was asked for, so a test can
  // assert the speech RPC is never even armed on mobile.
  statusQueryEnabled: [] as boolean[],
}));

vi.mock("@/hooks/composer/use-voice-dictation", () => ({
  useVoiceDictation: () => ({
    state: "idle" as const,
    errorMessage: null,
    failureClass: null,
    permissionDenied: false,
    start: recorder.start,
    stop: recorder.stop,
    toggle: recorder.toggle,
    cancel: recorder.cancel,
    getStream: () => null,
  }),
}));

// The shell's own recognizer, when it has one; `null` is a mobile app (or any
// shell) without it.
const runnerHostState = vi.hoisted(
  (): { deviceDictation: IDeviceDictationHost | null } => ({
    deviceDictation: null,
  }),
);

vi.mock("@/providers/use-runner-host", () => {
  const runnerHost = () => ({
    openMicrophoneSettings: () => Promise.resolve(),
    deviceDictation: runnerHostState.deviceDictation,
  });
  return { useRunnerHost: runnerHost, useRunnerHostOrNull: runnerHost };
});

// The availability hook resolves the person's selected host explicitly:
// `resolveAppWideHostClient(useHostBinding(), useEffectiveHostId())`.
vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    hostClient: {
      createRequesterForHostId: (hostId: string | null) => ({
        getActiveHostId: () => hostId,
      }),
    },
  }),
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-1",
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly options: { readonly enabled: boolean };
  }): { readonly data: unknown } => {
    host.statusQueryEnabled.push(args.options.enabled);
    // A host that is fully ready to dictate - so anything the mobile build
    // still shows would be a real leak, not an artifact of an idle host.
    return args.options.enabled
      ? {
          data: {
            engineAvailable: true,
            downloadState: "ready",
            downloadProgress: null,
          },
        }
      : { data: undefined };
  },
  useHostMutation: () => ({ mutate: host.ensureModel, isPending: false }),
}));

function renderComposerDictation() {
  // The app's own client: it re-reads nothing on focus unless a query asks.
  const queryClient = createAppQueryClient();
  const editorRef: RefObject<ComposerPromptEditorHandle | null> = {
    current: null,
  };
  return renderHook(() => useComposerDictation({ editorRef, isActive: true }), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

// The bound default for `composer.dictation.toggle`.
function pressDictationChord(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      code: "KeyM",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    }),
  );
}

function deviceRecognizer(available: boolean): IDeviceDictationHost {
  return {
    isAvailable: () => Promise.resolve(available),
    open: () => {
      throw new Error("availability must not open a session");
    },
  };
}

beforeEach(() => {
  runnerHostState.deviceDictation = null;
  host.statusQueryEnabled.length = 0;
  useSettingsStore.setState({ voiceInputEnabled: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  setMobileApp(false);
  focusManager.setFocused(undefined);
  useSettingsStore.setState({ voiceInputEnabled: true });
});

describe("dictation on the installed mobile app without a recognizer of its own", () => {
  it("offers no mic control and no preparing indicator", () => {
    setMobileApp(true);
    const { result } = renderComposerDictation();
    // Both composers render the mic from `dictationControl` and the preparing
    // placeholder from `dictationPreparing`; null in both slots is the button
    // being absent from the desktop toolbar and the mobile one alike.
    expect(result.current.dictationControl).toBeNull();
    expect(result.current.dictationPreparing).toBeNull();
  });

  it("leaves the dictation hotkey inert", () => {
    setMobileApp(true);
    renderComposerDictation();
    pressDictationChord();
    expect(recorder.start).not.toHaveBeenCalled();
  });

  it("never asks the host about the speech model", () => {
    setMobileApp(true);
    renderComposerDictation();
    expect(host.statusQueryEnabled).not.toContain(true);
    expect(host.ensureModel).not.toHaveBeenCalled();
  });
});

describe("dictation on the installed mobile app with a recognizer of its own", () => {
  it("offers the mic once the device can transcribe the language, and never asks the host", async () => {
    setMobileApp(true);
    runnerHostState.deviceDictation = deviceRecognizer(true);
    const { result } = renderComposerDictation();
    await waitFor(() => {
      expect(result.current.dictationControl).not.toBeNull();
    });
    expect(result.current.dictationPreparing).toBeNull();
    pressDictationChord();
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(host.statusQueryEnabled).not.toContain(true);
    expect(host.ensureModel).not.toHaveBeenCalled();
  });

  it("offers no mic for a language the device cannot transcribe", async () => {
    setMobileApp(true);
    const recognizer = deviceRecognizer(false);
    const isAvailable = vi.spyOn(recognizer, "isAvailable");
    runnerHostState.deviceDictation = recognizer;
    const { result } = renderComposerDictation();
    // The query ran and answered no; only then is the absence meaningful.
    await waitFor(() => {
      expect(isAvailable).toHaveBeenCalledWith(expect.any(String));
    });
    await act(async () => {
      await isAvailable.mock.results[0]?.value;
    });
    expect(result.current.dictationControl).toBeNull();
    pressDictationChord();
    expect(recorder.start).not.toHaveBeenCalled();
    expect(host.statusQueryEnabled).not.toContain(true);
  });

  it("offers the mic when the device becomes able to transcribe while the app was away", async () => {
    setMobileApp(true);
    let available = false;
    const isAvailable = vi.fn(() => Promise.resolve(available));
    runnerHostState.deviceDictation = {
      ...deviceRecognizer(false),
      isAvailable,
    };
    const { result } = renderComposerDictation();
    await waitFor(() => {
      expect(isAvailable).toHaveBeenCalledTimes(1);
    });
    expect(result.current.dictationControl).toBeNull();

    available = true;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await waitFor(() => {
      expect(result.current.dictationControl).not.toBeNull();
    });
  });
});

describe("dictation on other builds", () => {
  it("offers no mic, no hotkey, and no model check when voice input is off", () => {
    useSettingsStore.setState({ voiceInputEnabled: false });
    const { result } = renderComposerDictation();
    expect(result.current.dictationControl).toBeNull();
    expect(result.current.dictationPreparing).toBeNull();
    pressDictationChord();
    expect(recorder.start).not.toHaveBeenCalled();
    expect(host.statusQueryEnabled).not.toContain(true);
    expect(host.ensureModel).not.toHaveBeenCalled();
  });

  it("still offers the mic and the hotkey, and sends no ensure for a model that is ready", () => {
    setMobileApp(false);
    const { result } = renderComposerDictation();
    expect(result.current.dictationControl).not.toBeNull();
    pressDictationChord();
    expect(recorder.start).toHaveBeenCalledTimes(1);
    // A ready model is never re-ensured: ensure is the download. #2471 made
    // a focused composer re-send it every four minutes to keep the host's
    // 1.2 GB recogniser loaded, and that is what this guards against.
    expect(host.ensureModel).not.toHaveBeenCalled();
  });

  it("never re-ensures a ready model while the composer and the window are focused", () => {
    setMobileApp(false);
    vi.useFakeTimers();
    renderComposerDictation();
    // #2471 warmed on a window focus and then every four minutes; neither
    // may send anything now.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => {
      vi.advanceTimersByTime(3 * 4 * 60_000);
    });
    expect(host.ensureModel).not.toHaveBeenCalled();
  });
});
