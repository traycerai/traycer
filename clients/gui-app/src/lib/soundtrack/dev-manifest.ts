import { z } from "zod";
import { appLogger, describeLogError } from "@/lib/logger";
import { SOUNDTRACK_MANIFEST, type SoundtrackManifest } from "./manifest";
import { AQUILO_1 } from "./variable-sound";

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

/** Numbers only, so they may live in the repository as the audio may not. */
const KNOWN_TRACKS = [AQUILO_1, ...SOUNDTRACK_MANIFEST.tracks];

const trackNames = z.array(z.string());

const devManifestSchema = z.object({
  trackNames,
  views: z.object({
    home: trackNames,
    task: trackNames,
    bot: trackNames,
    settings: trackNames,
  }),
  stems: z.object({
    tracks: z.array(
      z.object({
        name: z.string(),
        layers: z.array(
          z.object({ name: z.string(), files: z.array(z.string()) }),
        ),
      }),
    ),
  }),
});

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
    const manifest = devManifestSchema.parse(await response.json());
    return {
      tracks: KNOWN_TRACKS.filter((track) =>
        manifest.trackNames.includes(track.name),
      ),
      views: manifest.views,
      stems: manifest.stems,
    };
  } catch (error) {
    appLogger.warn("[soundtrack] could not read the dev manifest", {
      url,
      error: describeLogError(error),
    });
    return SOUNDTRACK_MANIFEST;
  }
}
