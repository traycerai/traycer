import type { SoundtrackView } from "./signals";
import type { StemManifest } from "./stems";
import type { VariableTrack } from "./variable-sound";

/** What can sound, and where. */
export interface SoundtrackManifest {
  readonly tracks: readonly VariableTrack[];
  /** By view, the names of the tracks it may play. */
  readonly views: Readonly<Record<SoundtrackView, readonly string[]>>;
  /** Where each track's samples are. */
  readonly stems: StemManifest;
}

/** No audio ships yet, so every view is silent until the originals arrive. */
export const SOUNDTRACK_MANIFEST: SoundtrackManifest = {
  tracks: [],
  views: { home: [], task: [], bot: [], settings: [] },
  stems: { tracks: [] },
};

/**
 * Whether this build has anything to play, and so whether any control for it is
 * drawn: a switch that makes no sound would be a promise the app cannot keep.
 * A development build reads its manifest at `enable()`, so it always does.
 */
export function soundtrackOffered(): boolean {
  return (
    (import.meta.env.DEV && import.meta.env.MODE !== "test") ||
    SOUNDTRACK_MANIFEST.tracks.length > 0
  );
}

/**
 * The manifest for a session about to open. A production build reads the bundled
 * one and nothing else: this branch and its import fall out of the bundle. Only
 * a development build answers with a promise, which never rejects.
 */
export function readSoundtrackManifest():
  | SoundtrackManifest
  | Promise<SoundtrackManifest> {
  if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
    return import("./dev-manifest").then(({ fetchDevManifest }) =>
      fetchDevManifest(),
    );
  }
  return SOUNDTRACK_MANIFEST;
}
