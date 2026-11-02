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
