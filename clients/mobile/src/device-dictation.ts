/**
 * Dictation transcribed by the phone's own recognizer. The web view captures
 * the microphone (as it does for a voice session) and this hands the audio to
 * the OS recognizer, which is told to work on the device only: a language it
 * cannot transcribe there is reported unavailable.
 *
 * The native half lives in the app project, not an npm package:
 * `ios/App/App/DeviceDictationPlugin.swift`. Android has none, so the entry
 * point builds this on iOS alone.
 */
import { registerPlugin } from "@capacitor/core";
import type {
  DeviceDictationCallbacks,
  DeviceDictationSession,
  IDeviceDictationHost,
} from "@traycer-clients/shared/platform/runner-host";

/** The native plugin's surface. Tests fake this boundary. */
export interface DeviceDictationPluginSlice {
  isAvailable(options: {
    readonly language: string;
  }): Promise<{ readonly available: boolean }>;
  /**
   * Asks for speech recognition access when the person has not decided, then
   * starts a session, ending any other. Rejects with code `PERMISSION_DENIED`
   * when the OS refuses the app.
   */
  start(options: {
    readonly sessionId: string;
    readonly language: string;
    readonly sampleRate: number;
  }): Promise<void>;
  /** `audio` is base64 PCM16 mono. Rejects once the session has failed. */
  appendAudio(options: {
    readonly sessionId: string;
    readonly audio: string;
  }): Promise<void>;
  /** Ends the audio and resolves with the transcript of all of it. */
  finish(options: {
    readonly sessionId: string;
  }): Promise<{ readonly text: string }>;
  cancel(options: { readonly sessionId: string }): Promise<void>;
}

export const DeviceDictation =
  registerPlugin<DeviceDictationPluginSlice>("DeviceDictation");

const PERMISSION_DENIED_CODE = "PERMISSION_DENIED";

function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === PERMISSION_DENIED_CODE
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class MobileDeviceDictation implements IDeviceDictationHost {
  private nextSessionId = 0;

  constructor(private readonly plugin: DeviceDictationPluginSlice) {}

  async isAvailable(language: string): Promise<boolean> {
    const { available } = await this.plugin.isAvailable({ language });
    return available;
  }

  open(options: {
    readonly language: string;
    readonly sampleRate: number;
    readonly callbacks: DeviceDictationCallbacks;
  }): DeviceDictationSession {
    const { plugin } = this;
    const { callbacks } = options;
    this.nextSessionId += 1;
    const sessionId = String(this.nextSessionId);
    // Once over, a session raises nothing more: a late native answer must not
    // reach a caller that has moved on to another session.
    let over = false;
    let started = false;
    const cancel = (): void => {
      void plugin.cancel({ sessionId }).catch(() => undefined);
    };
    const fail = (error: unknown): void => {
      if (over) return;
      over = true;
      cancel();
      callbacks.onError({
        message: error instanceof Error ? error.message : String(error),
        permissionDenied: isPermissionDenied(error),
      });
    };
    void plugin
      .start({
        sessionId,
        language: options.language,
        sampleRate: options.sampleRate,
      })
      .then(() => {
        started = true;
        // Ended while the OS was still asking for access: the native session
        // began after that cancel, so it is cancelled again here.
        if (over) cancel();
        else callbacks.onReady();
      }, fail);
    return {
      sendAudio: (pcm) => {
        if (over) return;
        void plugin
          .appendAudio({ sessionId, audio: toBase64(pcm) })
          .catch(fail);
      },
      flush: () => {
        if (over) return;
        if (!started) {
          // Nothing was sent, so there is nothing to transcribe.
          over = true;
          cancel();
          queueMicrotask(callbacks.onFlushed);
          return;
        }
        void plugin.finish({ sessionId }).then(({ text }) => {
          if (over) return;
          over = true;
          callbacks.onTranscript(text);
          callbacks.onFlushed();
        }, fail);
      },
      close: () => {
        if (over) return;
        over = true;
        cancel();
      },
    };
  }
}
