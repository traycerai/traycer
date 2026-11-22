import type { RefObject } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import { useSettingsStore } from "@/stores/settings/settings-store";

const INITIAL_VOICE_INPUT_ENABLED =
  useSettingsStore.getState().voiceInputEnabled;

const host = vi.hoisted(() => ({
  ensureModel: vi.fn(),
  statusQueryEnabled: [] as boolean[],
  status: {
    engineAvailable: true,
    downloadState: "absent",
    downloadProgress: null as number | null,
  },
}));

const recorder = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  toggle: vi.fn(),
  cancel: vi.fn(),
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

// A shell with no recognizer of its own: dictation is the host's.
vi.mock("@/providers/use-runner-host", () => {
  const runnerHost = {
    deviceDictation: null,
    openMicrophoneSettings: () => Promise.resolve(),
  };
  return {
    useRunnerHost: () => runnerHost,
    useRunnerHostOrNull: () => runnerHost,
  };
});

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
    return args.options.enabled ? { data: host.status } : { data: undefined };
  },
  useHostMutation: () => ({ mutate: host.ensureModel, isPending: false }),
}));

function renderDictation() {
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

function readPersistedSettings(): Record<string, unknown> {
  const raw = window.localStorage.getItem("traycer-gui-app:settings");
  if (raw === null) throw new Error("Expected persisted settings");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("state" in parsed)) {
    throw new Error("Expected a persisted settings state");
  }
  return parsed.state as Record<string, unknown>;
}

beforeEach(() => {
  window.localStorage.clear();
  host.statusQueryEnabled.length = 0;
  host.status = {
    engineAvailable: true,
    downloadState: "absent",
    downloadProgress: null,
  };
  useSettingsStore.setState({ voiceInputEnabled: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("voice input opt-in", () => {
  it("defaults off and makes no speech request when a composer mounts", () => {
    useSettingsStore.setState({
      voiceInputEnabled: INITIAL_VOICE_INPUT_ENABLED,
    });
    window.localStorage.clear();

    const { result } = renderDictation();

    expect(host.statusQueryEnabled).not.toContain(true);
    expect(host.ensureModel).not.toHaveBeenCalled();
    expect(result.current.dictationPreparing).toBeNull();
  });

  it("checks and prepares the model only after opt-in, then offers the mic when ready", () => {
    const { result, rerender } = renderDictation();
    expect(host.statusQueryEnabled).not.toContain(true);

    act(() => {
      useSettingsStore.getState().setVoiceInputEnabled(true);
    });
    expect(host.statusQueryEnabled).toContain(true);
    expect(host.ensureModel).toHaveBeenCalledWith({ modelId: null });
    expect(result.current.dictationControl).toBeNull();
    expect(result.current.dictationPreparing).toEqual({
      errorMessage: null,
      downloadState: "absent",
      progress: null,
    });

    host.status = {
      engineAvailable: true,
      downloadState: "downloading",
      downloadProgress: 0.42,
    };
    rerender();
    expect(result.current.dictationPreparing).toEqual({
      errorMessage: null,
      downloadState: "downloading",
      progress: 0.42,
    });

    host.status = {
      engineAvailable: true,
      downloadState: "ready",
      downloadProgress: null,
    };
    rerender();
    expect(result.current.dictationPreparing).toBeNull();
    expect(result.current.dictationControl).not.toBeNull();
  });

  it.each([true, false])(
    "persists and rehydrates the explicit choice: %s",
    async (enabled) => {
      useSettingsStore.setState({ voiceInputEnabled: !enabled });
      window.localStorage.clear();
      useSettingsStore.getState().setVoiceInputEnabled(enabled);
      expect(readPersistedSettings().voiceInputEnabled).toBe(enabled);
      const persisted = window.localStorage.getItem("traycer-gui-app:settings");
      if (persisted === null) throw new Error("Expected persisted settings");
      useSettingsStore.setState({ voiceInputEnabled: !enabled });
      window.localStorage.setItem("traycer-gui-app:settings", persisted);

      await useSettingsStore.persist.rehydrate();

      expect(useSettingsStore.getState().voiceInputEnabled).toBe(enabled);
    },
  );

  it("defaults off when an older record has no voice choice", async () => {
    useSettingsStore.setState({
      voiceInputEnabled: INITIAL_VOICE_INPUT_ENABLED,
    });
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({ state: { theme: "dark" }, version: 1 }),
    );

    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().voiceInputEnabled).toBe(false);
  });

  it("persists the earlier enabled default when another setting changes", async () => {
    // An older runtime started with voice enabled even without the setter being used.
    useSettingsStore.setState({ voiceInputEnabled: true, showGreeting: true });
    window.localStorage.clear();
    useSettingsStore.getState().setShowGreeting(false);

    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    expect(readPersistedSettings().voiceInputEnabled).toBe(true);
    if (persisted === null) throw new Error("Expected persisted settings");

    useSettingsStore.setState({ voiceInputEnabled: false });
    window.localStorage.setItem("traycer-gui-app:settings", persisted);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().voiceInputEnabled).toBe(true);
  });
});
