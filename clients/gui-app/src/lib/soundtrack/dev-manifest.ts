import { appLogger, describeLogError } from "@/lib/logger";
import { SOUNDTRACK_MANIFEST, type SoundtrackManifest } from "./manifest";
import { parseRemoteManifest } from "./remote-manifest";
import type { StemManifest } from "./stems";

/**
 * Stand-in stems to listen against, in a development build only: nothing here
 * reaches a production bundle (`readSoundtrackManifest`), and the audio stays on
 * the disk it is served from, outside every repository.
 *
 * The default is the renderer's dev server, which proxies it to
 * `http://localhost:8765` (`clients/desktop/vite.renderer.config.ts`), because
 * the app's content security policy admits no other plain-http origin. Set this
 * key from the console to read another manifest.
 */
const MANIFEST_URL_OVERRIDE_KEY = "traycer-soundtrack-dev-manifest-url";
const DEFAULT_MANIFEST_URL = "/__soundtrack-dev/manifest.json";

function withFilesResolved(stems: StemManifest, base: URL): StemManifest {
  const resolved = (files: readonly string[]): readonly string[] =>
    files.map((file) => new URL(file, base).href);
  return {
    tracks: stems.tracks.map((track) => ({
      ...track,
      layers: track.layers.map((layer) =>
        layer.groups === undefined
          ? { ...layer, files: resolved(layer.files) }
          : {
              ...layer,
              groups: layer.groups.map((group) => ({
                ...group,
                files: resolved(group.files),
              })),
            },
      ),
    })),
  };
}

/** Silent where there is none to read, as a production build is today. */
export async function fetchDevManifest(): Promise<SoundtrackManifest> {
  const url =
    window.localStorage.getItem(MANIFEST_URL_OVERRIDE_KEY) ??
    DEFAULT_MANIFEST_URL;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Fetching it answered ${String(response.status)}`);
    }
    const manifest = parseRemoteManifest(await response.json());
    return {
      ...manifest,
      stems: withFilesResolved(
        manifest.stems,
        new URL(url, window.location.href),
      ),
    };
  } catch (error) {
    appLogger.warn("[soundtrack] could not read the dev manifest", {
      url,
      error: describeLogError(error),
    });
    return SOUNDTRACK_MANIFEST;
  }
}
