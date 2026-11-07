import { create, type StoreApi, type UseBoundStore } from "zustand";
import { appLogger, describeLogError } from "@/lib/logger";
import { listenToNotificationChimes } from "@/lib/notifications/notification-chime";
import {
  DEFAULT_MIX_DIRECTOR,
  MIX_DIRECTORS,
  type MixDirectorId,
  type MixPlan,
} from "@/lib/soundtrack/directors";
import {
  readSoundtrackManifest,
  type SoundtrackManifest,
} from "@/lib/soundtrack/manifest";
import { MIX_TUNING } from "@/lib/soundtrack/mix-tuning";
import type {
  RecordingQuality,
  RecordingSaveChannel,
} from "@/lib/soundtrack/recording";
import { desktopRecordingChannel } from "@/lib/soundtrack/recording-bridge";
import type { RandomSource } from "@/lib/soundtrack/scheduler";
import {
  holdSoundtrackSessionLock,
  type SoundtrackSessionLock,
} from "@/lib/soundtrack/session-lock";
import {
  SoundtrackSession,
  type ResumePositions,
  type SoundtrackPorts,
} from "@/lib/soundtrack/session";
import {
  SessionRecorder,
  type RecordingOutcome,
  type RecordingStopReason,
} from "@/lib/soundtrack/session-recorder";
import type { MixSignals, SoundtrackView } from "@/lib/soundtrack/signals";
import type { StemManifest } from "@/lib/soundtrack/stems";
import { openWebAudioPorts } from "@/lib/soundtrack/web-audio-ports";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * This window's recording of its session. Never persisted: every start of the
 * app begins with it off.
 */
export type SoundtrackRecording =
  | { readonly kind: "off" }
  | {
      readonly kind: "recording";
      /** Audio time recorded so far. */
      readonly elapsedSeconds: number;
      /** Null records until it is turned off. */
      readonly limitSeconds: number | null;
    }
  /** Turned off, and finishing its files. */
  | { readonly kind: "saving" }
  | {
      readonly kind: "saved";
      readonly recordingId: string;
      readonly name: string;
      readonly durationSeconds: number;
      /** Why it stopped early, or null when it stopped as asked. */
      readonly problem: "disk" | "error" | null;
    }
  /** Nothing could be kept. */
  | { readonly kind: "failed" };

/** What a recording is started with, from the person's choices. */
export interface RecordingChoices {
  readonly limitSeconds: number | null;
  readonly quality: RecordingQuality;
}

function problemOf(reason: RecordingStopReason): "disk" | "error" | null {
  if (reason === "write-failed") return "disk";
  if (reason === "failed") return "error";
  return null;
}

function recordingAfter(outcome: RecordingOutcome): SoundtrackRecording {
  switch (outcome.kind) {
    case "saved":
      return {
        kind: "saved",
        recordingId: outcome.recordingId,
        name: outcome.name,
        durationSeconds: outcome.durationSeconds,
        problem: problemOf(outcome.reason),
      };
    case "failed":
      return { kind: "failed" };
    case "empty":
      return { kind: "off" };
  }
}

/**
 * Client state only, in memory, per window: what the soundtrack is doing, never
 * what it was fed. Signals pass through to the session and are not kept here.
 * What the person chose lives in the settings store, which the singleton below
 * follows.
 */
