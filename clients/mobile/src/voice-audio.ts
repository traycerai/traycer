/**
 * The phone's half of a voice session: the microphone permission, the way to
 * the OS page that repairs a refusal, and the interruptions that end a live
 * session. The capture itself is the web view's own `getUserMedia`; this only
 * asks the OS first, so a refusal is told apart from a microphone that failed
 * to open, and the person is sent to Settings rather than left guessing.
 *
 * The native halves live in the app projects, not an npm package:
 * `ios/App/App/VoiceAudioPlugin.swift` and
 * `android/app/src/main/java/com/traycer/app/VoiceAudioPlugin.java`.
 */
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { MicrophoneAccessStatus } from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

/** What the OS says about the microphone: decided either way, or not asked yet. */
export type MicrophonePermissionState = "granted" | "denied" | "prompt";

/** The native plugin's surface. Tests fake this boundary. */
export interface VoiceAudioPluginSlice {
  checkMicrophone(): Promise<{ readonly state: MicrophonePermissionState }>;
  /**
   * Raises the system prompt when the OS will still show one; answers the
   * remembered decision otherwise.
   */
  requestMicrophone(): Promise<{ readonly state: MicrophonePermissionState }>;
  /**
   * While live, an interruption raises `interrupted`: the audio session's on
   * iOS (a call, an alarm, Siri), a call's audio mode on Android 12 and up.
   */
  setLive(options: { readonly live: boolean }): Promise<void>;
  addListener(
    eventName: "interrupted",
    listener: () => void,
  ): Promise<PluginListenerHandle>;
}

export const VoiceAudio = registerPlugin<VoiceAudioPluginSlice>("VoiceAudio");

export class MobileVoiceAudio {
  constructor(
    private readonly plugin: VoiceAudioPluginSlice,
    /** This app's page in the OS Settings app, where the microphone switch is. */
    private readonly openAppSettings: () => Promise<void>,
  ) {}

  /** Asks only when the person has not decided; a refusal stays a refusal. */
  async requestAccess(): Promise<MicrophoneAccessStatus> {
    const { state } = await this.plugin.checkMicrophone();
    if (state === "granted") return "granted";
    if (state === "denied") return "denied";
    const decided = await this.plugin.requestMicrophone();
    return decided.state === "granted" ? "granted" : "denied";
  }

  openSettings(): Promise<void> {
    return this.openAppSettings();
  }

  setLive(live: boolean): Promise<void> {
    return this.plugin.setLive({ live });
  }

  onInterrupted(handler: () => void): Disposable {
    let disposed = false;
    let handle: PluginListenerHandle | null = null;
    void this.plugin
      .addListener("interrupted", () => {
        if (!disposed) handler();
      })
      .then(
        (registered) => {
          if (disposed) {
            void registered.remove();
            return;
          }
          handle = registered;
        },
        (error: unknown) => {
          console.warn(
            "[mobile] voice interruption listener unavailable",
            error,
          );
        },
      );
    return {
      dispose: () => {
        disposed = true;
        void handle?.remove();
        handle = null;
      },
    };
  }
}
