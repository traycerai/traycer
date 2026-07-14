import { useEffect, useMemo, useRef, type RefObject } from "react";

import type { ComposerDictationControl } from "@/components/home/toolbar/composer-mic-button";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import {
  useDictationAvailability,
  type DictationPreparingStatus,
} from "@/hooks/composer/use-dictation-availability";
import { useDictationHotkey } from "@/hooks/composer/use-dictation-hotkey";
import { useVoiceDictation } from "@/hooks/composer/use-voice-dictation";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

interface UseComposerDictationArgs {
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  /**
   * True when this composer is the focused/visible one - gates the global
   * dictation hotkey so two mounted composers don't both react to it.
   */
  readonly isActive: boolean;
}

export interface ComposerDictation {
  readonly dictationControl: ComposerDictationControl | null;
  readonly dictationPreparing: DictationPreparingStatus | null;
}

/**
 * Everything a composer needs for voice dictation: the recorder, error
 * toasts, on-device-model availability gating, and the tap/hold hotkey.
 * Shared by the chat composer and the landing composer.
 */
export function useComposerDictation(
  args: UseComposerDictationArgs,
): ComposerDictation {
  const voiceInputEnabled = useSettingsStore(
    (state) => state.voiceInputEnabled,
  );
  const voiceLanguage = useSettingsStore((state) => state.voiceLanguage);
  const dictation = useVoiceDictation({
    language: voiceLanguage,
    onText: (text) => {
      args.editorRef.current?.insertDictatedText(text);
    },
  });
  const dictationError = dictation.errorMessage;
  const dictationPermissionDenied = dictation.permissionDenied;
  const runnerHost = useRunnerHost();
  useEffect(() => {
    if (dictationError === null) return;
    reportableErrorToast(
      dictationError,
      dictationPermissionDenied
        ? {
            description:
              "Enable microphone access for Traycer, then try again.",
            action: {
              label: "Open Settings",
              onClick: () => {
                void runnerHost.openMicrophoneSettings();
              },
            },
          }
        : undefined,
      {
        title: "Dictation failed",
        message: dictationPermissionDenied
          ? "Microphone permission was unavailable."
          : null,
        code: null,
        source: "Dictation",
      },
    );
  }, [dictationError, dictationPermissionDenied, runnerHost]);

  // Only offer dictation once the on-device model is installed - this also
  // self-heals a missing model and keeps the mic (and the OS permission prompt)
  // hidden where the engine/model isn't available. While it downloads, a
  // preparing indicator shows in the mic slot.
  const dictationAvailability = useDictationAvailability(voiceInputEnabled);
  const dictationActive = dictationAvailability.ready;
  // If availability drops mid-session (model evicted / host swap), the mic +
  // stop UI disappear - cancel so the OS mic isn't left open with no affordance.
  const dictationState = dictation.state;
  const cancelDictationRef = useRef(dictation.cancel);
  useEffect(() => {
    cancelDictationRef.current = dictation.cancel;
  }, [dictation.cancel]);
  useEffect(() => {
    if (
      !dictationActive &&
      dictationState !== "idle" &&
      dictationState !== "error"
    ) {
      cancelDictationRef.current();
    }
  }, [dictationActive, dictationState]);

  const dictationControl = useMemo<ComposerDictationControl | null>(
    () =>
      dictationActive
        ? {
            state: dictation.state,
            onToggle: dictation.toggle,
            onStop: dictation.stop,
            onCancel: dictation.cancel,
            getStream: dictation.getStream,
          }
        : null,
    [
      dictationActive,
      dictation.state,
      dictation.toggle,
      dictation.stop,
      dictation.cancel,
      dictation.getStream,
    ],
  );
  useDictationHotkey({
    enabled: dictationActive && args.isActive,
    state: dictation.state,
    start: dictation.start,
    stop: dictation.stop,
    cancel: dictation.cancel,
  });

  return {
    dictationControl,
    dictationPreparing: dictationAvailability.preparing,
  };
}