interface SoundtrackState {
  /** Whether a session is open; the person's wish is `soundtrackEnabled`. */
  readonly enabled: boolean;
  /** Turned on here while another window's session plays, until it ends. */
  readonly waitingForTurn: boolean;
  readonly directorId: MixDirectorId;
  readonly volume: number;
  /** The view whose track is in front; null while off, or it has no track. */
  readonly soundingView: SoundtrackView | null;
  /** The plan applied last; null while off. */
  readonly lastPlan: MixPlan | null;
  /** Filled in when a session ends, and read by the next one. */
  readonly resumePositions: ResumePositions;
  /**
   * Turns the soundtrack on and opens the audio device: call it from a gesture
   * of the person's. Stays off where the manifest cannot be read or the device
   * will not open, and until its turn while another window's session is playing.
   */
  readonly enable: () => void;
  /** Turns it off and lets go of the device and every decoded stem. */
  readonly disable: () => void;
  readonly setDirector: (directorId: MixDirectorId) => void;
  readonly setVolume: (volume: number) => void;
  /** Ignored while off, so a publisher need not know. */
  readonly setSignals: (signals: MixSignals) => void;
  /** Ignored while off, so a chime need not know. */
  readonly duck: (chimeSeconds: number) => void;
  readonly recording: SoundtrackRecording;
  /**
   * Records this window's session to the desktop's folder. Ignored with no
   * session open here, where nothing can be saved, or while one records.
   */
  readonly startRecording: (choices: RecordingChoices) => void;
  /** Finishes the recording's files; the music plays on. */
  readonly stopRecording: () => void;
}

interface SoundtrackStoreDependencies {
  /** Read at each `enable()`; a read over the network answers with a promise. */
  readonly readManifest: () => SoundtrackManifest | Promise<SoundtrackManifest>;
  readonly openPorts: (stems: StemManifest, volume: number) => SoundtrackPorts;
  readonly random: RandomSource;
  /** Where a recording is saved; null in a build that cannot save one. */
  readonly recordingChannel: () => RecordingSaveChannel | null;
}

