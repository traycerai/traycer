/**
 * Dictation transcribed by the phone's own recognizer. The web view captures
 * the microphone (as it does for a voice session) and this hands the audio to
 * the OS recognizer, which is told to work on the device only: a language it
 * cannot transcribe there is reported unavailable.
 *
 * The native halves live in the app projects, not an npm package:
 * `ios/App/App/DeviceDictationPlugin.swift` and
 * `android/app/src/main/java/com/traycer/app/DeviceDictationPlugin.java`.
 */
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { encodeBase64 } from "@traycer-clients/shared/cloud-chat/bytes";
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
  /**
   * Ends the audio and resolves with the transcript of what `transcript` has
   * not already raised.
   */
  finish(options: {
    readonly sessionId: string;
  }): Promise<{ readonly text: string }>;
  cancel(options: { readonly sessionId: string }): Promise<void>;
  /**
   * What was said before a pause, raised while the session is still open.
   * Android raises it; iOS answers everything at `finish`.
   */
  addListener(
    eventName: "transcript",
    listener: (event: {
      readonly sessionId: string;
      readonly text: string;
    }) => void,
  ): Promise<PluginListenerHandle>;
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

export class MobileDeviceDictation implements IDeviceDictationHost {
  private nextSessionId = 0;
  /** The open session's id and where its mid-session transcripts go. */
  private live: {
    readonly sessionId: string;
    readonly onTranscript: (text: string) => void;
  } | null = null;

  constructor(private readonly plugin: DeviceDictationPluginSlice) {
    void plugin
      .addListener("transcript", (event) => {
        if (this.live?.sessionId === event.sessionId) {
          this.live.onTranscript(event.text);
        }
      })
      .catch((error: unknown) => {
        console.warn(
          "[mobile] dictation transcript listener unavailable",
          error,
        );
      });
  }

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
    const live = { sessionId, onTranscript: callbacks.onTranscript };
    this.live = live;
    const end = (): void => {
      over = true;
      if (this.live === live) this.live = null;
    };
    const cancel = (): void => {
      void plugin.cancel({ sessionId }).catch(() => undefined);
    };
    const fail = (error: unknown): void => {
      if (over) return;
      end();
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
          .appendAudio({ sessionId, audio: encodeBase64(pcm) })
          .catch(fail);
      },
      flush: () => {
        if (over) return;
        if (!started) {
          // Nothing was sent, so there is nothing to transcribe.
          end();
          cancel();
          queueMicrotask(callbacks.onFlushed);
          return;
        }
        void plugin.finish({ sessionId }).then(({ text }) => {
          if (over) return;
          end();
          callbacks.onTranscript(text);
          callbacks.onFlushed();
        }, fail);
      },
      close: () => {
        if (over) return;
        end();
        cancel();
      },
    };
  }
}
