import { useEffect, useSyncExternalStore } from "react";
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

/**
 * The last image a mounted reader resolved, tagged with the settings name
 * and blob revision it was read for. Switching hosts remounts the start
 * page; the hook's own state would otherwise begin at "no image" and the
 * wallpaper would blank until IndexedDB answered again. The tag is what
 * makes that reuse safe: a remount whose name or revision differs must not
 * paint the previous picture while the new bytes are still loading.
 */
let retainedImage: StartPageWallpaperImage = NO_WALLPAPER;
let retainedName: string | null = null;
let retainedVersion = 0;
let retainedContentKey: string | null = null;

const imageListeners = new Set<() => void>();

function subscribeImage(listener: () => void): () => void {
  imageListeners.add(listener);
  return () => {
    imageListeners.delete(listener);
  };
}

function emitImage(): void {
  for (const listener of imageListeners) listener();
}

function retainedImageMatches(name: string | null, version: number): boolean {
  return retainedName === name && retainedVersion === version;
}

function revokeObjectUrlAfterPaint(url: string): void {
  const retire = () => {
    if (retainedImage.url === url) return;
    URL.revokeObjectURL(url);
  };
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(retire, 0);
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(retire);
  });
}

function publishRetainedStartPageWallpaperImage(
  next: StartPageWallpaperImage,
  name: string | null,
  version: number,
  contentKey: string | null,
): void {
  const previous = retainedImage.url;
  const changed =
    previous !== next.url ||
    retainedName !== name ||
    retainedVersion !== version ||
    retainedContentKey !== contentKey;
  retainedImage = next;
  retainedName = name;
  retainedVersion = version;
  retainedContentKey = contentKey;
  if (previous !== null && previous !== next.url) {
    revokeObjectUrlAfterPaint(previous);
  }
  if (changed) emitImage();
}

function clearRetainedStartPageWallpaperImage(): void {
  publishRetainedStartPageWallpaperImage(NO_WALLPAPER, null, 0, null);
}

/**
 * One read at a time for a name and revision. A second mounted reader joins
 * it instead of minting another object URL; publishing that second URL used
 * to revoke the one the first reader was still showing.
 *
 * Bumped when a different identity starts, so a slow read cannot publish
 * over the wallpaper that superseded it.
 */
let readSerial = 0;
let inflightKey: string | null = null;
let mountedReaders = 0;

function wallpaperIdentityKey(name: string | null, version: number): string {
  return `${version}\0${name ?? ""}`;
}

async function blobContentKey(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `${blob.type}:${blob.size}:${hash >>> 0}`;
}

/**
 * Reads the stored bytes for this identity.
 *
 * A retained hit still re-reads. The revision counter is per window, so
 * another window can replace wallpaper.png without bumping it. The current
 * frame keeps the retained URL; a different blob publishes a new one.
 *
 * A second reader mounted at the same time joins the read already in
 * flight. A read left behind by the last unmount does not: the bytes may
 * have been replaced while nobody was mounted, and joining that read would
 * publish the old blob and then never look again.
 */
function ensureStartPageWallpaperRead(
  name: string | null,
  version: number,
): void {
  const key = wallpaperIdentityKey(name, version);
  if (inflightKey === key) return;
  const serial = ++readSerial;
  inflightKey = key;
  void readAppearanceBlob(START_PAGE_WALLPAPER_KEY)
    .catch(() => null)
    .then(async (blob) => {
      if (serial !== readSerial) return;
      if (blob === null) {
        publishRetainedStartPageWallpaperImage(
          NO_WALLPAPER,
          name,
          version,
          null,
        );
        return;
      }
      const contentKey = await blobContentKey(blob);
      if (serial !== readSerial) return;
      if (
        retainedImageMatches(name, version) &&
        retainedImage.url !== null &&
        retainedContentKey === contentKey
      ) {
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      publishRetainedStartPageWallpaperImage(
        { url: objectUrl, name },
        name,
        version,
        contentKey,
      );
    })
    .finally(() => {
      if (serial === readSerial) inflightKey = null;
    });
}

function mountWallpaperReader(): () => void {
  mountedReaders += 1;
  return () => {
    mountedReaders -= 1;
    if (mountedReaders > 0) return;
    mountedReaders = 0;
    readSerial += 1;
    inflightKey = null;
  };
}

/** Drops the retained object URL. Tests only — a live session keeps it. */
export function resetRetainedStartPageWallpaperImageForTests(): void {
  readSerial += 1;
  inflightKey = null;
  mountedReaders = 0;
  clearRetainedStartPageWallpaperImage();
}

function wallpaperSnapshot(
  name: string | null,
  version: number,
): StartPageWallpaperImage {
  return retainedImageMatches(name, version) ? retainedImage : NO_WALLPAPER;
}

export function useStartPageWallpaperImage(): StartPageWallpaperImage {
  const version = useSyncExternalStore(subscribe, readRevision, readRevision);
  const name = useSettingsStore(
    (state) => state.startPageWallpaper?.name ?? null,
  );
  // Reuse the retained image only when it is the wallpaper this mount is
  // reading. A different name or revision starts empty; painting the previous
  // picture there is the wrong image, not the host-switch flash.
  const image = useSyncExternalStore(
    subscribeImage,
    () => wallpaperSnapshot(name, version),
    () => wallpaperSnapshot(name, version),
  );
  useEffect(() => {
    const release = mountWallpaperReader();
    ensureStartPageWallpaperRead(name, version);
    return release;
  }, [version, name]);
  return image;
}
