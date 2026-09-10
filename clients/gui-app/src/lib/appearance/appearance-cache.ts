import { createStore, get, set, clear, del, type UseStore } from "idb-keyval";
import { PERSIST_PREFIX } from "@/lib/persist/keys";

// Keep the existing database and envelope so saved wallpapers survive the upgrade.
export const APPEARANCE_DB_NAME = `${PERSIST_PREFIX}:appearance`;
let cachedStore: UseStore | null = null;
let wipeGeneration = 0;

function appearanceStore(): UseStore {
  cachedStore ??= createStore(APPEARANCE_DB_NAME, "appearance");
  return cachedStore;
}

export function appearanceAssetKey(identity: string): string {
  return JSON.stringify(["global", identity]);
}

export async function readAppearanceBlob(
  identity: string,
): Promise<Blob | null> {
  const generation = wipeGeneration;
  if (generation > 0) return null;
  try {
    const entry: unknown = await get(
      `blob:${appearanceAssetKey(identity)}`,
      appearanceStore(),
    );
    return generation === wipeGeneration &&
      typeof entry === "object" &&
      entry !== null &&
      "value" in entry &&
      entry.value instanceof Blob
      ? entry.value
      : null;
  } catch {
    return null;
  }
}

export async function writeAppearanceBlob(
  identity: string,
  blob: Blob,
): Promise<void> {
  if (wipeGeneration > 0)
    throw new Error("Wallpaper storage is being cleared.");
  await set(
    `blob:${appearanceAssetKey(identity)}`,
    { value: blob },
    appearanceStore(),
  );
}

export async function removeAppearanceBlob(identity: string): Promise<void> {
  await del(`blob:${appearanceAssetKey(identity)}`, appearanceStore());
}

export async function clearAppearanceCache(): Promise<void> {
  wipeGeneration += 1;
  await clear(appearanceStore());
}
