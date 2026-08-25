/**
 * Product-policy contract: the installed mobile app offers no dictation.
 *
 * Dictation is host-executed - the mic audio is streamed to the app-wide host,
 * which transcribes it. Desktop's app-wide host is the local machine, so
 * "audio never leaves your machine" holds; the mobile app has no local host, so
 * it cannot hold. The gate therefore keys on the BUILD, and this file asserts
 * both sides of it: nothing about dictation reaches the mobile UI (mic button,
 * preparing indicator, hotkey, or even the host RPC), and the desktop build is
 * untouched.
 *
 * Everything below the composer hook runs real - the availability hook, the
 * hotkey singleton and the keybinding store included. Only the recorder (mic +
 * host stream) and the host RPC transport are faked.
 */
import type { RefObject } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setMobileApp } from "@/lib/mobile-app";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";

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

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ openMicrophoneSettings: () => Promise.resolve() }),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({ getActiveHostId: () => "host-1" }),
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
  const queryClient = new QueryClient();
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

beforeEach(() => {
  host.statusQueryEnabled.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setMobileApp(false);
});

describe("dictation on the installed mobile app", () => {
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

describe("dictation on other builds", () => {
  it("still offers the mic and the hotkey", () => {
    setMobileApp(false);
    const { result } = renderComposerDictation();
    expect(result.current.dictationControl).not.toBeNull();
    pressDictationChord();
    expect(recorder.start).toHaveBeenCalledTimes(1);
  });
});
