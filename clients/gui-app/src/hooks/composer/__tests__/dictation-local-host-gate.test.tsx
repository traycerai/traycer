/**
 * Capability contract: a shell with no local host offers no dictation.
 *
 * Dictation is host-executed - the mic audio is streamed to the app-wide host,
 * which transcribes it. Where the shell bundles a local host that host is this
 * machine, so "audio never leaves your machine" holds; where it does not, every
 * host it can reach is another machine and the promise cannot hold. The gate
 * therefore keys on `IRunnerHost.hasLocalHost`, and this file asserts both
 * sides of it per shell: nothing about dictation reaches the UI of a
 * remote-only shell (mic button, preparing indicator, hotkey, or even the host
 * RPC), and the desktop shell is untouched.
 *
 * The gate used to key on the mobile product flag instead. That answered
 * correctly for the two shells that existed and wrongly for a browser one,
 * which carries the phone's capabilities with the desktop's product flag - so
 * each surface sets its own product flag here too, and the expected answers
 * are written out rather than derived from the capability the gate reads.
 *
 * Everything below the composer hook runs real - the availability hook, the
 * hotkey singleton and the keybinding store included. Only the recorder (mic +
 * host stream) and the host RPC transport are faked.
 */
import type { ReactNode, RefObject } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setMobileApp } from "@/lib/mobile-app";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import {
  shellSurfaces,
  type ShellSurfaceFixture,
} from "../../../../__tests__/shell-surfaces";

const DICTATION_OFFERED: ReadonlyMap<string, boolean> = new Map([
  ["desktop", true],
  ["installed mobile", false],
  ["webapp", false],
  ["browser dev", false],
]);

const recorder = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  toggle: vi.fn(),
  cancel: vi.fn(),
}));

const host = vi.hoisted(() => ({
  ensureModel: vi.fn(),
  // Every observed `enabled` the status query was asked for, so a test can
  // assert the speech RPC is never even armed on a remote-only shell.
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

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({ getActiveHostId: () => "host-1" }),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly options: { readonly enabled: boolean };
  }): { readonly data: unknown } => {
    host.statusQueryEnabled.push(args.options.enabled);
    // A host that is fully ready to dictate - so anything a remote-only shell
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

function renderComposerDictation(surface: ShellSurfaceFixture) {
  const queryClient = new QueryClient();
  const editorRef: RefObject<ComposerPromptEditorHandle | null> = {
    current: null,
  };
  return renderHook(() => useComposerDictation({ editorRef, isActive: true }), {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <RunnerHostProvider runnerHost={surface.runnerHost}>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </RunnerHostProvider>
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

describe("composer dictation", () => {
  it("has an expectation for every shell that mounts the app", () => {
    expect(
      shellSurfaces()
        .map((surface) => surface.name)
        .sort(),
    ).toEqual([...DICTATION_OFFERED.keys()].sort());
  });

  describe.each(shellSurfaces())("on $name", (surface) => {
    const offered = DICTATION_OFFERED.get(surface.name);

    it("offers the mic control to exactly the shells that can honour it", () => {
      setMobileApp(surface.mobileApp);
      const { result } = renderComposerDictation(surface);
      // Both composers render the mic from `dictationControl` and the
      // preparing placeholder from `dictationPreparing`; null in both slots is
      // the button being absent from the desktop toolbar and the mobile one
      // alike.
      expect(result.current.dictationControl !== null).toBe(offered);
      expect(result.current.dictationPreparing).toBeNull();
    });

    it("arms the dictation hotkey to match", () => {
      setMobileApp(surface.mobileApp);
      renderComposerDictation(surface);
      pressDictationChord();
      expect(recorder.start).toHaveBeenCalledTimes(offered === true ? 1 : 0);
    });

    it("asks the host about the speech model only when it will be used", () => {
      setMobileApp(surface.mobileApp);
      renderComposerDictation(surface);
      expect(host.statusQueryEnabled.includes(true)).toBe(offered);
      // The model is already `ready` above, so a shell that armed the query
      // still has nothing to download.
      expect(host.ensureModel).not.toHaveBeenCalled();
    });
  });
});
