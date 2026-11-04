import { z } from "zod";
import type { SoundtrackSetReadResult } from "../../ipc-contracts/soundtrack-types";
import {
  createCachedGoogleToken,
  readServiceAccountKey,
} from "../auth/google-service-account";
import { signGcsReadUrl } from "./gcs-signed-url";

/**
 * The team's track set for a staging build: the build's service-account key
 * reads one private bucket, and the renderer is handed the set's manifest with
 * a signed link in place of every sample. No audio is in a repository or a
 * build, and a build without the key has no source at all.
 *
 * Only what this file rewrites is checked here. The track definitions pass
 * through unread, because the renderer validates the whole manifest with the
 * schema its development read uses (gui-app `lib/soundtrack/remote-manifest.ts`).
 */

const BUCKET = "traycerai-dev-soundtrack";
const MANIFEST_OBJECT = "v1.json";
const READ_ONLY_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
const MANIFEST_TIMEOUT_MS = 15_000;

const UNAVAILABLE: SoundtrackSetReadResult = { kind: "unavailable" };

/** Relative to the manifest, so it can only ever name an object of the set. */
const stemPath = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .refine(
    (path) =>
      path.split("/").every((segment) => segment !== "." && segment !== ".."),
    "A stem path leaves its set",
  );

const stemFiles = z.object({ name: z.string(), files: z.array(stemPath) });

const stemLayer = z.union([
  stemFiles,
  z.object({ name: z.string(), groups: z.array(stemFiles) }),
]);

const stemManifest = z.object({
  tracks: z.array(z.object({ name: z.string(), layers: z.array(stemLayer) })),
});

const setManifest = z.object({
  version: z.literal(1),
  tracks: z.unknown(),
  views: z.unknown(),
  stems: stemManifest,
});

type StemManifest = z.infer<typeof stemManifest>;

function withSignedFiles(
  stems: StemManifest,
  sign: (path: string) => string,
): StemManifest {
  return {
    tracks: stems.tracks.map((track) => ({
      ...track,
      layers: track.layers.map((layer) =>
        "files" in layer
          ? { ...layer, files: layer.files.map(sign) }
          : {
              ...layer,
              groups: layer.groups.map((group) => ({
                ...group,
                files: group.files.map(sign),
              })),
            },
      ),
    })),
  };
}

export interface SoundtrackSource {
  /** Never rejects: every failure is `unavailable`, with its reason logged. */
  read(): Promise<SoundtrackSetReadResult>;
}

export interface SoundtrackSourceOptions {
  /** The packaged key, or `null` when this build ships none. */
  readonly keyFilePath: string | null;
  /** The IAP OAuth client id, which only a staging build carries. */
  readonly audience: string;
  /** The folder under `sets/` in the bucket. */
  readonly set: string;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Told why a read failed, never with the key, a token or a link. */
  readonly warn: (message: string) => void;
}

/** `null` on a build with nothing to read the bucket with. */
export function createSoundtrackSource(
  options: SoundtrackSourceOptions,
): SoundtrackSource | null {
  const { keyFilePath, audience, set, fetch, now, warn } = options;
  if (keyFilePath === null || audience.length === 0) return null;
  const accessToken = createCachedGoogleToken({
    keyFilePath,
    grant: { scope: READ_ONLY_SCOPE },
    tokenField: "access_token",
    label: "Soundtrack access token",
    fetch,
    now,
    warn,
  });
  const unavailable = (reason: string): SoundtrackSetReadResult => {
    warn(`Soundtrack set unavailable: ${reason}`);
    return UNAVAILABLE;
  };

  const read = async (): Promise<SoundtrackSetReadResult> => {
    const token = await accessToken();
    if (token === null) return UNAVAILABLE;
    const response = await fetch(
      `https://storage.googleapis.com/${BUCKET}/sets/${set}/${MANIFEST_OBJECT}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return unavailable(`the bucket answered HTTP ${response.status}`);
    }
    const manifest = setManifest.safeParse(await response.json());
    if (!manifest.success) return unavailable("the manifest is malformed");
    const key = await readServiceAccountKey(keyFilePath);
    if (key === null) return unavailable("the key file is unreadable");
    const nowMs = now();
    return {
      kind: "ok",
      manifest: {
        ...manifest.data,
        stems: withSignedFiles(manifest.data.stems, (path) =>
          signGcsReadUrl(key, BUCKET, `sets/${set}/${path}`, nowMs),
        ),
      },
    };
  };

  return {
    read: () =>
      read().catch((error: unknown) =>
        unavailable(
          `the read failed (${error instanceof Error ? error.name : "unknown"})`,
        ),
      ),
  };
}