export function createSoundtrackStore(
  dependencies: SoundtrackStoreDependencies,
): UseBoundStore<StoreApi<SoundtrackState>> {
  const { readManifest, openPorts, random, recordingChannel } = dependencies;
  let session: SoundtrackSession | null = null;
  // What the open session plays, which a recording's header names.
  let playing: SoundtrackManifest | null = null;
  let recorder: SessionRecorder | null = null;
  // A read still on its way; `disable()` drops it so that it opens nothing, and
  // so that its failing late cannot let go of a lock a newer read now holds.
  let reading: Promise<SoundtrackManifest> | null = null;
  // Set from `enable()` until `disable()`, or until the read or device fails.
  let lock: SoundtrackSessionLock | null = null;
  const releaseLock = (): void => {
    lock?.release();
    lock = null;
  };
  return create<SoundtrackState>()((set, get) => {
    // A recorder reports its end later, never from inside `stop`.
    const stopRecorder = (reason: "switch" | "music-off"): void => {
      if (recorder === null) return;
      recorder.stop(reason);
      set({ recording: { kind: "saving" } });
    };
    const open = (manifest: SoundtrackManifest): void => {
      let ports: SoundtrackPorts;
      try {
        ports = openPorts(manifest.stems, get().volume);
      } catch (error) {
        appLogger.warn("[soundtrack] could not open the audio device", {
          error: describeLogError(error),
        });
        releaseLock();
        return;
      }
      playing = manifest;
      session = new SoundtrackSession({
        manifest,
        ports,
        random,
        director: MIX_DIRECTORS[get().directorId],
        resumePositions: get().resumePositions,
        onSounding: (sounding) => {
          set(
            sounding === null
              ? { soundingView: null }
              : { soundingView: sounding.view, lastPlan: sounding.plan },
          );
        },
      });
      set({ enabled: true });
    };
    const start = (): void => {
      const manifest = readManifest();
      if (!(manifest instanceof Promise)) {
        open(manifest);
        return;
      }
      reading = manifest;
      void manifest.then(
        (read) => {
          if (reading !== manifest) return;
          reading = null;
          open(read);
        },
        (error: unknown) => {
          if (reading !== manifest) return;
          reading = null;
          appLogger.warn("[soundtrack] could not read the manifest", {
            error: describeLogError(error),
          });
          releaseLock();
        },
      );
    };
    return {
      enabled: false,
      waitingForTurn: false,
      recording: { kind: "off" },
      directorId: DEFAULT_MIX_DIRECTOR,
      volume: MIX_TUNING.volume.initial,
      soundingView: null,
      lastPlan: null,
      resumePositions: {},
      enable: () => {
        if (lock !== null) return;
        const taken = holdSoundtrackSessionLock();
        lock = taken;
        if (taken.held === null) {
          start();
          return;
        }
        set({ waitingForTurn: true });
        void taken.held.then(() => {
          if (lock !== taken) return;
          set({ waitingForTurn: false });
          start();
        });
      },
      disable: () => {
        reading = null;
        releaseLock();
        if (get().waitingForTurn) set({ waitingForTurn: false });
        if (session === null) return;
        // Ahead of the end, so that its files finish while the context is open.
        stopRecorder("music-off");
        const resumePositions = session.end();
        session = null;
        playing = null;
        set({
          enabled: false,
          soundingView: null,
          lastPlan: null,
          resumePositions,
        });
      },
      setDirector: (directorId) => {
        set({ directorId });
        if (session === null) return;
        session.setDirector(MIX_DIRECTORS[directorId]);
        const { log, output } = session.ports;
        if (log.listening()) {
          log.write({
            type: "director",
            t: output.currentTime(),
            director: directorId,
          });
        }
      },
      setVolume: (volume) => {
        set({ volume });
        session?.ports.setVolume(volume);
      },
      setSignals: (signals) => {
        session?.setSignals(signals);
      },
      duck: (chimeSeconds) => {
        session?.ports.duck(chimeSeconds);
      },
      startRecording: ({ limitSeconds, quality }) => {
        const channel = recordingChannel();
        const recorded = session;
        if (channel === null || recorded === null || playing === null) return;
        if (recorder !== null) return;
        const started: SessionRecorder = new SessionRecorder({
          channel,
          ports: recorded.ports,
          quality,
          limitSeconds,
          manifest: playing,
          director: get().directorId,
          onListening: () => {
            recorded.logNow();
          },
          onProgress: (elapsedSeconds) => {
            if (recorder !== started) return;
            set({
              recording: { kind: "recording", elapsedSeconds, limitSeconds },
            });
          },
          onStopped: (outcome) => {
            if (recorder === started) recorder = null;
            set({ recording: recordingAfter(outcome) });
          },
        });
        recorder = started;
        set({
          recording: { kind: "recording", elapsedSeconds: 0, limitSeconds },
        });
        void started.start();
      },
      stopRecording: () => {
        stopRecorder("switch");
      },
    };
  });
}

export const useSoundtrackStore = createSoundtrackStore({
  readManifest: readSoundtrackManifest,
  openPorts: openWebAudioPorts,
  random: Math.random,
  recordingChannel: desktopRecordingChannel,
});

const { soundtrackDirector, soundtrackVolume } = useSettingsStore.getState();
useSoundtrackStore.getState().setDirector(soundtrackDirector);
useSoundtrackStore.getState().setVolume(soundtrackVolume);

// Another window's choices arrive this way too, because the settings store
// rehydrates on its writes. Only off travels here: on opens the audio device,
// which belongs to a gesture in this window.
useSettingsStore.subscribe((state, previous) => {
  const soundtrack = useSoundtrackStore.getState();
  if (state.soundtrackDirector !== previous.soundtrackDirector) {
    soundtrack.setDirector(state.soundtrackDirector);
  }
  if (state.soundtrackVolume !== previous.soundtrackVolume) {
    soundtrack.setVolume(state.soundtrackVolume);
  }
  if (previous.soundtrackEnabled && !state.soundtrackEnabled) {
    soundtrack.disable();
  }
});

// Any window's chime arrives here, and only the window holding the session has
// anything to duck.
listenToNotificationChimes((chimeSeconds) => {
  useSoundtrackStore.getState().duck(chimeSeconds);
});
