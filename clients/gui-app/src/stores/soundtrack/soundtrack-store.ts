import { create, type StoreApi, type UseBoundStore } from "zustand";
import { appLogger, describeLogError } from "@/lib/logger";
import {
  MIX_DIRECTORS,
  type MixDirectorId,
  type MixPlan,
} from "@/lib/soundtrack/directors";
import {
  SOUNDTRACK_MANIFEST,
  type SoundtrackManifest,
} from "@/lib/soundtrack/manifest";
import type { RandomSource } from "@/lib/soundtrack/scheduler";
import {
  SoundtrackSession,
  type ResumePositions,
  type SoundtrackPorts,
} from "@/lib/soundtrack/session";
import type { MixSignals, SoundtrackView } from "@/lib/soundtrack/signals";
import type { StemManifest } from "@/lib/soundtrack/stems";
import { openWebAudioPorts } from "@/lib/soundtrack/web-audio-ports";

/**
 * Client state only, in memory, per window: what the soundtrack is doing, never
 * what it was fed. Signals pass through to the session and are not kept here.
 */
interface SoundtrackState {
  readonly enabled: boolean;
  readonly directorId: MixDirectorId;
  /** The view whose track is in front; null while off, or it has no track. */
  readonly soundingView: SoundtrackView | null;
  /** The plan applied last; null while off. */
  readonly lastPlan: MixPlan | null;
  /** Filled in when a session ends, and read by the next one. */
  readonly resumePositions: ResumePositions;
  /**
   * Turns the soundtrack on and opens the audio device: call it from a gesture
   * of the person's. Stays off where the device will not open.
   */
  readonly enable: () => void;
  /** Turns it off and lets go of the device and every decoded stem. */
  readonly disable: () => void;
  readonly setDirector: (directorId: MixDirectorId) => void;
  /** Ignored while off, so a publisher need not know. */
  readonly setSignals: (signals: MixSignals) => void;
}

interface SoundtrackStoreDependencies {
  readonly manifest: SoundtrackManifest;
  readonly openPorts: (stems: StemManifest) => SoundtrackPorts;
  readonly random: RandomSource;
}

/** Until the listening test settles the default, the honest one. */
const INITIAL_DIRECTOR: MixDirectorId = "static";

export function createSoundtrackStore(
  dependencies: SoundtrackStoreDependencies,
): UseBoundStore<StoreApi<SoundtrackState>> {
  const { manifest, openPorts, random } = dependencies;
  let session: SoundtrackSession | null = null;
  return create<SoundtrackState>()((set, get) => ({
    enabled: false,
    directorId: INITIAL_DIRECTOR,
    soundingView: null,
    lastPlan: null,
    resumePositions: {},
    enable: () => {
      if (session !== null) return;
      let ports: SoundtrackPorts;
      try {
        ports = openPorts(manifest.stems);
      } catch (error) {
        appLogger.warn("[soundtrack] could not open the audio device", {
          error: describeLogError(error),
        });
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
    },
    disable: () => {
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
    setSignals: (signals) => {
      session?.setSignals(signals);
    },
  }));
}

export const useSoundtrackStore = createSoundtrackStore({
  manifest: SOUNDTRACK_MANIFEST,
  openPorts: openWebAudioPorts,
  random: Math.random,
});
