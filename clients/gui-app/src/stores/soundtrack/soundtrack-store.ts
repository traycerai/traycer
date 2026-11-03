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
import type { MixSignals, SoundtrackView } from "@/lib/soundtrack/signals";
import type { StemManifest } from "@/lib/soundtrack/stems";
import { openWebAudioPorts } from "@/lib/soundtrack/web-audio-ports";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * Client state only, in memory, per window: what the soundtrack is doing, never
 * what it was fed. Signals pass through to the session and are not kept here.
 * What the person chose lives in the settings store, which the singleton below
 * follows.
 */
interface SoundtrackState {
  /** Whether a session is open; the person's wish is `soundtrackEnabled`. */
  readonly enabled: boolean;
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
   * of the person's. Stays off where the device will not open, and until its
   * turn while another window's session is playing.
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
}

interface SoundtrackStoreDependencies {
  /** Read at each `enable()`; only a development build answers with a promise. */
  readonly readManifest: () => SoundtrackManifest | Promise<SoundtrackManifest>;
  readonly openPorts: (stems: StemManifest, volume: number) => SoundtrackPorts;
  readonly random: RandomSource;
}

export function createSoundtrackStore(
  dependencies: SoundtrackStoreDependencies,
): UseBoundStore<StoreApi<SoundtrackState>> {
  const { readManifest, openPorts, random } = dependencies;
  let session: SoundtrackSession | null = null;
  // A read still on its way; `disable()` drops it so that it opens nothing.
  let reading: Promise<SoundtrackManifest> | null = null;
  // Set from `enable()` until `disable()`, or until the device refuses.
  let lock: SoundtrackSessionLock | null = null;
  const releaseLock = (): void => {
    lock?.release();
    lock = null;
  };
  return create<SoundtrackState>()((set, get) => {
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
      void manifest.then((read) => {
        if (reading !== manifest) return;
        reading = null;
        open(read);
      });
    };
    return {
      enabled: false,
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
        void taken.held.then(() => {
          if (lock === taken) start();
        });
      },
      disable: () => {
        reading = null;
        releaseLock();
        if (session === null) return;
        const resumePositions = session.end();
        session = null;
        set({
          enabled: false,
          soundingView: null,
          lastPlan: null,
          resumePositions,
        });
      },
      setDirector: (directorId) => {
        set({ directorId });
        session?.setDirector(MIX_DIRECTORS[directorId]);
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
    };
  });
}

export const useSoundtrackStore = createSoundtrackStore({
  readManifest: readSoundtrackManifest,
  openPorts: openWebAudioPorts,
  random: Math.random,
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

listenToNotificationChimes((chimeSeconds) => {
  useSoundtrackStore.getState().duck(chimeSeconds);
});
