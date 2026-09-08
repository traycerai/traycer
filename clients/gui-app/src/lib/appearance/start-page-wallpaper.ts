import { useEffect, useState, useSyncExternalStore } from "react";
import { processStartPageWallpaperImage } from "./appearance-image-processing";
import {
  pinGlobalAppearanceBlob,
  readAppearanceBlob,
  removeAppearanceBlob,
  writeAppearanceBlob,
} from "./appearance-cache";

/**
 * The personal start-page wallpaper. Exactly one image exists per
 * installation, so it needs no content-addressed name: a fixed key in the
 * global (account-independent) scope of the appearance blob store, pinned so
 * cache eviction can never take the one image the user chose. The settings
 * store holds its style and intensity; the bytes live only here.
 */
const START_PAGE_WALLPAPER_KEY = "start-page-wallpaper";

let revision = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readRevision(): number {
  return revision;
}

/** Bumped by every write so mounted readers re-resolve their object URL. */
function invalidateStartPageWallpaper(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/**
 * Validates the chosen file, re-encodes it to the wallpaper budget, and stores
 * it under its original file name (a `File` survives IndexedDB's structured
 * clone, so the settings row can name the image without a settings-store field
 * shadowing the bytes).
 */
export async function chooseStartPageWallpaper(
  file: File,
  signal: AbortSignal,
): Promise<void> {
  const processed = await processStartPageWallpaperImage(file, signal);
  signal.throwIfAborted();
  await saveStartPageWallpaper(
    new File([processed.blob], file.name, { type: processed.blob.type }),
  );
}

export async function saveStartPageWallpaper(blob: Blob | null): Promise<void> {
  try {
    if (blob === null)
      await removeAppearanceBlob(null, START_PAGE_WALLPAPER_KEY);
    else await writeAppearanceBlob(null, START_PAGE_WALLPAPER_KEY, blob);
    await pinGlobalAppearanceBlob(
      blob === null ? null : START_PAGE_WALLPAPER_KEY,
    );
  } finally {
    invalidateStartPageWallpaper();
  }
}

export interface StartPageWallpaperImage {
  /** Object URL for the stored bytes, or `null` while loading / when unset. */
  readonly url: string | null;
  /** The file name it was chosen under, when the stored blob carries one. */
  readonly name: string | null;
}

const NO_WALLPAPER: StartPageWallpaperImage = { url: null, name: null };

export function useStartPageWallpaperImage(): StartPageWallpaperImage {
  const version = useSyncExternalStore(subscribe, readRevision, readRevision);
  const [image, setImage] = useState<StartPageWallpaperImage>(NO_WALLPAPER);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void readAppearanceBlob(null, START_PAGE_WALLPAPER_KEY)
      .catch(() => null)
      .then((blob) => {
        if (cancelled) return;
        if (blob === null) {
          setImage(NO_WALLPAPER);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setImage({
          url: objectUrl,
          name: blob instanceof File ? blob.name : null,
        });
      });
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [version]);
  return image;
}
