import { useEffect, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_START_PAGE_WALLPAPER_INTENSITY,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import { processStartPageWallpaperImage } from "./appearance-image-processing";
import {
  readAppearanceBlob,
  removeAppearanceBlob,
  writeAppearanceBlob,
} from "./appearance-cache";

/**
 * The personal start-page wallpaper. Exactly one image exists per
 * installation, so it needs no content-addressed name: a fixed key in the
 * global (account-independent) scope of the wallpaper blob store.
 *
 * The bytes live in the appearance blob store; every other fact about the
 * wallpaper - style, intensity, tint, and the chosen file's name - lives on
 * the settings store's `StartPageWallpaper` row. Two stores, but ONE user
 * action (choosing an image, removing it) always writes both, and only
 * through the two entry points below. Nothing else in the app writes either
 * half on its own, so "wallpaper set" and "wallpaper bytes present" can
 * never drift apart.
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
 * Validates the chosen file, re-encodes it to the wallpaper budget, and
 * stores the bytes and the settings row together. Keeps the style/intensity/
 * tint the user already picked if a wallpaper was already set; a first
 * choice seeds their defaults. The name always updates to the newly chosen
 * file, in the same write.
 */
export async function chooseStartPageWallpaper(
  file: File,
  signal: AbortSignal,
): Promise<void> {
  const processed = await processStartPageWallpaperImage(file, signal);
  signal.throwIfAborted();
  try {
    await writeAppearanceBlob(START_PAGE_WALLPAPER_KEY, processed.blob);
  } catch (error) {
    // Keep bytes and settings consistent when storage fails.
    await removeAppearanceBlob(START_PAGE_WALLPAPER_KEY).catch(() => undefined);
    invalidateStartPageWallpaper();
    throw error;
  }
  if (signal.aborted) {
    // Canceled (e.g. Remove was clicked mid-write): the settings row must
    // not be resurrected out from under a concurrent removal. Whichever
    // action wins the race owns the final invalidate.
    invalidateStartPageWallpaper();
    return;
  }
  const current = useSettingsStore.getState().startPageWallpaper;
  useSettingsStore.getState().setStartPageWallpaper({
    style: current?.style ?? "dither",
    intensity: current?.intensity ?? DEFAULT_START_PAGE_WALLPAPER_INTENSITY,
    tintWithAccent: current?.tintWithAccent ?? true,
    name: file.name,
  });
  invalidateStartPageWallpaper();
}

/** Clears both the settings row and the stored bytes. */
export async function removeStartPageWallpaper(): Promise<void> {
  useSettingsStore.getState().setStartPageWallpaper(null);
  try {
    await removeAppearanceBlob(START_PAGE_WALLPAPER_KEY);
  } finally {
    invalidateStartPageWallpaper();
  }
}

export interface StartPageWallpaperImage {
  /** Object URL for the stored bytes, or `null` while loading / when unset. */
  readonly url: string | null;
  /** The file name it was chosen under, when one is stored. */
  readonly name: string | null;
}

const NO_WALLPAPER: StartPageWallpaperImage = { url: null, name: null };

export function useStartPageWallpaperImage(): StartPageWallpaperImage {
  const version = useSyncExternalStore(subscribe, readRevision, readRevision);
  const name = useSettingsStore(
    (state) => state.startPageWallpaper?.name ?? null,
  );
  const [image, setImage] = useState<StartPageWallpaperImage>(NO_WALLPAPER);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void readAppearanceBlob(START_PAGE_WALLPAPER_KEY)
      .catch(() => null)
      .then((blob) => {
        if (cancelled) return;
        if (blob === null) {
          setImage(NO_WALLPAPER);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setImage({ url: objectUrl, name });
      });
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [version, name]);
  return image;
}
