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
  type SoundtrackTrack,
} from "@/lib/soundtrack/manifest";
import {
  openSoundtrackMediaSession,
  type MediaSessionHandlers,
  type SoundtrackMediaSession,
} from "@/lib/soundtrack/media-session";
import { desktopSoundtrackBridge } from "@/lib/soundtrack/desktop-set";
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
  /** Whether this window is queued behind another window's session. */
  readonly waitingForLock: boolean;
  readonly directorId: MixDirectorId;
  readonly volume: number;
  /** Whether a session here is to hold; the wish is `soundtrackPaused`. */
  readonly paused: boolean;
  /** The view whose track is in front; null while off, or it has no track. */
  readonly soundingView: SoundtrackView | null;
  /** The actual track definition whose arrangement or recording is in front. */
  readonly soundingTrack: SoundtrackTrack | null;
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
  readonly setPaused: (paused: boolean) => void;
  /** Staging listening choice, reset when this window reloads. */
  readonly setPiecesEnabled: boolean;
  readonly setSetPiecesEnabled: (enabled: boolean) => void;
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
  /** Ignored while off: there is no track to move from. */
  readonly next: () => void;
  /** Ignored while off: there is no track to move from. */
  readonly previous: () => void;
}

interface SoundtrackStoreDependencies {
  /** Read at each `enable()`; a read over the network answers with a promise. */
  readonly readManifest: () => SoundtrackManifest | Promise<SoundtrackManifest>;
  readonly openPorts: (stems: StemManifest, volume: number) => SoundtrackPorts;
  /**
   * Opened with the ports and closed with them; null where the system has no
   * media controls to join.
   */
  readonly openMediaSession: (
    handlers: MediaSessionHandlers,
  ) => SoundtrackMediaSession | null;
  readonly random: RandomSource;
  /** Where a recording is saved; null in a build that cannot save one. */
  readonly recordingChannel: () => RecordingSaveChannel | null;
}

export function createSoundtrackStore(
  dependencies: SoundtrackStoreDependencies,
): UseBoundStore<StoreApi<SoundtrackState>> {
  const {
    readManifest,
    openPorts,
    openMediaSession,
    random,
    recordingChannel,
  } = dependencies;
  let session: SoundtrackSession | null = null;
  // The system's media controls, for as long as `session` lasts.
  let mediaSession: SoundtrackMediaSession | null = null;
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
      // The system's buttons are the status row's: each one moves the person's
      // wish in settings, which this window's session follows like any other.
      mediaSession = openMediaSession({
        play: () => {
          useSettingsStore.getState().setSoundtrackPaused(false);
        },
        pause: () => {
          useSettingsStore.getState().setSoundtrackPaused(true);
        },
        next: () => {
          useSettingsStore.getState().setSoundtrackPaused(false);
          get().next();
        },
        previous: () => {
          useSettingsStore.getState().setSoundtrackPaused(false);
          get().previous();
        },
      });
      session = new SoundtrackSession({
        manifest,
        ports,
        random,
        director: MIX_DIRECTORS[get().directorId],
        resumePositions: get().resumePositions,
        onSounding: (sounding) => {
          mediaSession?.setTrack(sounding?.track.title ?? null);
          set(
            sounding === null
              ? { soundingView: null, soundingTrack: null }
              : {
                  soundingView: sounding.view,
                  soundingTrack: sounding.track,
                  lastPlan: sounding.plan,
                },
          );
        },
        // The wish to hear it stands, whether or not the buttons are there. With
        // the session gone the warm-up arms again, so the next gesture opens a
        // new device, from where this one got to.
        onResumeRefused: () => {
          get().disable();
        },
      });
      session.setSetPiecesEnabled(get().setPiecesEnabled);
      if (get().paused) {
        session.pause();
        mediaSession?.setPaused(true);
      }
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
      waitingForLock: false,
      recording: { kind: "off" },
      directorId: DEFAULT_MIX_DIRECTOR,
      volume: MIX_TUNING.volume.initial,
      paused: false,
      setPiecesEnabled: true,
      soundingView: null,
      soundingTrack: null,
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
        void taken.queued?.then(() => {
          if (lock === taken) set({ waitingForLock: true });
        });
        void taken.held.then(() => {
          if (lock !== taken) return;
          set({ waitingForLock: false });
          start();
        });
      },
      disable: () => {
        reading = null;
        releaseLock();
        set({ waitingForLock: false });
        if (session === null) return;
        // Ahead of the end, so that its files finish while the context is open.
        stopRecorder("music-off");
        const resumePositions = session.end();
        session = null;
        mediaSession?.close();
        mediaSession = null;
        playing = null;
        set({
          enabled: false,
          soundingView: null,
          soundingTrack: null,
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
      setPaused: (paused) => {
        set({ paused });
        if (paused) session?.pause();
        else session?.play();
        mediaSession?.setPaused(paused);
      },
      setSetPiecesEnabled: (enabled) => {
        if (desktopSoundtrackBridge() === null) return;
        set({ setPiecesEnabled: enabled });
        session?.setSetPiecesEnabled(enabled);
      },
      setSignals: (signals) => {
        session?.setSignals(signals);
      },
      duck: (chimeSeconds) => {
        session?.duck(chimeSeconds);
      },
      next: () => {
        session?.next();
      },
      previous: () => {
        session?.previous();
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
  openMediaSession: openSoundtrackMediaSession,
  random: Math.random,
  recordingChannel: desktopRecordingChannel,
});

const { soundtrackDirector, soundtrackVolume, soundtrackPaused } =
  useSettingsStore.getState();
useSoundtrackStore.getState().setDirector(soundtrackDirector);
useSoundtrackStore.getState().setVolume(soundtrackVolume);
useSoundtrackStore.getState().setPaused(soundtrackPaused);

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
  if (state.soundtrackPaused !== previous.soundtrackPaused) {
    soundtrack.setPaused(state.soundtrackPaused);
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
