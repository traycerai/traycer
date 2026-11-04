import { desktopSoundtrackBridge, readDesktopSet } from "./desktop-set";
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
 * A development build reads its manifest at `enable()`, so it always does, and
 * so does a desktop build that reports a source for the team's track set.
 */
export function soundtrackOffered(): boolean {
  return (
    (import.meta.env.DEV && import.meta.env.MODE !== "test") ||
    SOUNDTRACK_MANIFEST.tracks.length > 0 ||
    desktopSoundtrackBridge() !== null
  );
}

/**
 * The manifest for a session about to open. A production build reads the bundled
 * one: the development branch and its import fall out of the bundle, and only a
 * staging desktop build has the bridge. Either read answers with a promise and
 * falls back to the bundled manifest, but the promise rejects if the development
 * chunk itself will not load.
 */
export function readSoundtrackManifest():
  | SoundtrackManifest
  | Promise<SoundtrackManifest> {
  if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
    return import("./dev-manifest").then(({ fetchDevManifest }) =>
      fetchDevManifest(),
    );
  }
  const bridge = desktopSoundtrackBridge();
  if (bridge === null) return SOUNDTRACK_MANIFEST;
  return readDesktopSet(bridge).then((set) => set ?? SOUNDTRACK_MANIFEST);
}

/**
 * Fresh links for a session whose signed links have run out. Null where there
 * is no bridge to ask, or when it has none to give.
 */
export async function reissueStemManifest(): Promise<StemManifest | null> {
  const bridge = desktopSoundtrackBridge();
  if (bridge === null) return null;
  const set = await readDesktopSet(bridge);
  return set?.stems ?? null;
}
