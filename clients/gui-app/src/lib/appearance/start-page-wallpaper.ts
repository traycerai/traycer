import { useEffect, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_START_PAGE_WALLPAPER_INTENSITY,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import {
  APPEARANCE_WALLPAPER_MAX_EDGE,
  MAX_START_PAGE_WALLPAPER_BYTES,
  processStartPageWallpaperImage,
  validateAppearanceImage,
} from "./appearance-image-processing";
import {
  downloadCuratedWallpaper,
  type CuratedWallpaper,
} from "./curated-wallpapers";
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
 * action (choosing an image, applying a curated one, removing it) always
 * writes both, and only through the three entry points below. Nothing else in the app writes either
 * half on its own, so "wallpaper set" and "wallpaper bytes present" can
 * never drift apart.
 *
 * Keeping the two halves paired needs more than one writer at a time: every
 * write runs as one link of `writeQueue`, and each takes a `writeTicket` when
 * its user action starts. A link whose ticket is stale has been superseded and
 * writes nothing at all, so bytes and row are only ever written together, by
 * the last action the user took.
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
 * The curated apply in flight, if any. Module-level and never held by a
 * component, which is what lets a download outlive the settings panel: the
 * user picks a tile, closes the panel, and the wallpaper still lands. Last
 * action wins - a second tile, a custom pick, or Remove aborts it.
 */
let curatedApply: AbortController | null = null;

function abortCuratedApply(): void {
  curatedApply?.abort();
  curatedApply = null;
}

let writeTicket = 0;
let writeQueue: Promise<void> = Promise.resolve();

/** Runs `write` after every write already queued, whether those failed or not. */
function enqueueWrite(write: () => Promise<void>): Promise<void> {
  const link = writeQueue.then(write);
  writeQueue = link.catch(() => undefined);
  return link;
}

/**
 * The half both entry points share: write the bytes, then the settings row,
 * then invalidate. Keeps the style/intensity/tint the user already picked if a
 * wallpaper was already set; a first choice seeds their defaults. The name and
 * the curated id always update, in the same write.
 *
 * The ticket is taken here, where the bytes are known to exist, so a store
 * superseded before its turn writes neither half - and one that does get its
 * turn runs alone, which is what pairs the bytes it writes with the row it
 * writes.
 */
async function storeStartPageWallpaper(args: {
  readonly blob: Blob;
  readonly name: string;
  readonly curatedId: string | null;
  readonly signal: AbortSignal;
}): Promise<void> {
  const ticket = ++writeTicket;
  return enqueueWrite(async () => {
    if (ticket !== writeTicket || args.signal.aborted) {
      // Superseded (another pick, or Remove) while queued: the winner owns
      // both halves, so this one must not touch the bytes. Whichever action
      // wins the race owns the final invalidate.
      invalidateStartPageWallpaper();
      return;
    }
    try {
      await writeAppearanceBlob(START_PAGE_WALLPAPER_KEY, args.blob);
    } catch (error) {
      // The store write is atomic per key, so a failed replacement leaves the
      // previous bytes intact - and leaving the row alone too keeps the pair
      // the user already had. Deleting the bytes here is what would strand
      // the row.
      invalidateStartPageWallpaper();
      throw error;
    }
    const current = useSettingsStore.getState().startPageWallpaper;
    useSettingsStore.getState().setStartPageWallpaper({
      style: current?.style ?? "dither",
      intensity: current?.intensity ?? DEFAULT_START_PAGE_WALLPAPER_INTENSITY,
      tintWithAccent: current?.tintWithAccent ?? true,
      name: args.name,
      curatedId: args.curatedId,
    });
    invalidateStartPageWallpaper();
  });
}

/**
 * Validates the chosen file, re-encodes it to the wallpaper budget, and
 * stores the bytes and the settings row together.
 */
export async function chooseStartPageWallpaper(
  file: File,
  signal: AbortSignal,
): Promise<void> {
  abortCuratedApply();
  const processed = await processStartPageWallpaperImage(file, signal);
  signal.throwIfAborted();
  await storeStartPageWallpaper({
    blob: processed.blob,
    name: file.name,
    curatedId: null,
    signal,
  });
}

/**
 * Downloads a curated wallpaper and stores it in the same one blob slot a
 * custom pick uses. Bytes already inside the stored budget are kept VERBATIM -
 * they were encoded for it when published, and re-encoding them would only
 * lose quality. The edge check reads the header dimensions
 * `validateAppearanceImage` already parsed, so the verbatim path never decodes
 * a bitmap.
 */
export async function applyCuratedStartPageWallpaper(
  entry: CuratedWallpaper,
): Promise<void> {
  curatedApply?.abort();
  const controller = new AbortController();
  curatedApply = controller;
  const signal = controller.signal;
  try {
    const downloaded = await downloadCuratedWallpaper(entry, signal);
    signal.throwIfAborted();
    const dimensions = await validateAppearanceImage(downloaded);
    signal.throwIfAborted();
    const blob =
      downloaded.size <= MAX_START_PAGE_WALLPAPER_BYTES &&
      Math.max(dimensions.width, dimensions.height) <=
        APPEARANCE_WALLPAPER_MAX_EDGE
        ? downloaded
        : (await processStartPageWallpaperImage(downloaded, signal)).blob;
    signal.throwIfAborted();
    await storeStartPageWallpaper({
      blob,
      name: entry.title,
      curatedId: entry.id,
      signal,
    });
    // An apply that lost the race must not report success. It may still have
    // committed - a store already past its ticket check finishes both halves
    // rather than strand bytes under the previous row - but the user's last
    // action was something else, so this one is not the setting to track.
    signal.throwIfAborted();
  } finally {
    if (curatedApply === controller) curatedApply = null;
  }
}

/** Clears both the settings row and the stored bytes. */
export async function removeStartPageWallpaper(): Promise<void> {
  abortCuratedApply();
  writeTicket += 1;
  // Cleared twice deliberately: now, so the panel updates even with a store
  // queued ahead, and again in the link, because a store already past its
  // ticket check writes its row after this point.
  useSettingsStore.getState().setStartPageWallpaper(null);
  return enqueueWrite(async () => {
    useSettingsStore.getState().setStartPageWallpaper(null);
    try {
      await removeAppearanceBlob(START_PAGE_WALLPAPER_KEY);
    } finally {
      invalidateStartPageWallpaper();
    }
  });
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
